## 1. 采用的错误体系

该仓库为 DeepSeek Harness 的「会话删除」插件，错误处理围绕三层契约展开：

- **进程内失败**：`VerbError extends Error`（`src/verbs/errors.ts`），携带 `code`、可选 `details`、可选 `cause`。
- **跨端失败信封**：`RemoteFailure = { code, message, details? }`（`src/shared/wire.ts`），与宿主官方 `rpcErrorSchema` 对齐，浏览器半通过 JSON 传输。
- **线上信封判别**：`isDSHRemoteError(value)` 通过标记位 `isDSHRemoteError === true` 识别（不依赖 `instanceof`，以兼容跨 realm / 跨 bundle）。

所有错误码集中在 `shared/wire.ts` 中定义，由 Node 半与浏览器半共享，避免两端各写字面量。错误码分为两类：

- **五个动词码**：`live`、`not-found`、`trash-empty`、`project-missing`、`io`，域前缀固定为 `sessiondelete/`。
- **三个路由自检码**：`bad-method`、`not-found-route`、`bad-request`，带 HTTP 状态语义，不冒充动词码。

## 2. 关键文件

| 文件 | 职责 |
|---|---|
| `src/shared/wire.ts` | 跨半 wire 契约：前缀、端点、`RemoteFailure`、`SESSION_DELETE_CODES`、`VERB_CODES`、`ROUTE_CODES`、`verbCodeOf`、`isSessionDeleteCodeError` |
| `src/verbs/errors.ts` | 进程内构造器：`verbError`、`routeError`、`trashEmpty`、`rollbackReason`、`withRollbackFailures` |
| `src/remote/map-error.ts` | 把任意抛出物映射到 `RemoteFailure`：`toRemoteFailure` |
| `src/client/remote.ts` | 浏览器半：将远端返回的 `{ok:false,error}` 包装成可抛出的 `RemoteFailure`（补上 `isDSHRemoteError` 标记） |
| `src/api/dispatch.ts` | Node 半入口：调用 `map-error.toRemoteFailure` 产出失败信封 |

## 3. 架构约定

### 3.1 工厂优先于直接 new Error

动词层一律通过 `verbError(code, message, cause?, details?)` 构造失败（见 `delete-session.ts`、`permanent-removal.ts`、`live-admission.ts`、`batch.ts`、`restore-session.ts`、`orphan-subagents.ts`）。这保证了 `code` 字段始终来自 `SESSION_DELETE_CODES[code]` 字面量，不会手写错字符串。

### 3.2 回滚失败聚合

`withRollbackFailures(error, failures)` 把一组回滚步骤的失败标签聚合成 `details.rollbackFailures` 数组，并追加到消息正文中的 `；回滚未完成：…` 段。它保留原错误的动词码（通过 `verbCodeOf`），没有码时落 `io`；同时合并内层已挂着的 `rollbackFailures`，避免重复文案。`rollbackReason(label, error)` 提供统一的标签模板。

### 3.3 宿主类型化错误的桥接

`map-error.ts` 的 `hostErrorOf` 沿 `cause` 链（深度 ≤ 8）查找宿主抛出的 `WorkspaceUnknownSessionError`、`WorkspaceActiveSessionError`，按 `name` 映射为 `not-found` / `live`。这是唯一允许跨插件值 import 的红线之外的特例——因为宿主类不可被本仓 import（不同插件、不同代），只能按 `this.name` 字符串匹配。

### 3.4 结构化附带物 (details)

`ownDetailsOf` 从错误对象上提取 `sessionId`、`workspaceId`、`path`、`activity` 等字段，作为 `RemoteFailure.details` 上线；`activity` 经 `JSON.parse(JSON.stringify(...))` 往返以去除循环引用。就近优先：自身挂着的 `details` 优先于 `cause` 链上的宿主字段。

### 3.5 线上形状而非 Error 实例

`toRemoteFailure` 返回的是纯数据对象 `{code, message, details?}`，不是 `Error` 实例。注释明确说明「这份东西唯一的去处是 `src/api/dispatch.ts` 的失败信封（以及 `verbs/batch.ts` 的逐条 `error`）」，且跨插件 import 红线禁止引入宿主的 `RemoteError` 类。

### 3.6 官方 code 透传

如果抛出物本身带有官方形状的 `code`（正则 `/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/`）且不属于本仓的 `sessiondelete/*`，则原样透传到客户端，不降级为 `io`。这是为了保留宿主侧已有语义（如 `workspace/session-active`）不被抹掉。

## 4. 约定与约束

- **错误码集中定义**：所有 `sessiondelete/<suffix>` 后缀必须出现在 `VERB_CODES` 与 `SESSION_DELETE_CODES` 中，否则编译期报错（`Record<AllCodeSuffix, ...>` 类型即闸）。新增动词码不能只加字面量。
- **读码走工具函数**：判断是否为本仓错误用 `isSessionDeleteCodeError`，取动词码用 `verbCodeOf`，禁止在调用点手写前缀字面量（wire.ts 注释明确要求）。
- **浏览器半共享契约**：wire.ts 构建约束为「零运行时依赖、无 import」，浏览器端会 inline 整个文件进 bundle；因此不得在此文件中引入任何外部模块。
- **错误消息来源单一**：`messageOf` 规定 `Error` 取 `.message`，带 `message` 字符串的非 Error 也取之，其余一律 `String()`；调用方不得绕过此函数自行拼接显示文本，否则会出现「同一个失败三个说法」。
- **回滚文案格式统一**：`rollbackReason` 是唯一允许的标签模板，注释要求「调用方不许另抄这份格式」，以避免界面出现多套回滚文案。
- **空 details 不写**：`RemoteFailure.details` 在没有附带物时整件缺席，而不是写入空表；「带过但为空」和「没有可带的」是两件事（wire.ts 注释明确）。
- **非官方 code 兜底 io**：形状像 code 但不是官方域、也不是 `sessiondelete/*` 的字符串，会被 `toRemoteFailure` 兜为 `sessiondelete/io`（`map-error.ts` 注释说明）。
- **路由错误带 httpStatus**：`routeError` 产出的 `VerbError & { httpStatus: number }` 用于请求校验失败，与业务动词码区分开。
- **回滚失败继承**：`withRollbackFailures` 必须保留原错误并合并内层的 `rollbackFailures`，组级 catch 再包一次时不能丢弃（errors.ts 注释强制）。

## 5. 测试覆盖

`tests/verbs-errors.test.ts` 验证动词错误码与消息；`tests/remote.test.ts`、`tests/client/support/fake-remote.ts` 覆盖 `toRemoteFailure` 与远端错误桥接路径。