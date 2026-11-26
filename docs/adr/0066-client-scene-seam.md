# 浏览器半的跨槽位现场收成可实例化的场景，默认实例只为兼容兜底

Status: superseded by 0067

浏览器半有九份跨槽位现场（回收站 / 归档修订台、首帧快照与详情账本、撤销通知台、主视图收尾、宿主行登记、批量选中集、两个确认框的请求现场），interface 长得像纯函数、实现是模块级可变单例：调用方必须知道次序（`noteSelection` 没有快照时静默、`reloadSucceeded` 按上一份清单修剪），测试只能靠一枚全局复位口（19 个文件 / 50 次）。决定把它们聚成**可实例化的场景**：注册面创建一份、各贡献经 Provider 读同一实例，测试可以各造一份；自由函数导出保留为默认实例的薄委托，旧测试的调用面不变（`write-seats.test` 只把四枚替身桩换成 `importOriginal` 展开）。

## 背景

这些现场的共同点是「跨槽位」：宿主把它们分到互不相邻的槽位（`shell.overlay` 的确认框、`main` 的面板、会话菜单行、设置页卡），槽位组件各自挂载/卸载，没有共同 React 父级，所以历史上只能放模块级。放模块级之后：

- 同一件事的写者分散（快照被查询、控制器、详情 reader、写入座位各写一格），排序不变量只能靠调用方纪律与注释；
- 测试无法造两份互不串味的现场，只能在每个用例前调 `resetClientState()` 把九份一起清；替身测试还得给复位册补空实现（`write-seats.test` 为 `trash-store` / `main-view` 各补一枚 `reset` 空函数）；
- 新增一份现场要同时改模块、复位册与替身。

## 决定

1. **新增 `src/client/scene.ts`：`ClientScene` 聚合九份现场 + 一份 `reset()`；`createClientScene()` 每次调用造一套全新实例。** 每个现场模块改成「工厂 + 兼容自由函数」：`createXScene()` 返回原操作面（含本模块 `reset()`），原自由函数/hook 保留为默认实例的薄委托。
2. **默认场景懒建，Provider 负责下发实例。** `getDefaultClientScene()` 在第一次读写现场时创建（`scene.ts` 与九个模块互相 import，模块顶层不调工厂，避免 ESM 环的 TDZ）；`ClientSceneProvider` / `useClientScene()` 把实例交给每个贡献的子树；无 Provider 时回退默认实例。`installClientScene()` 在注册面把新造的一份装成默认（已有默认时沿用，兼容旧测试「先摆现场再 `apply`」的顺序）。
3. **生产注册面创建一份实例，装成默认并包住贡献表里的每个槽位贡献。** 宿主各槽位是独立 React 树，Provider 只做「同一份实例进每棵树」；跨槽位共享靠实例本身，不靠树。仍是自由函数的旧调用点（`write-seats` 的收尾、事件处理器、`main-view` 的绑定、清单查询对首帧快照的读写、撤销台的发布 / 熄灭）命中的也是默认实例——**没有第二份账**。菜单两行与图标的注册有双轨协商、不经 Provider，读的同样是默认实例（生产即同一份账）。
4. **复位收成一条**：`reset-client-state.ts` 的 `resetClientState()` 只调 `resetDefaultClientScene()`；`ClientScene.reset()` 是八份一起回初值的唯一实现。`write-seats.test` 不再需要为复位册补 `reset` 空实现。
5. **`write-seats` 与事件路径本轮不改成显式 scene 参数。** 它们的收尾面被 `write-seats.test` 用 673 行 `vi.mock` 与顺序断言注入，改成参数要牵动整套测试；生产场景安装为默认实例后，自由函数与 Provider 组件已是同一份账，行为等价。**按 Provider 树严格隔离命令式写**是已知边界，留待将来需要时再补（见「边界」）。

## 边界

- 九份现场的**判据、时序、晚到归属、文案、DOM 零变化**；ADR-0018（撤销台与 Toast 分家）、ADR-0048（首帧快照的内容与失败语义）、ADR-0056（写闸落地面）的可观察规则一概不动。
- 每个现场模块仍拥有自己的语义与工厂；scene 只拥有「聚成一份实例 + 一处 reset」，不重新定义任何判据。
- ADR-0048 正文写的「模块级」按本篇读作「注册面实例（默认实例兜底）」：仍是进程内一份、卸载不丢、重启即无、不订阅、不持久化；变的只是存放形状，不是快照内容、时机与失败语义。
- 默认实例是**兼容与测试兜底**，不是第二份生产账：生产激活时安装的就是注册面那一份，自由函数与 Provider 命中同一实例。
- Provider 只下发实例，不引入新的运行期状态源；槽位之间的共享仍靠同一个实例，不靠共同父级。
- **已知边界**：在非默认实例的 Provider 树里，组件自己的命令式写（`write-seats` 的结算、`requestDelete` / `togglePick` / `enterSelection` 等事件路径、`use-trash-query` 对首帧快照的读写、撤销台的发布 / 熄灭）仍命中默认实例；菜单两行与图标不经 Provider，也总是读默认实例。生产只有一份实例，所以不可观察。若将来需要「每棵树严格隔离」，再把上述调用点改成显式 scene 参数。

## 后果

- 测试可以 `createClientScene()` 各造一份互不串味的现场（新增 `tests/client/scene.test.ts` 钉两份实例互不共享、Provider 下发、默认回退）；旧测试的自由函数 + `resetClientState()` 语义不变。
- 复位册从「逐个 import 九个 reset」退化成一条 `resetDefaultClientScene()`；新增一份现场只改 `scene.ts` 与它的模块，不再改复位册与替身的复位桩。
- 生产与测试共用同一套现场构造函数：`scene.ts` 是唯一知道「一套现场有哪些」的地方。

## 被否方案

- **保留模块级单例、只把复位口收成一条**：内存形状没变，测试仍不能造第二份现场，排序不变量仍住在调用方。
- **把九份现场全部改成显式 scene 参数、穿透 write-seats 与事件路径**：行为等价，但要重写 673 行顺序断言的替身注入；本轮按「默认实例即生产实例」先落地，严格隔离留作边界。
- **把现场挂到每个槽位自己的 React 树 / 各自 Context**：跨槽位共享直接坏掉（撤销台、确认框请求、行登记本来就跨树）。
- **引入全局事件总线或依赖注入容器**：九份现场是编译期已知的一组，不是插件生态；静态聚合 + 一个 Provider 已够。
- **把默认实例也删掉、所有调用点强制传 scene**：21 个旧测试与事件处理器要全改，收益只是去掉兼容层，不解决任何行为问题。

锚点：`src/client/scene.ts`（`ClientScene` / `createClientScene` / `ClientSceneProvider` / `useClientScene` / `installClientScene`）；八个现场模块的工厂与兼容自由函数（`src/client/trash-store.ts` 的 `createTrashRevisionScene`、`src/client/archive-store.ts` 的 `createArchiveRevisionScene`、`src/client/trash-snapshot.ts` 的 `createTrashSnapshotScene`、`src/client/undo-notices.ts` 的 `createUndoNoticeScene`、`src/client/main-view.ts` 的 `createMainViewScene`、`src/client/host-rows.ts` 的 `createHostRowsScene`、`src/client/batch-selection-store.ts` 的 `createBatchSelectionScene`、`src/client/delete-action.tsx` 的 `createDeleteActionScene`）；`src/client/index.tsx`（注册面安装场景与 Provider）；`tests/client/scene.test.ts`；`docs/architecture.md` §3 / §4.3；`CONTEXT.md` 的「场景」；ADR-0018、ADR-0048、ADR-0056（语义不动）。
