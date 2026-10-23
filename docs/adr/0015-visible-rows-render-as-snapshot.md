# 宿主可见行的渲染读数走快照订阅，DOM 观察留在适配器

Status: accepted

多选浮条要显示「当前可见、可勾选的会话行」，而这个事实源在组件树之外（宿主的 DOM）：组件各自在渲染期查一遍，同一帧看到什么就取决于副作用顺序，而且 DOM 变了也不会触发重渲染。`src/client/host-rows.ts` 把这条读面收成 `useSyncExternalStore` 的快照订阅——`MutationObserver` 与行登记都留在适配器里，只标脏并通告订阅者；渲染侧读缓存快照，事件侧仍当场读。

## 决定

1. 渲染侧只读缓存快照：脏了才重读 DOM，干净时回同一个引用（React 的 snapshot 契约要求）。
2. 宿主行的去留只看 `data-row-key` 节点（增删、该属性落定），正文文本变化不算——标题只认 `registerHostRowInfo` 登记过的值，且只在标题／运行态**真的变了**时才标脏。
3. 观察者生命周期跟着订阅数走：第一个订阅者到来才接上，最后一个走时断开；从「无人订阅」重新挂上来的那一拍必须重读（无观察期间外部源可能已经变过），此后一律由 `invalidate` 负责标脏。
4. 多选模式外不订阅、不读 DOM，回同一颗空表：浮条是 `shell.overlay` 的常驻槽位，模式外照常订阅等于让 body 上每一次变更都白叫醒它。
5. 事件路径（点「全选」那一刻的页面）用当场读，与快照读同源不同拍；勾选集合本身仍归 `src/client/batch-selection-store.ts`。

## 边界

- 不改整行点击守卫抢 `document` 捕获阶段的做法：宿主会话行自己带 `onClick`，第三方没有「别切会话」的官方开关。
- 本适配器不拥有选择变更，只回答「页面上现在有哪些行」与「在这行点一下算不算选中」。
- 订阅骨架住 `src/client/store.ts` 的 `createLazyStore`，DOM 读法与观察者生命周期住 `src/client/host-rows.ts`——骨架不许反过来认识 DOM。

## 被否掉的替代

- **每个组件各自在渲染期 `querySelectorAll`**：同帧读数取决于副作用顺序，且 DOM 变化不触发重渲染，全选判定会停在旧页面上。
- **把观察器塞进 `createLazyStore`**：通用骨架被 DOM 这个 implementation 污染，不依赖 DOM 的懒读现场也跟着付观察成本。
- **模式外也订阅**：行列表只随多选态存在，模式外读到什么都是白读，还要为白读的变更重渲染。
- **定时轮询 DOM**：给「不叫醒」再叠一层恒定成本，且两次轮询之间界面是旧的。
- **由 `batch-selection-store` 在勾选变化时顺带重读行**：勾选集合管的是用户选了谁，管不了宿主侧栏里此刻渲染了什么。

锚点：`src/client/host-rows.ts` 的 `useVisibleSelectableRows`；`src/client/store.ts` 的 `createLazyStore`；`src/client/batch-bar.tsx`；`tests/client/host-rows.test.ts`；`docs/architecture.md` §4；ADR-0013。
