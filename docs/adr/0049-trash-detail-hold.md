# 换条目时保持上一条已就绪的详情

Status: accepted

清单里换到一条还没读过的条目时，详情先塌成骨架，等于在切换路径上又排了一次版面。决定在新详情落地前继续画上一条已就绪的详情，正文不可交互并标 `aria-busy`；骨架只留给没有上一条可保持的首次读数。

## 背景

一条会话的详情读数在本机通常百来毫秒，但再快也够用户看见一帧内容形状的骨架；长会话冷读更久，骨架还会把滚动位置与正文高度一起换掉。宿主对同类问题的做法是让旧内容留到新数据落地（目录选择器、文档预览都是这个姿势），而不是把空窗做短或加淡出。删除前的审阅是逐条比对：A 的正文还在屏上时点 B，最不容易丢上下文。

「保持」只服务清单条目之间的切换。孩子视图的返回键语义挂在 `childView` 上：若保持父详情，那颗「返回父会话」会指向错误的一层，导航面串台比闪一下更糟。

## 决定

1. **保持上一条已就绪的顶层详情。** 条件是：新主体还没读过、上一条详情已就绪、上一条是清单选中那条且仍在当前清单里。整帧（标题、正文、滚动位置与右缘提问轨）仍是上一条；正文与轨都 `inert`，正文另标 `aria-busy`，不能把 A 的分页或子会话入口读到 B 上。提问轨跟着顶住但整条禁用，换到新详情才恢复。
2. **提示只在慢读时出现。** 保持超过 300ms 才在标题排出一句「正在读这条会话…」；本地读数通常在这之前落地，用户看不到任何字样。提示不换行高，不把标题挤走。
3. **新详情到了整帧换掉，失败换该条的失败块。** 一条读失败不丢掉上一条已就绪的详情：下一条切换仍由它顶住，骨架只在从来没有可保持的上一条时出现。失败态属于失败的那一条，不回溯污染已经画过的详情。
4. **孩子视图不保持。** 它的首次打开仍走读数中骨架，靠子会话行的意图预取减少冷读（ADR-0051）；hold 不跨导航层级。

## 边界

- 不做整块 crossfade / fade-out：淡出要保留旧节点，且遮不住塌陷，只会把空窗拉长。
- 不把保持扩展到孩子视图；不做按条目的滚动位置恢复（归 ADR-0050 的回顶判据）。
- 保持不是「显示旧数据」：失败的那一条最终仍落失败块，不会拿上一条冒充它。
- 几何与自动选中归 ADR-0050；首帧快照归 ADR-0048。

## 被否方案

- **每次切换都画骨架**：读数再快也会露一帧；用户看到的是版面塌陷，不是「正在加载」。
- **整块淡出再淡入**：保留旧节点的成本与真实布局变化不匹配，空窗反而更长。
- **hold 也管孩子视图**：返回键与 `childView` 绑定，保持父/子详情会让「返回父会话」指向错误的一层。
- **失败后继续用上一条顶位**：失败条目会永远看不到自己的失败块，重试也无从下手；保持只服务「新详情还没到」的那一段。

锚点：`src/client/use-detail-reader.ts` 的 `DetailState` 的 `holding` / `useDetailReader`（`detail` / `ensure`）；`src/client/use-trash-detail-reader.ts` 的 `useTrashDetailReader`；`src/client/use-detail-rail.ts` 的 `railState` / `disabled`；`src/client/prompt-rail.tsx` 的 `disabled`；`src/client/use-prompt-rail.ts` 的 `disabled`；`docs/ui-spec.md` §2 ⑥；`CONTEXT.md` 的「详情保持」；`tests/client/prompt-rail.test.tsx`；`tests/client/use-prompt-rail.test.tsx`；`tests/client/trash-panel.test.tsx`；`tests/client/trash-detail.test.tsx` 的「详情保持」；`tests/client/use-trash-detail-reader.test.tsx` 的「保持（holding）」；`tests/client/use-trash-panel-controller.test.tsx` 的「详情保持」。相关 ADR-0048、ADR-0050、ADR-0051、ADR-0057。
