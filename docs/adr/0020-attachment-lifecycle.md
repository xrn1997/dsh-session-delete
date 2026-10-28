# 附件只随永久删除清理独占的 .dsh 副本

Status: accepted

宿主把图片存进 `$DSH_HOME/attachments/v1/objects`，没有删除接口，并明确永不自动回收；本插件的永久删除因此自己清一份：只删被删会话引用、且剩余任何会话/派生存储都不再引用的图片对象，绝不碰用户磁盘上的原图，也暂不删普通文件附件。

## 边界

- 进回收站、恢复都不动附件；只有永久删除（purge / 清空 / orphan-clean）与设置页的孤儿附件清理（`POST /attachment-clean`，ADR-0021）触发。
- 剩余引用源读不出 ⇒ 本次跳过，宁可留孤儿也不删共享（判据住 `src/trash/attachments.ts`）。目录里有子目录、或规范日志旁还有非空临时日志 / 明文日志等读不懂的文件，同样按读不出处理：规范日志只覆盖本目录，那些文件里有没有引用无法回答。
- 普通文件（`file-objects` / `files`）只渲染不代删：硬链接与 Windows 只读属性的删除语义另立一项。
- 未发送草稿的附件只在客户端内存，磁盘扫描不可见；这是已知残余风险。
- `GET /attachment` 仍过请求栅栏（`src/api/request-trust.ts`）：跨源 `no-cors` 且 `no-referrer` 的 `<img>` 会让 `Origin` / `Referer` 都缺席，从本机回环来源放行 ⇒ 知道内容哈希的一方可把对应图片跨源渲染。暴露面只有图片字节本身，寻址只认 id，没有越界读；同源读面（含 `GET /attachment-orphans` 的对象哈希清单）不会把清单交给跨源页面（no-cors 响应不可读）。
- 不新增自动过期、定时 GC 或常驻孤儿入口；剩余存量由插件设置页的维护卡手动清理（ADR-0021），不走一次性脚本。

## 被否掉的替代

- **移入回收站就删附件**：回收站详情要渲染、恢复后也要继续看图，删了就没有恢复路径。
- **全局孤儿 GC 不看会话**：草稿不可见，且不符合“删除跟着会话走”。
- **把图片作为 data URL 塞进详情**：一条会话多图会把详情变成几十 MB 的 JSON。

## 后果

详情多一段二进制附件读取（`GET /attachment`）与放大框里的「另存为」（按响应类型补扩展名的 blob 下载），永久删除回执多一份附件统计；`FsPort` 多 `statFile` / `removeFile`，`removeFile` 在 `RemovalDeps` 这一层提供（`CoreFsPort` 不含），附件执行面与读面各收更窄的 `AttachmentRemovalDeps` / `AttachmentReadPorts` Pick。

## 代价

批量永久删除（清空回收站、批量 purge）逐条重扫剩余引用源：每删一条都要把活动会话、回收站目录与派生存储再走一遍，规模越大越慢。当前规模接受这一成本；home 变大后改成批级只扫一次，而不是现在就加缓存与失效协议。

锚点：`src/trash/attachments.ts`；`src/api/attachment.ts`；`src/verbs/permanent-removal.ts`；`tests/attachments.test.ts`；`docs/architecture.md` §6；ADR-0006。
