# ADR-0029 — 子会话的查看入口住详情不住清单

Status: superseded by 0055

回收站清单把子条目折进父行（组语义，ADR-0001），孩子没有自己的清单行；查看孩子正文的入口放在父详情的「子会话」段，点进去是离清单的单级孩子视图——孩子没有清单行可配清册事实，清单选中、组动作与键盘/多选语义也不必为此重定义。

## 背景

组语义的判据是「接得住孩子的只有组根」：一次删除带进来的孩子折进父行，清单只摆组根（ADR-0001）。但永久删除按整组释放（父 + 折进来的孩子 + 盘上后代），用户删之前要能核对每个孩子到底发生了什么。详情已是对话全量块（ADR-0026），当时把子会话详情明确留给 issue #7——清单看不见孩子，详情那时也没有往下走的入口。

契约侧还有一件事实：详情的线上形状原本「只发日志里读出来的那几件」，清册字段按 `entryId` 与客户端手上那份清单配对。孩子没有清单行可配，它的清册事实（标题、大小、删除时间）只能随详情过线。

## 决定

1. **入口住详情、不住清单**：父详情的会话信息后有「子会话」段（确有折进这一条的孩子时），段标题带已列条数与这些孩子的清册大小合计（超条数闸时另标总数，见第 2 条），逐条列标题/大小/删除时间、可点；点一条详情切到该子会话，同一套会话信息 + 正文 + 分页。清单不长孩子行。这一段的用途是**删前核对**（永久删除按整组释放），不是导航装饰。
2. **孩子身份随 `TrashDetailWire.subagents` 过线，复用 `TrashEntryWire`**：缺席 = 没有孩子，不是空数组。这是详情线上唯一带清册事实的一格（`src/client/remote.ts` 头注的例外）；投影住 `src/trash/entry.ts` 的 `entryWire`（`/list` 的 `toWire` 与详情共用同一份显式字面量），只搬清册里真有的事实、不带只读数。摘要只取**折进这一条**的孩子（折的判据复用 `src/trash/groups.ts` 的 `visibleGroups`）；条数过 `src/trash/detail.ts` 的 `SUBAGENT_SUMMARY_LIMIT` 闸，超出只列前 N 条并让 `subagentsTotal` 过线。孩子的详情仍按它自己的 `entryId` 走同一个 `POST /detail`（pure/raw），缓存、在飞与分页和选中行共用一条读路。
3. **孩子视图是离清单的单级导航态**：`src/client/use-trash-panel-controller.ts` 的 `childView` 只持一个槽位，不叠导航栈；`selectedId` 与组语义不动，返回回到清单选中那条的详情，点清单行即收掉孩子视图。组动作（恢复/彻底删除按整组）不因孩子视图改变——它只是看，不是新的动作单位。

## 不做的事

- 清单不长孩子行，不改清单的 ARIA / 键盘 / 多选语义；`TrashRowWire` 不带孩子清单。
- 不做多级导航栈与面包屑：孩子视图单槽，返回回清单选中那条。
- **孩子视图里也不再往下开一层**：段只在详情主体是清单选中那条时画。正常删除把整组成员都记到组根（`src/verbs/delete-session.ts`），孩子下面本就没有下一代；真出现更深一代（老清册、手工搬进回收站）时那一行接不住、自己占清单行（`src/trash/groups.ts`），走清单可达。摘要也只列折进这一条的孩子，不把已在清单各有行的孙辈再抄一份——那正是这里否掉的「双入口」。在这里再开一层还会造出第二套导航路径，并让那颗「返回父会话」指着孙辈说话——它回的是清单选中那条，不是中间那一层。
- 不新增段名：孩子的详情复用 `/detail`，不开 `/children`。
- 不改删除 / 恢复 / 永久删除的动作面：孩子视图不是动作单位。

## 后果

- 详情线上多两格可选：`subagents`（孩子摘要）与只在截断时出线的 `subagentsTotal`，是「清册字段按 entryId 配对」的唯一例外；界面不拿空数组冒充缺席。
- 详情主体可以是孩子：分页、失败与重试都跟着主体走。孩子视图的清场、unknown 与返回/Esc 次序住 `docs/ui-spec.md` 状态⑥与键盘节；词汇「孩子视图」住 `CONTEXT.md`。

## 被否掉的替代

- **清单行展开子行**：清单的 ARIA 模式（时为 listbox，后按 ADR-0028 改 grid）、键盘走环与多选语义都要为子行重定义，且与「子行折进父行」的组语义正面摩擦。
- **双入口（清单子行 + 详情段）**：两套导航语义养两份，孩子视图会有两个家；YAGNI。
- **摘要放 `TrashRowWire`**：入口在详情，`/list` 每行白背一份孩子清单，读放大且多数行用不上。
- **新开 `/children` 段**：raw 清册行里现成的事实（`parentEntryId` 指向谁）不值一段新契约面；复用 `/detail` 与 `TrashEntryWire` 就够。

锚点：`docs/ui-spec.md` §2（状态⑥）与 §3（键盘）；`src/client/use-trash-panel-controller.ts`（`childView`）；`src/shared/wire.ts`（`TrashDetailWire.subagents` / `subagentsTotal`）；`src/trash/entry.ts`（`entryWire`）；`src/trash/detail.ts`（`SUBAGENT_SUMMARY_LIMIT`）；`src/trash/groups.ts`（折进判据）；`src/client/trash-detail.tsx`；`tests/client/use-trash-panel-controller.test.tsx`；ADR-0001（组语义）；ADR-0026（详情正文）。
