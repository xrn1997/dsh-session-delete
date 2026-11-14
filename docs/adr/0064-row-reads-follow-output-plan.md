# 行读数按输出计划读：批量面 / 逐行面 / 合计三段，逐行读有界

Status: accepted

行读数装配原先把「批量读面 + 两处逐行读 + 合计」挤在一个函数里，归档详情先读全部孩子再切片，且合计依赖全量行事实；结果是显示 200 行也要为上千行付逐行读。把它拆成三层：批量读面只发批量调用，逐行面只服务会画出来的行并共用一份有界并发预算，合计按 id 集合算；归档详情先算 limit 再投影。之所以拆：只有把「合计要什么」和「行要什么」分开，输出计划才可能同时满足两个约束。

## 背景

修改前 `src/trash/session-rows.ts` 的 `projectSessionRows` 一次做三件事：三个批量读面（`titleSnapshots` / 活动 / 持久化大小）、两处逐行读（旧宿主标题回退 `titleOf`、子会话 label `labelOf`）、按行装配。两个调用方里，归档清单确实要全部行；归档详情的子会话段只画前 N 条，却同样走整批投影：

- 归档详情把全部孩子的行事实都算出来，再 `facts.slice(0, limit)`；合计 `sizeTotals(facts)` 又依赖全量 facts，所以「只读画出来的行」在旧接口上根本表达不出来。
- 两处逐行读都没有并发上限：两百行一屏、清单一档上千行，会把上千个 `labelOf` / 旧宿主 `titleOf` 同时挂起。
- 归档详情对所有孩子读 `isArchived`，显示外的孩子一条也用不上。

## 决定

1. **三层接口，住在 `src/trash/session-rows.ts`。** `readRowSurfaces(deps, ids, policy)` 只做批量面（标题批量、活动整表、大小整表；ids 是调用方要显示的行）；`projectRowFacts(deps, surfaces, targets)` 只做逐行面（旧宿主标题回退与 label），保序、同长、缺席不落键；`sizeTotalsForIds(ids, sizes)` 按 id 集合算合计与缺席计数。原 `projectSessionRows` / `sizeTotals` 保留为兼容包装，归档清单不动。
2. **逐行读有界并发。** label 与旧宿主标题回退共用同一个内部 `mapLimit`，并发预算 `ROW_READ_CONCURRENCY = 8`：模块常量，不做用户可调项。首错原样抛，失败后不再领新活；两路读的并集也被 8 封顶，不是每路各 8。
3. **按输出计划读。** 归档详情先算 `limit`（`SUBAGENT_SUMMARY_LIMIT` 或调用方 limits），`displayed = kids.slice(0, limit)`；批量面只传 displayed 的 id，逐行面只投影 displayed，`isArchived` 只读 displayed。显示外的孩子零逐行读。
4. **合计不跟输出计划走。** 摘要的 `subagentsSizeBytes` 报的是全部孩子的和：`sizeTotalsForIds(kids 全部 id, surfaces.sizes)`；大小缺席计数同样按全部孩子算，wire 的「并非全部孩子都缺大小才给合计」口径不变。
5. **语义零变化。** 行内容与顺序、wire 形状、`sizeFailure` 两档策略、缺席格不落键、截断总数、label 为空不落键、旧宿主标题回退链全部与旧实现逐项等价；只减少读的数量。

## 边界

- 归档清单仍投影全部已归档行（没有输出计划可依），收益来自有界并发；清单行数上限不在这里改。
- 批次批量面调用数不变（三个，调用方传哪些 id 由输出计划决定）；整表活动/大小仍整表读。
- 整本会话详情折叠器里的其它并行读（`Promise.all` 的块级 fan-out）不在本决定范围。
- 宿主没有批量 label / 批量旧标题的面；逐行读的粒度仍是一行一次。
- `ROW_READ_CONCURRENCY` 只约束逐行面；批量面一次一发。

## 被否方案

- **再加一个端口方法 `labelSnapshots`（批量 label）**：宿主没有这个面；在当前插件里包一层只是把同一个并发窗挪进 adapter，不减少跨进程请求数，反而多一份形状与降级语义。
- **给用户加并发旋钮**：内部实现细节不该进设置页；8 是「小批并行、别打爆宿主」的固定预算。
- **用条数上限砍归档清单行**：行是用户要看的清单，不是摘要；为性能砍行会破坏「归档集 ∩ 语料」的完整投影。
- **逐行串行读**：简单但把两百行的墙钟拖到秒级；有界并行在同样预算下把尾延迟压到八分之一量级。
- **沿用「先全量投影再切片」**：合计依赖全量 facts 是旧接口的结构性约束，不拆接口就无法让逐行读只服务输出行——这也是这次必须动接口的原因。
- **把合计改成只加显示行**：会改变摘要语义（报的应是全部孩子的和），是行为变化，不是性能优化。

## 锚点

锚点：`src/trash/session-rows.ts`（`ROW_READ_CONCURRENCY` / `readRowSurfaces` / `projectRowFacts` / `sizeTotalsForIds` / `projectSessionRows`）；`src/trash/archive-detail.ts`（`readArchiveSubagents`）；`src/api/archive-rows.ts`（`assembleArchiveRows`）；`src/trash/detail.ts`（`SUBAGENT_SUMMARY_LIMIT`）；`tests/session-rows.test.ts`；`tests/archive-detail.test.ts`；`docs/architecture.md` §4；ADR-0055（子会话摘要上限）；ADR-0060（归档档的详情读路边界的另一面）。