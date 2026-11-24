# 写入进度为什么走 `/progress` 纯读段 + 全局一份记录器

Status: accepted

批量写是单次 `/apply` 往返、结果只在批尾回，确认框在飞拦关且零反馈时用户只能看见「卡住了」。这里把写入进度做成**真 tick 的遥测**：`/progress` 纯读段 + 全局一份写入进度记录器；界面轮询并按「action 相同且 ids 相交」认领写身份，认领不上就明说「排队中」。

## 背景

一次批量删除 / 恢复 / 彻底删除在服务端是**一条串行的写链**，整批结果只在批尾以逐条信封交回；这段时间里浏览器半既收不到中间结果，也被确认框的在飞拦关（ADR-0052）挡着关不掉窗。用户看到的是「点了删除、界面什么都不动」。而「假进度」是反目标：动画条、按预估步数走的百分比会在慢盘上骗人——所以进度必须由**真的动作点** tick 出来，读的一侧还必须能确认「这条进度是我的那趟写」，否则串行队列里别人的写会顶着你的身份显示。

## 决定

1. **`/progress` 是纯读段**（`purity: 'pure'`）：不进到达序链——写在飞时轮询也要立刻回，进链就等于被自己要观测的那趟写堵住。
2. **全局一份写入进度记录器**（`src/verbs/write-progress.ts` 的模块单例）：`begin` / `step` / `advance` / `finish` 各动自己那一格。它**不进 `CoreDeps`**——进度是遥测不是世界依赖；写动作在到达序链上串行，全局一份无歧义，宿主重启天然回 idle。
3. **每条（含失败条）完成 tick 一次**：`done` 与「已处理条数」同义，不许冒充「成功条数」；计数不许撑过总数；收尾后迟到的 tick 不许把记录复活。
4. **界面轮询 + 身份认领**：浏览器半以短周期轮询 `/progress`，按「action 相同且 ids 相交」认领写身份；认领不上显示排队中。身份是「这条进度是我的写」的唯一凭据，请求里的 `ids` 就是天然身份；`/empty` 请求没有 ids，界面冻结**发起清空那一刻**的在场行 id 快照（服务端的记录就是当时那些行），后续清单换版不改认领身份。**空集守卫**：认领名单为空集时交集判据失效，而同 action 在飞的那趟可能是本趟——「排队中：另一写入进行中…」这句断言无从成立、更不许冒领它的 k/N ⇒ 归「没认领到」，出 `null` 由调用方给兜底忙碌文案。轮询与认领住 `src/client/use-write-progress.ts` 的 `useWriteProgress`（单票在飞：在飞 tick 跳过不作废票，落地才放行下一拍；每票独立短超时，停止或卸载即 abort），进度行渲染住 `src/client/write-progress.tsx` 的 `WriteProgressLine`。

## 边界

- 进度不是第二本账：成败只由 `/apply` 的逐条信封交回，进度记录只反映「处理到第几条」，不携带结果。
- 步骤码只表达动作点，步骤码 → 动作点的唯一映射住记录器的头注；渲染文案归浏览器半。**没有动作点的码不上册**：`resuming` 就这样被收窄掉——冷 resume 归宿主（ADR-0008），插件侧没有可 tick 的动作点。
- `unarchive` 在服务端照报进度（`/apply` 的写动作统一 begin/finish），但**界面没有认领落点**：归档档不走确认框、无动作可挂轮询，这一格记录只为「另一趟写在飞」的排队判据存在。
- 已用秒数同时受服务端起点与本机在飞起点约束：服务端时钟落后时按本机时长封顶，超前时按本机时长推进，避免远端 Web 客户端显示巨值或冻住。
- `/empty` 也报进度（k/N 按回收站行 tick，失败行也算已处理）；`count` 是纯读、不出进度。

## 后果

- 契约两半同批长出一段：`src/shared/wire.ts` 的 `/progress` 段名、`WriteProgressWire` 与手写判形；`src/api/route-table.ts` 的纯读行。
- 五个写动作与清空驱动各插进 tick 点（`begin`/`step`/`advance`/`finish`；`count` 纯读不报、`unarchive` 只 begin/finish）：只加观测，不改任何步骤顺序、回滚与失败语义。
- 浏览器半多出轮询钩子与进度行两件（`use-write-progress.ts` / `write-progress.tsx`）：四张写确认框（单删 / 批量删除 / 回收站恢复与彻底删除 / 孤儿会话清理）与撤销横幅接上进度行，两张维护框只接 spinner + 兜底文案；文案键 zh/en 成对住 `src/client/copy.ts`；忙碌主按钮的 spinner 与关闭钮禁用档进 `src/client/ui/ui.css` 的自造清单。
- 进度轮询是每 300ms 一次的独立小读（2s 上限、单票在飞、停止即 abort）：不占用到达序链，也不跟自己的写在飞期抢同一座位。

## 被否方案

- **客户端分条发请求、自己数进度**：打散「同批已带走 = 幂等成功」的批语义（跨请求没人持有同批已带走集），一次批量变成 N 次往返与 N 个信封。
- **流式 / 分块响应回报进度**：`/apply` 的信封契约是批尾一次交回逐条信封（ADR-0053 的唯一落地面），流式等于给通道再长一个结果形状。
- **写 token 进 `/apply` body**：请求形状住 `wire.ts`，多加一格等于多改一处契约；`ids` 已是天然身份，token 没换来新事实。

锚点：`src/verbs/write-progress.ts` 的 `writeProgress` / `readWriteProgress` / `WriteProgressRecorder`；`src/shared/wire.ts` 的 `WriteProgressWire` / `WriteProgressAction` / `WriteProgressStep`；`src/api/route-table.ts` 的 `progress`；`tests/api.test.ts`；`src/client/use-write-progress.ts` 的 `useWriteProgress`。
