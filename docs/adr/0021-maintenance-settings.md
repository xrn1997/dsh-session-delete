# 维护卡只手动：孤儿会话与孤儿附件都住在插件设置页

Status: accepted

存量垃圾有两类——父会话已经不在的**无主子会话**，和 `.dsh` 附件库里没有任何引用源再引用的**孤儿附件**。两类都收进插件设置页的同一张「维护」卡，只在用户点「检查 / 清理」时动：不挂载即扫、不写后重扫、不定时清理。理由是这两类都得扫整个数据根才能回答——无主子会话看父会话还在不在，孤儿附件看还有没有引用源引用——既贵又不该由打开某个页面顺手代跑（回收站面板曾经就是这么做的，见 ADR-0016）。

## 决定

1. **两个维护段都是手动的**：检查 → 预览 → 清理，一次只做用户点的那一步。维护卡不挂 `useEffect`、没有定时器；报告 `null` 表示尚未检查，**或上一次检查失败**——失败是单独的状态（`orphanFailure` / `attachmentFailure`），任何时候都不折成 0，也不冒充"没有发现"。
2. **挂点是插件详情页的 `plugins.bundle.config`**：它是按 bundle 包名寻址的 keyed 子槽位，位于插件描述与组件行之间。宿主页面挂载后才声明它，`inject` 在那里等着；更早的宿主没有这个页，就不挂这张卡，不硬注册一个不存在的槽位。
3. **两类孤儿共用一张卡**：共用的是界面与手动触发，不是判据——无主子会话看父会话还在不在，孤儿附件看还有没有引用源引用；对象与清理动作也不同（会话清盘上目录，附件清 `.dsh` 里的图片对象）。放一起，用户一次看见两类残留，也共享同一条手动纪律。
4. **回收站面板不再扫孤儿**：面板的取数只剩清单与清空（`src/client/use-trash-query.ts`），ADR-0016 的"写后按 outcome 重扫"随之不再成立。面板上只留自己的附件清理 warning（purge / 清空回执），那不是孤儿维护。
5. **附件的报告与清理是两段**：`GET /attachment-orphans` 只读、回数量/字节 + 对象清单（`id`/`bytes`，供设置页缩略图预览；不含路径/文件名；清单最多 200 条，数量与清理都按全量算）；`POST /attachment-clean` 是聚合写，在这一次调用里重新扫描并直接执行，清掉**点击那一刻**无引用的图片对象。两段走 `src/trash/attachments.ts` 的同一套引用扫描，但各自现扫，不共享一份检查快照。

## 边界

- **只删 `.dsh` 内的图片副本**：源文件、普通文件（`file-objects` / `files`）、`tmp` / `v2` / `cache` 一律不碰；共享引用保留。口径与执行住 `src/trash/attachments.ts`，裁决见 ADR-0020。
- **读不出就是失败**：任一引用源（会话日志、`session-trash` 目录、`storages` / `cache` 的 JSON）读不出，报告失败、清理跳过，不折成 0；报告 0 与"没能回答"是两件事。
- **清理按点击那一刻的盘算**：确认框里的数量与体积只是最后一次检查的读数，不是清理的输入；清理请求不带计划，服务端在这一次调用里重扫再执行，回执才是真实结果，清完之后维护卡还会再检查一遍。
- 不新增自动 GC、阈值触发或后台任务；孤儿会话清理仍只走 `/apply` 的 `orphan-clean`，没有第二条执行路径。

## 被否掉的替代

- **自动扫（挂载即扫 / 写后重扫 / 定时）**：每次都要把全部会话日志、回收站目录与派生存储读一遍才敢说"没有残留"；页面一打开就付这份成本，失败还会把"不知道"留在用户眼前。ADR-0016 曾把写后重扫收成一条派生判据，但它服务的是"面板上总有一份最新报告"这个前提，而那个前提现在不成立。
- **留在回收站面板**：孤儿与清单无关——它们不在清册、不在 `session-trash`；把两套取数塞回面板既扩大面板的失败面，也让"打开回收站"变成一次全盘扫描。
- **一次性脚本**：不可复用、没有确认框，而且要把 fail-closed 的引用扫描与执行器在脚本里再写一遍；存量会再长出来，脚本也无法跟着界面一起验。
- **只做孤儿会话，不做孤儿附件**：附件库没有删除接口、宿主永不自动回收，ADR-0020 留下的存量正好由这张卡接住，不需要另写一次性脚本。

## 后果

- 线上契约多两段（九段），浏览器半多一个 keyed 槽位贡献（`src/client/index.tsx`），并新增 `src/client/maintenance-settings.tsx`、`src/client/use-maintenance.ts` 与 `src/api/attachment-orphans.ts`。
- `src/client/write-seats.ts` 不再有孤儿清理座位；`src/client/use-trash-query.ts` 少掉整条孤儿扫描路径与写后重扫判据。
- 界面规格的维护面从回收站面板搬到设置页（`docs/ui-spec.md` §5）；面板只保留附件清理 warning。

锚点：`src/client/maintenance-settings.tsx`；`src/client/use-maintenance.ts`；`src/api/attachment-orphans.ts`；`src/trash/attachments.ts` 的 `scanOrphanImageAttachments` / `cleanOrphanImageAttachments`；`tests/client/maintenance-settings.test.tsx`；`tests/client/use-maintenance.test.tsx`；`docs/ui-spec.md` §5；ADR-0016；ADR-0020。
