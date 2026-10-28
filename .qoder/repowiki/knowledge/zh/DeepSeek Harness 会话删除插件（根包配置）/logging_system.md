## 概述

本仓库是 DeepSeek Harness 的「会话删除」插件，自身不直接输出业务运行日志（仅 `src/trash/attachments.ts` 中三处使用 `console.warn` 打印附件清理告警），而是**读取宿主进程产生的会话日志**，将其从 zstd 帧流中解析为结构化记录供 UI 展示。因此该仓库的“日志系统”实际由两部分组成：

1. **产出方（宿主的 DSH）**：以 `.jsonl.zstd` 文件持久化每行一条 JSON 的会话记录，按代次命名（如 `session.v4.jsonl.zstd`），并支持多代并存。
2. **消费方（本插件）**：提供 `src/log/session-log.ts` 中的流式解析器、帧头提取器与版本选择器。

## 关键文件

- `src/src/log/session-log.ts` — 核心解析逻辑（实际路径在仓库根下为 `src/log/session-log.ts`，见测试 import）；暴露 `walkSessionLog`、`readSessionHeader`、`pickSessionLog` 三个 API。
- `tests/session-log.test.ts` — 覆盖帧拼接、截断、不可解码帧、回调早停、多代选代等全部行为契约。
- `src/trash/attachments.ts` — 唯一使用 `console.warn` 的业务落点（附件清理拒绝 / 失败告警）。

## 架构与约定

### 存储格式

- 每条会话一个文件，文件名遵循 `/^session(?:\.v([1-9][0-9]*))?\.jsonl$/u`，可选 `.vN` 版本号（裸名视为第 0 代）。
- 文件整体经 zstd 压缩；内部是一行一条 JSON 的记录流，首条记录的 `type` 必须为 `session`，字段包括 `id`、`cwd`、`createdAt` 以及 `version`（当前为 4）。
- 多条记录可写入同一 zstd 帧，也可跨帧切分一行（解析器会缓冲跨帧片段后按换行符拆分）。

### 解析器设计（`walkSessionLog`）

- 输入：`Buffer`（可能由多个独立 zstd 帧拼接而成）。
- 逐帧解压 → 按 `\n` 拆行 → 对每行 `JSON.parse` → 回调 `(record) => void | false`。
- 返回统计对象 `{ frames, records, unparsedLines, truncatedTailBytes }`。
- 若某一帧无法解码，抛出包含「第 N 帧」信息的错误，**绝不半解半装**。
- 回调返回 `false` 即就地停机，后续帧不再处理。
- 非对象的一行（`null`、数组）仍交给策略层判定，`type` 字段为 `undefined`。
- 最后一行被截断时不计入 `unparsedLines`，但记录 `truncatedTailBytes` 长度。

### 会话头读取（`readSessionHeader`）

- 只扫描第一个 `session` 类型记录，提取 `id`、`cwd`、`createdAt`。
- 取到后即停止，不会尝试解码后续帧；因此即使后面存在坏帧也不会抛错。

### 多代日志选择（`pickSessionLog`）

- 同一目录可并存多个版本的日志文件（宿主升代后旧代保留）。
- 选择规则：**数值上最大的版本号**，裸名算第 0 代；`.v0`、前导零、大写、临时后缀一律被视为非规范名而跳过。
- 如果列表中只有明文 `.jsonl`（无 `.zstd`）则返回 `undefined`，因为本插件只能读 zstd 压缩日志。

### 运行时日志输出

- 除测试外，插件自身没有独立的 logger 模块；业务侧仅在 `src/trash/attachments.ts` 通过 `console.warn` 输出三条告警（附件 id 形状异常、路径不一致、清理失败）。
- 这些告警是面向宿主控制台的原始字符串 + 附加参数，没有结构化字段或级别管理。

## 约定与约束

- **记录首行必须是 `session` 类型**：`readSessionHeader` 依赖此约定定位会话元数据；若无则返回 `undefined`。
- **单行一记录**：解析器按换行符拆分，跨帧拼接后再拆分；策略层负责解释每条记录的语义。
- **帧级原子性**：任一 zstd 帧解码失败即整体失败，调用方需自行决定重试或降级，不能部分消费。
- **版本选择采用数值比较而非字典序**：`v10` 应优于 `v9`，由 `pickSessionLog` 实现保证。
- **日志文件命名规范化**：只有匹配 `/^session(?:\.v([1-9][0-9]*))?\.jsonl\.zstd$/` 的文件才会被视作有效会话日志，其余同名文件（含 `.tmp`、`.jsonl` 明文）均被忽略。
- **生产代码不使用第三方日志库**：本仓库未引入任何 logging 框架，所有诊断输出走原生 `console`。