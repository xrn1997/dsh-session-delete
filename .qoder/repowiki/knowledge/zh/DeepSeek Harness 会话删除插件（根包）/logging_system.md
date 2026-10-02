## 1. 使用的系统/方式

本仓库**没有引入任何第三方日志框架**（如 `winston`、`pino`、`bunyan`、`log4js` 等），也没有自定义 logger 模块。代码中唯一的输出是浏览器端使用 `console.warn` 打印的一条诊断信息，以及通过 `Error` 对象在进程内和远程边界之间传递结构化错误信息。

- 唯一日志调用位于 `src/client/index.tsx:235`：
  ```ts
  console.warn('[dsh-session-delete] 入口未注册（取数通道不可用）:', error)
  ```
  这是整个插件在运行期对宿主控制台的唯一写操作，使用带命名空间前缀 `[dsh-session-delete]` 的警告级别。

- 其余所有“可观测性”都走 **错误传播通道**：业务异常被包装为 `RemoteFailure { code, message }`，经 JSON 序列化后由远端还原，再由 UI 以行级失败状态展示（见 `client/trash-panel.tsx` 中对 `error` 色 + 警示 glyph 的渲染约定）。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `src/client/index.tsx` | 唯一使用 `console.warn` 的位置 |
| `src/verbs/errors.ts` | 定义五个 verb 码（`io` 兜底），是错误码的唯一真相源 |
| `src/remote/map-error.ts` | 把 Node 侧 `Error` 映射为 `{ code, message }`，供浏览器端消费 |
| `src/api/dispatch.ts` | 将远端失败统一写入 `{ ok:false, error:{code,message} }` 信封 |
| `src/client/remote.ts` | 浏览器端反解信封并抛出带 `code` 的 `Error` |
| `client/trash-panel.tsx` | 以行级失败 UI 显示错误消息 |

## 3. 架构与约定

- **无日志分级体系**：没有 debug/info/warn/error 多级输出；唯一的运行时输出是 `console.warn`。
- **错误即日志**：业务路径不直接写日志，而是抛错 → 捕获 → 包装成 `verbError(code, message, cause)` → 远端映射为 `RemoteFailure` → UI 展示。设计稿 §6 的五个码集中定义于 `src/verbs/errors.ts`，`map-error.ts` 从该数组反向生成宿主侧 `Code` 表，保证两端错误码一致。
- **结构化字段**：错误结构固定为 `{ code: string; message: string }`（见 `client/remote.ts` 第 77–87 行的 `throwRemoteFailure` 与 `unwrapRemoteResult` 注释），其中 `code` 形如 `${DOMAIN}/${VERB_CODE}`（例如 `session/io`），`message` 保留原始中文描述。
- **生产环境约束**：由于没有日志框架，不存在日志轮转、采样、脱敏或 sink 路由——所有可观测依赖宿主（DeepSeek Harness）提供的控制台能力。

## 4. 约定与约束

- **唯一日志点**：整个插件只有 `src/client/index.tsx:235` 一处 `console.warn`，且强制使用 `[dsh-session-delete]` 命名空间前缀，用于区分宿主其他插件的输出。
- **错误码单一真相源**：`src/verbs/errors.ts` 中的 `VERB_CODES` 数组是「五个码」唯一定义处（其注释明确声明），`src/remote/map-error.ts` 不得自行维护另一份映射。
- **错误信封形状稳定**：`api/dispatch.ts` 注释强调 `{ok:true,value}` / `{ok:false,error:{code,message}}` 是浏览器半消费的形状，禁止随意扩展字段，以保持与官方 unary 面兼容。
- **UI 展示约定**：`trash-panel.tsx` 规定失败原因必须写在对应操作行的第二行下方，使用 `--dsw-alias-state-error-primary` 颜色，且不设置 background（避免与宿主 danger 按钮冲突）。

**结论**：本项目不存在独立的 logging system；运行时可见性完全依赖宿主控制台与错误对象的跨层传递。