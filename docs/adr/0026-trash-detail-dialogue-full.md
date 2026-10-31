# ADR-0026 — 回收站详情改为对话全量：块投影、折叠与游标分页

Status: accepted

回收站详情原先只列真实提问与助手文字，把注入上下文、思考与工具调用藏在计数里；用户要在恢复/彻底删除前看全一条会话，而宿主 Chat 本身按设计隐藏普通注入、Trajectory 才是逐事件视图，且已进回收站的会话不在宿主语料里。于是把详情改成**对话全量**：按块投影全部对话内容、宿主式折叠、游标分页，而不是复刻宿主加载或做 Trajectory 全量表。

## 背景

删除是 `detach` 工作区账本 → 把会话目录 `rename` 进 `session-trash/` → `evictLive`。宿主的会话语料是 live ∪ `sessions/` 下的持久化，父进回收站后连 `traceSession` 都报 `SESSION_QUERY_SESSION_NOT_FOUND`；要复用宿主加载，只能先把目录搬回、挂账本、甚至冷 resume——那等于把一条已删会话重新塞回宿主列表，预览失败还会留下半恢复状态。

宿主的聊天视图是客户端包 `@deepseek-ai/dsh-client-ui-chat`，浏览器半的硬约束禁止 import 任何 `@deepseek-ai/*` 客户端包，槽位表里也没有“给一个会话 id、只读渲染”的官方槽位。详情只能自己读盘、自己画。

旧详情按 `source.kind === 'user'` 过滤 `user/message`，只把助手 `type === 'text'` 的段放进正文；注入条数常比真实提问多得多，思考段与工具结果全被丢掉。用户看到的是“另有 N 条宿主注入的上下文未显示”，却没法在删之前核对那条会话到底发生了什么。

## 决定

1. **正文从“消息”改成“块”**：`TrashDetailWire.messages` 换成 `blocks` 判别联合——`user` / `assistant` / `reasoning` / `tool` / `injection` / `system` / `compaction`。`user/message` 按 `source.kind` 分 user / injection；`assistant/message.content` 按 `text` / `reasoning` 拆块，附件并进相邻的文字块；`tool/call` 建工具块、`tool/result` 按 `callId` 回填（成功 / 失败 / 未完成三态）；`system/message` 与 `compaction/summary` 各成一块。turn/step/job/request 这类簿记事件不进正文。
2. **分页是游标，不是总量闸**：一次只回尾部一页（块数上限住 `src/trash/detail.ts` 的 `PAGE_BLOCK_LIMIT`，正文总量上限住 `PAGE_CHAR_LIMIT`；单块超字符闸时仍保留一块，游标才能前进），`olderCursor` 指页首；`POST /detail` 的 body 多一格可选 `before`，客户端把游标原样回传取更早一页。每块另有单块字符闸（`PER_BLOCK_CHAR_CAP`，正文与工具参数/结果各自算），超了标 `truncated`。计数是整条日志的，不受分页影响。
3. **块构建只留当前页**：走日志时用有界缓冲只保留当前页的块（块数与正文字符双闸），不把整条日志的正文堆在内存里；工具结果可能落在游标之后，仍会回填到页内那个调用块——不能把“已完成”误报成“未完成”。
4. **界面按宿主 Chat 的折叠语法画**：用户/助手文字常显；思考、工具、注入、系统消息、压缩摘要默认折叠，折叠头给标签 + 首行摘要（工具另给状态与工具名）；可逐块开合，也可「全部展开 / 全部折叠」。有更早页时顶部出「加载更早」，prepend 后按滚动高度差补偿位置。
5. **注入不再只报“未显示”**：它成为可折叠的 injection 块，`sourceKind` 原样过线、界面映射来源标签；条数进元信息表。这是对宿主 Chat 的**有意偏离**——宿主隐藏普通注入，而这里的目标是“删之前看全”。

## 边界

- **不做 Trajectory 全量表**：turn/step、job、request、permission、sandbox、approval、goal、workspace changes、重试与 compaction 的 start/end 都不铺进正文；要逐事件全量是另一个视图，另行设计。
- **不做子会话详情**：回收站里子条目被折进父行、没有详情入口，单独跟 issue #7；这次只改单条详情。
- **不做“查看完整单块”的第二条请求**：单块超过上限只标「已截断」；要一字不差就看恢复后的宿主。
- **不重建工具富媒体卡片**：工具参数/结果走等宽纯文本，附件仍走现有图片/文件条；宿主工具视图的 terminal / diff / 搜索卡片不在这次范围。
- **计数口径**：`assistantMessageCount` 数每一条 assistant/message（含只带 reasoning / tool-call 的）；`injectedCount` 数建了块的注入；`toolCallCount` 数每一条 tool/call；三者都不受分页与单块闸影响。

## 后果

- 线上形状换了：`messages` / `omittedByPayloadCap` 删除，`blocks` / `olderCursor` 上线；`src/client/copy.ts` 的 `detail.messages.hidden` / `detail.messages.omitted` 删除。
- `/detail` 的 body 多一格 `before`；不是非负整数 ⇒ 400。详情仍是 pure/raw，不对账。
- **单页响应有界**：正文总量由 `PAGE_CHAR_LIMIT` 封顶（游标之后回填的工具结果也计入，超了从页首挤出，被挤出的调用在更早一页重新配对），再加块数与附件条数闸；响应大小不随会话长度增长。
- 详情每次取一页都要重走整条日志，换来的内存上限是“当前页 + 一帧明文”，不是整条会话的正文。
- 详情块渲染多一层折叠状态；切条目用 `key={entry.id}` 重挂载，分页 prepend 保留已展开的块。

## 被否掉的替代

- **复用宿主会话加载 / 聊天渲染**：已删会话不在宿主语料；`traceSession` 认不出；浏览器半不能 import 宿主客户端包；先恢复再预览会改变回收站语义，还可能创建活体。
- **Trajectory 式逐事件全量**：信息最全，但对“删不删”这个决定太吵，还要虚拟化与第二套视图；先做对话全量，逐事件留给后续。
- **一次返回全部块、只提高总闸**：超大工具结果仍会被截，且一次 JSON 可能几 MB；分页把“能翻到全部历史”和“单次响应有界”拆成两件事。
- **继续隐藏注入、只加思考/工具折叠**：最接近宿主 Chat，但满足不了“全部”，也会留下那条“另有 N 条未显示”的提示。

锚点：`docs/architecture.md` §4（详情主人行与块渲染行）；`docs/ui-spec.md` ⑥；`src/trash/detail.ts`；`src/client/trash-detail.tsx`；`src/client/use-trash-panel-controller.ts`；`src/shared/wire.ts`；`tests/trash-detail.test.ts`；`tests/client/trash-detail.test.tsx`。
