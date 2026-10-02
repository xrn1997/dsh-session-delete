## 1. 采用的体系与模式

本仓库是一个 DeepSeek Harness 的第三方插件，错误处理围绕「动词层定义领域码 → 远程层映射宿主类型化错误为统一信封 → 客户端按 `code`/`message` 展示」这一单向链路展开。核心设计参考了设计稿 §6（错误码表）与 §7（确认框交互），并通过注释在多处显式引用。

- **领域码集中声明**：`src/verbs/errors.ts` 是唯一来源，导出常量数组 `VERB_CODES = ['live', 'not-found', 'trash-empty', 'project-missing', 'io']` 及类型 `VerbCode`，并提供工厂函数 `verbError(code, message, cause?)`——它构造一个带 `code`（前缀 `sessiondelete/`）和可选 `cause` 字段的普通 `Error`。
- **远程失败信封**：`src/remote/map-error.ts` 把任意抛出物归一化为 `{ code: string; message: string }` 形状（不返回 `Error` 实例，避免跨插件 import 红线），供 `src/api/dispatch.ts` 作为线上传输对象使用。
- **客户端只消费 `code`/`message`**：浏览器端没有自定义异常类；失败通过 React state（如 `DeleteConfirmHost` 的 `failure: string | null`）以原文形式渲染到 UI。

## 2. 关键文件

| 文件 | 职责 |
|---|---|
| `src/verbs/errors.ts` | 五个领域码的唯一来源、`verbError` 工厂 |
| `src/remote/map-error.ts` | 宿主类型化错误 → 插件域码映射、`toRemoteFailure` 转换器 |
| `src/client/delete-confirm.tsx` | 确认框中捕获远程失败并原样上屏 |
| `src/client/ui/Toast.tsx` | 成功撤销等正向反馈的 Toast（无错误语义） |
| `src/src/api/dispatch.ts` | 调用远端后接收失败信封（由 `map-error.ts` 产出） |

## 3. 架构与约定

### 3.1 错误码分层与归属

- **插件专属域名**：`DOMAIN = 'sessiondelete'`，所有插件侧抛出的 `code` 形如 `sessiondelete/live`、`sessiondelete/not-found` 等，与宿主官方域（`workspace/*`、`session/*`、`gateway/*`…）不重名。
- **五个码的职责**：
  - `live`：会话仍活跃（对应宿主的 `WorkspaceActiveSessionError`）。
  - `not-found`：会话不存在（对应 `WorkspaceUnknownSessionError`）。
  - `trash-empty` / `project-missing`：回收站为空 / 项目缺失等业务态。
  - `io`：兜底码，任何未识别的 I/O 或未知错误都落在此码。
- **单点维护**：`map-error.ts` 从 `VERB_CODES` 反推允许列表，新增码只需改一处，避免两张表漂移导致静默降级成 `io`。

### 3.2 宿主类型化错误的识别与映射

宿主错误类不可直接 import（跨插件值 import 是红线，且宿主包与运行中的宿主可能不同代），因此 `hostCodeOf` 采用**基于 `error.name` 字符串匹配**的策略：

1. 沿 `cause` 链最多回溯 8 层。
2. 对每个节点用 `Object.hasOwn(HOST_ERROR_CODE, name)` 精确判断（不用 `in`，防止命中 `Object.prototype` 上的键回退成函数名）。
3. 命中则返回对应的 `VerbCode`；否则返回 `undefined`。
4. 优先级：宿主类型化错误 > 动词自身的 `sessiondelete/<码>` > 兜底 `io`。

### 3.3 消息提取策略

`messageOf(error)` 保证设计稿 §6 的承诺——`message` 是上屏原文：

- `instanceof Error` → 取 `.message`。
- 非 Error 但带 `message` 字符串的对象 → 也取之。
- 其余一律走 `String(error)`，避免 `[object Object]`。

### 3.4 客户端错误呈现

`DeleteConfirmHost` 的交互契约：

- 调用 `callRemote(() => deps.delete(sessionId))` 后，若 `outcome.ok === false`，把 `outcome.failure.message` 写入 `failure` state。
- **不吞错**：失败以 `<Tag tone="danger">` 显示在对话框内，**不关闭弹窗**，用户可重试。
- 成功后才 `clearDeleteRequest()` 并触发撤销提示（`publishUndoNotice`）。

## 4. 约定与约束

- **领域码唯一声明处**：`src/verbs/errors.ts` 的 `VERB_CODES` 数组是唯一的权威源，`map-error.ts` 通过 `includes(VERB_CODES)` 校验传入码是否合法；非法码会被降级为 `io`。
- **禁止跨插件 import 宿主错误类**：`map-error.ts` 明确拒绝引入宿主 `RemoteError` 等类型，仅依赖 `this.name` 字符串和 `isDSHRemoteError` 结构标记。
- **错误信封不是 `Error` 实例**：`toRemoteFailure` 返回纯对象 `{ code, message }`，因为线上只序列化这两件字段，且构造函数跨进程不可用。
- **客户端不暴露内部错误类型**：浏览器端只消费 `RemoteFailure` 的 `code`/`message`，不定义自己的异常类。
- **UI 层不吞错**：确认框失败面保持打开，让用户能重试；成功后的撤销 Toast 走 `tone="success"` 的正向路径，与错误路径分离。
- **`cause` 链深度有界**：最多回溯 8 层，且遇到非对象即短路，防止恶意或损坏的 `cause` 链导致无限递归。
- **`message` 必须可上屏**：所有分支最终落到字符串，确保设计稿 §6 关于 `message` 的许诺不被破坏。

## 5. 未覆盖的方面

仓库中未发现 `panic/recover`（Go）、全局中间件级错误处理（Express/Fastify 风格）或统一的日志级别配置；错误传播主要发生在插件内部的「动词 → 远程 → 客户端」三层之间，而非宿主框架层面。