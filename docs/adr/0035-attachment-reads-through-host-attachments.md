# ADR-0035 — 附件读取走宿主 attachments 服务，直接 fs 只留 fallback

Status: accepted

`GET /attachment` 过去直接拼 `$DSH_HOME/attachments/v1/...`、自己 stat/read/判魔数。宿主已经公开 `attachments` 服务：`readImage(ref)` 会按记录里的引用**校验字节**并返回归一化 ref，`readFileStream(ref)` 分块读并校验。附件读取改成：有服务且请求带够引用元数据时走服务；服务缺席或元数据不够（旧宿主/旧客户端）才退回直接 fs。

## 背景

面板与设置页维护卡都要显示回收站条目里的图片和普通文件。宿主的附件记录（`ImageAttachmentRef` / `FileAttachmentRef`）已经随会话日志过线到详情；插件再按目录布局读一遍，等于复制宿主的存储布局与校验规则：

- 图片的类型靠插件自己嗅魔数，宿主的归一化结果（媒体类型、尺寸、字节）反而没用上；
- 宿主将来改布局或校验，插件不知道；
- 已删除会话的附件仍在宿主附件库里，`readImage` / `readFileStream` 不要求会话活着，正好可用。

## 决定

1. **服务优先**：新增 `src/ports/attachments-port.ts` 的窄镜像（`available` / `readImage` / `readFileStream`），每次调用 `ctx.get('attachments')` 惰性解析；`GET /attachment` 在 `available()` 为真且请求带够 `mediaType` / `bytes` / `width` / `height`（图片）或 `bytes`（文件）时走服务。
2. **引用元数据只做校验输入**：客户端把详情里的引用字段放进查询串；它们不参与路径推导，id 仍是唯一寻址。服务返回的归一化 ref 决定响应的媒体类型；服务校验不过就是一次读取失败（200 + `io` 信封），不折成 404。
3. **直接 fs 是 fallback**：服务缺席、成员形状不符、或旧客户端没带够元数据时，仍走 `attachmentPathOf(home, kind, id)` + stat/read + 魔数 + `maxAttachmentBytes` 闸（默认 20 MiB）；这条路径保留给 `engines.dsh` 下界与旧客户端。
4. **20 MiB 上限仍由插件守**：服务的图片策略与文件流本身没有本插件承诺的响应上限；`readImage` 的返回字节与 `readFileStream` 的累加都在插件侧再判一次（默认 20 MiB，可配，ADR-0037）。
5. **deps 切成第四片**：`DeleteDeps` 多一个 `attachments`，`SliceDeps` 多 `attachment: CoreDeps & { attachments }`；只有 `attachment` 段拿它，动词的 `CoreDeps` 面不变。
6. **孤儿扫描/删除不走这个端口**：宿主没有对象列表/删除 API；`src/trash/attachments.ts` 的直接 fs 继续负责扫描与删除。宿主虽有 `imageHostPath` / `fileHostPath`，但孤儿对象只有 `id` / `bytes`，凑不出完整 ref；扫描路径仍只由 `attachmentPathOf(home, kind, id)` 推导。

## 边界

- 不把宿主附件服务当成删除 API：它没有 delete；永久删除仍只直接删 `.dsh` 内的独占图片副本（ADR-0020）。
- 不改变 `GET /attachment` 的寻址与鉴权：id/kind 仍是唯一寻址，通道鉴权归 ADR-0033。
- 服务返回的错误按 `io` 信封上屏；图片 `onError` 换占位、普通文件浏览器可能把错误响应存成文件——与直接 fs 的失败面一致。
- **服务校验失败不回退直接 fs**：`readImage` / `readFileStream` 的 `ATTACHMENT_NOT_FOUND` / `INVALID_ATTACHMENT_REF` / `ATTACHMENT_CORRUPT` 都按 `io` 上屏。宿主读的是 `files/<2>/<hash>/<name>` 别名，直接 fs 读的是 `file-objects/<2>/<hash>` 对象——两条路径字节相同但信任面不同；绕过会跳过宿主的摘要/元数据校验。floor 起保存时都会发布别名，正常日志不会命中这三类错误。
- 旧宿主/旧客户端继续可用；`engines.dsh` 下界不因这个改动抬高。

## 后果

- 现代宿主上的附件读取复用宿主的字节校验与归一化结果；插件不再复制图片魔数表作为主路径（fallback 仍保留）。
- `src/api/attachment.ts` 的 `AttachmentReadPorts` 多 `attachments`；`src/api/route-table.ts` 的 `attachment` 段声明 `attachment` 切片；`src/deps.ts` 的 `DeleteDeps` 多这一项；`tests/deps.test.ts` 的键集与切片用例同步。
- 客户端 `attachmentUrl` 多带媒体元数据；它只影响服务路径的引用校验，不改变寻址。
- 新增 `tests` 覆盖服务路径（图片 / 文件流 / 超限 / 服务缺席 fallback）。

## 被否掉的替代

- **继续直接 fs**：复制宿主布局与校验，宿主一改就坏；且拿不到归一化后的媒体类型。
- **只用 `imageHostPath` / `fileHostPath` 读路径**：它们给的是路径，不校验字节；读了仍要自己判，等于没换。
- **用服务做孤儿清理**：宿主没有对象列表与删除 API；硬做只能再拼目录，反而多一层假装。
- **把 `attachments` 塞进 `CoreDeps`**：动词不需要它，扩大动词的依赖面；放在 `attachment` 切片只给读段。

锚点：`src/api/attachment.ts`；`src/ports/attachments-port.ts`；`src/api/route-table.ts`；`src/deps.ts`；`src/client/attachment-view.tsx`；`tests/api.test.ts`；`tests/attachments-port.test.ts`；`docs/architecture.md` §2 / §4 / §6；ADR-0020；ADR-0033。
