# ADR-0034 — 批量选择的可见行从 slot 注册读，DOM 只留点击守卫

Status: accepted

批量浮条要知道「页面上此刻有哪些可勾选的会话行」。ADR-0015 让 `src/client/host-rows.ts` 用 `MutationObserver` + `data-row-key` 扫描宿主 DOM 来回答；这违反 DSH 官方插件实践（框架驱动、插件不自己 rescan DOM），也把宿主行结构当成事实源。现在改成：**每个会话行的插件槽位组件在挂载时登记自己、卸载时注销**，批量浮条订阅这份登记；DOM 只剩一处——整行点击守卫用它把指针下的 `data-row-key` 映射成会话 id，不再用于枚举可见行。

本文取代 ADR-0015：可见行的数据源从 DOM 观察换成槽位登记；ADR-0015 的渲染快照订阅骨架（`createLazyStore`）继续沿用。

## 背景

宿主按行渲染本插件的 `sidebar.session.row.leading` / `sidebar.workspaces.session.row.action` 槽位；组件只在行可见时挂载。行尾槽位的 props 带 `sessionId` 与 `displayTitle`，行首槽位只给 `sessionId`；标题与运行态都从 root hook 的 `useSessions` 读。用挂载/卸载表达「这一行现在可见」是槽位契约本身，不需要再观察 DOM。当前 `host-rows.ts` 的 `MutationObserver` 与 `querySelectorAll` 既绕开增量机制，又让排序、标题、live 三件事各有一份 DOM 读数。

整行点击守卫没有官方替身：宿主会话行自带 `onClick`（打开会话），第三方没有「多选模式下别切会话」的开关。所以在拿到行选择 API 之前，守卫仍要读一次 `data-row-key`；这是**受约束偏离**，不是本 ADR 要消灭的 DOM 枚举。

## 决定

1. **可见行来自槽位登记**：`BatchPickCheckbox` / `BatchPickButton`（槽位宿主 `PickLeadingRow` / `PickRow`）这类每行挂载的组件在 `useEffect` 里向一个模块级 registry 登记 `{ sessionId, title, live }`，卸载注销；同一 id 的多个槽位按引用计数去重，最后一个注销才移除。标题/运行态变化只更新登记值，不重登记，避免把这一行挪到登记序末尾。批量浮条与「全选」订阅 registry，不再读 DOM 行列表。
2. **顺序取登记顺序**：宿主按列表顺序挂载行；registry 保留首次登记顺序作为可见顺序。宿主将来虚拟化时，挂载集合就是可见集合，语义不变。
3. **删除 DOM 行快照**：`host-rows.ts` 不再有 `MutationObserver`、`querySelectorAll` 与按 `data-row-key` 建表；只保留可见行 registry 与按 id 的行查找。整行点击守卫、全选与全选判定住 `batch-pick.ts`。
4. **点击守卫只做映射**：守卫在 `document` 捕获阶段拿到点击目标，`closest('[data-row-key^="session:"]')` 取 id，再用 registry 查这一行是否可勾选；registry 里没有的 id 不选中。它不枚举行、不维护行列表。
5. **无槽位组件的行不出现**：如果某个宿主代次不渲染这两个槽位，批量选择只覆盖能挂上组件的行；入口仍在，只是范围变小——这是能力探测的自然结果，不另造禁用态。

## 边界

- 点击守卫仍是 DOM 依赖：宿主改掉 `data-row-key` 或行的点击结构，「点整行选中」会失效；行首/行尾勾选框仍可用。守卫住 `src/client/batch-pick.ts`，`tests/client/host-rows.test.ts` 钉住当前形状，宿主换代先复核。
- 不改变选择集合语义（`src/client/batch-selection-store.ts`）与确认框/撤销的现有路径。
- 不引入新槽位：只用已经注册的 `sidebar.session.row.leading` 与 `sidebar.workspaces.session.row.action`。
- 上游请求：给第三方一个「行选择/多选」的官方 API；拿到后删掉守卫里的最后一次 DOM 读取。

## 后果

- `src/client/host-rows.ts` 从「DOM 观察 + 行登记」缩成「可见行 registry + 行查找」；`useVisibleSelectableRows` 的订阅骨架保留，数据源换成 registry。
- 批量浮条的「已选 / 可见」计数与全选不再依赖 MutationObserver；DOM 变更不会触发整条浮条重算。
- 宿主行的标题/live 从槽位 props 来，不再有第二份 DOM 读数。
- 受约束偏离只剩一处，且写在 `batch-pick.ts` 头注与本文边界里；不会随下一次重构再长出第二处。

## 被否掉的替代

- **继续用 MutationObserver 快照**：违反官方实践，且宿主行结构一变就同时坏掉可见行、标题与 live 三件事。
- **每个组件在渲染期各自 `querySelectorAll`**：同帧读数取决于副作用顺序，DOM 变了也不重渲染（ADR-0015 已否）。
- **给守卫也套一层「官方 API」想象**：当前宿主没有这个 API；先把它记录成受约束偏离，比假装没有 DOM 更诚实。

锚点：`src/client/host-rows.ts`；`src/client/batch-pick.ts`；`src/client/batch-select.tsx`；`src/client/batch-selection-store.ts`；`src/client/batch-bar.tsx`；`src/client/use-list-selection.ts`；`tests/client/host-rows.test.ts`；`docs/ui-spec.md`；ADR-0015。
