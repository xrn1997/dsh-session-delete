# ADR-0036 — 主视图重开等摘要用 snapshot subscribe，不再轮询

Status: accepted

ADR-0008 的客户端段要求「撤销恢复成功后，等客户端摘要表出现该会话再重开」。当时的实现是每 100ms 轮询一次 `sessions.list.getSnapshot()`，最多 2 秒。现在改成：**订阅宿主快照 store**，出现即开；只在给不出 `subscribe` 的旧 store 上放弃等待（行仍在列表里，用户可点），不再轮询。唯一的 timer 是 2 秒放弃边界，归 pending 重开的清理函数与 `ctx.effect` 所有。

## 背景

轮询绕开了 store 自己的通知机制：摘要落地时 `main-view` 可能还在睡，最多晚 100ms 才看见；一次等待最多 20 个 `setTimeout`，插件卸载或新一次删除/恢复只把 `ticket.current` 置假，旧 timer 仍会跑到 2 秒；`resetMainView` 也清不掉它们。DSH 的浏览器 store 是 snapshot store（`getSnapshot` + `subscribe`），订阅是现成的增量通道。

2 秒本身是产品决定（给宿主 `api-session/added` 到客户端摘要落地留一拍），不是必须轮询的理由。

## 决定

1. **订阅优先**：`src/client/main-view.ts` 的 `UiWorkspaceLike.sessions.list` 窄镜像补 `subscribe(listener) => unsubscribe`；`openWhenListed` 先查一次 `getSnapshot`，没有就订阅，回调里再查，出现且票仍当前、当前会话仍是目标（或空）时 `openSession`。
2. **一个 2 秒放弃边界**：订阅后起一个 `setTimeout(2000)`；不是轮询。到点、打开、失焦、被新动作作废、插件卸载都走同一个 cleanup：清 timer、退订、清句柄里的 pending 引用（`src/client/pending-open.ts`）。
3. **pending 归属**：重开等待收成一个可取消句柄，只保留最新一次等待；`afterDelete` / `afterRestore` / `resetMainView` 都只调 `pendingOpen.cancel()`，不再手工同步票与 cleanup 两套取消。
4. **插件卸载清理**：`bindMainView` 在 ctx 上挂一个 `ctx.effect`，卸载时 `pendingOpen.cancel()`、清 `closedByUs`。测试用的窄 ctx 没有 `effect` 时安静跳过。
5. **没有 `subscribe` 的旧 store**：不轮询、不猜；直接放弃这次重开（会话行仍在清单里，用户可手动点开）。这是兼容下界，不是新禁用态。
6. **选择面仍按需读**：`canTakeFocus` 在打开那一刻读 `selection.getSnapshot()`，不订阅选择面；用户已切走就不抢焦点，并结束等待。

## 边界

- 不改变 ADR-0008 的主视图收尾语义（删除关当前、恢复只重开自己关过的、面板恢复只 forget 不重开）。
- 2 秒上限仍保留；只是从「轮询 20 次」变成一个放弃 timer。
- 不订阅 `selection`：焦点判断只在打开那一拍做；订阅它会把每次选择变化都叫醒 pending 逻辑，收益不抵成本。
- 旧 store 没有 `subscribe` 时宁可不开；不恢复轮询作为 fallback（那会把本 ADR 的收益又退回去）。

## 后果

- `main-view` 不再有 `attempts` 与 100ms 轮询；等待期间由 store 通知驱动，摘要落地那一拍即可打开。
- 一次等待只占一个 timer、一个订阅；插件卸载/新动作/重置都只调一次 `cancel()`，退订与清 timer 在句柄里收口。
- 测试从「推进 100ms 看轮询」改成「fake store 的 `notify`」；新增「2 秒放弃后退订」「没有 subscribe 不轮询」用例。
- `docs/architecture.md` §4 的 `main-view` 行补订阅来源；ADR-0008 的客户端段只加一句指向本文，不翻案。

## 被否掉的替代

- **保留轮询**：绕开 store 通知、留下多个 timer，且插件卸载清不干净。
- **订阅 `api-session/added` 事件**：那是宿主事件流；客户端摘要表才是 `openSession` 的目标判据，直接订阅 store 更近、更少一层。
- **不设 2 秒上限**：宿主迟迟不落地时会留一个永久订阅；放弃边界是必要的。
- **旧 store 退回轮询**：兼容分支会把本 ADR 要消灭的行为保留一半；宁可这次不重开。

锚点：`src/client/main-view.ts`；`src/client/pending-open.ts`；`src/client/context.ts`；`tests/client/main-view.test.ts`；`tests/client/pending-open.test.ts`；`docs/architecture.md` §4；ADR-0008。
