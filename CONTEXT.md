# CONTEXT.md — dsh-session-delete

本仓的**领域词表**：只回答「这个词指什么、别用什么词」。行为判据住代码与测试，架构形状住 `docs/architecture.md`（§4 是唯一主人清单），界面现状住 `docs/ui-spec.md`，难逆的裁决住 `docs/adr/`。命名以本文为准；要引入这里没有的词，先想清楚是不是在发明本仓不用的语言。

## 这是什么

在宿主里移除会话分两条路：可恢复的叫**移入回收站**，无恢复路径的叫**永久删除**（界面文案可说「彻底删除」）；「删除」只活在「永久删除」概念里（也作真实移除的泛指动词），不再用它称呼可恢复动作。回收站之外还有三类手动维护的存量：无主子会话、孤儿附件、孤儿投影缓存。两半：Node 半（动盘、清册、宿主服务）与浏览器半（槽位界面）。

## 名词

**数据根（home）**:
宿主运行时数据根：显式配置 > `$DSH_HOME`（空白视为未设）> `~/.dsh`。
_唯一实现_: `src/ports/home.ts` 的 `resolveHome`。

**通道（channel）**:
浏览器半到 Node 半的唯一取数路径：宿主 `connection` 的 exact Fetch 路由（`/api` + 插件前缀）；Host / Origin 与浏览器认证归宿主 `/api`。
_唯一实现_: `src/api/connection-route.ts` 的 `registerConnectionRoutes`；`src/client/remote.ts` 的 `createHttpRemote` / `probeChannel`；`src/client/api-base.ts` 的 `apiPath`。
_Avoid_: 接口、API（太泛）；fallback（旧前缀已删）。

**会话（session）**:
宿主持久化的一条对话，落盘 `sessions/<项目目录>/<会话目录>/session.vN.jsonl.zstd`；zstd 多帧，只读版本号最大的那代。
_无单点实现_: 宿主概念；本插件只经端口读面投影。

**附件（attachment）**:
会话消息里的 `image` / `file` block 指向附件库的内容寻址对象；读取优先宿主 `attachments` 服务，服务缺席或元数据不够才直接 fs。
_唯一实现_: `src/trash/attachments.ts` 的 `attachmentsInContent`；读取面 `src/api/attachment.ts` 的 `readAttachmentResponse`。

**附件库（attachment store）**:
`$DSH_HOME/attachments/v1`：图片在 `objects/`，普通文件在 `file-objects/` + `files/`。宿主所有、没有删除接口。
_无单点实现_: 宿主存储；本插件只在永久删除与孤儿清理时删 `.dsh` 内的图片副本。

**附件引用（attachment reference）**:
会话消息 `content[]` 里指向附件库对象的 `image` / `file` block；`attachmentId` 是唯一寻址依据。
_唯一实现_: `src/trash/attachments.ts` 的 `attachmentsInContent`。

**同源取数闸（same-origin fetch gate）**:
只挂附件字节段：拒 `Sec-Fetch-Site` 为 same-site / cross-site 的请求，以及 authority 与 Host 头不符的 http(s) Origin / Referer；拒绝回 403 + 失败信封。
_唯一实现_: `src/api/connection-route.ts` 的 `isSameOriginFetch`；声明住 `src/api/route-table.ts` 的 `fetchGate`。

**可调项（config）**:
宿主 profile 的 patch 层里给本插件的三只旋钮（孤儿预览条数 / 附件响应上限 / JSON 扫描上限）；归一一次后作为 `CoreDeps.config` 注入。
_唯一实现_: `src/config.ts` 的 `DEFAULT_CONFIG` / `normalizeConfig` / `Config`；读写段住 `src/verbs/config.ts`。
_Avoid_: 设置（界面设置页）、环境变量（可调项只走宿主 patch 层）。

**引用扫描（reference scan）**:
判断图片对象是否仍被引用：读全部会话日志、全部 `session-trash` 目录与 `storages` / `cache` JSON；任一读不出按不可知处理，删除整体跳过。
_唯一实现_: `src/trash/attachments.ts` 的 `imageIdsOfDir` / `collectRemainingImageRefs`。

**孤儿附件（orphan attachment）**:
附件库 `objects/` 下、任何引用源都不再引用的图片对象；只由维护卡手动检查与清理。
_唯一实现_: `src/trash/attachments.ts` 的 `scanOrphanImageAttachments` / `cleanOrphanImageAttachments`。
_Avoid_: 无主附件（父会话不在的是「无主子会话」）。

**孤儿投影缓存（orphan projection cache）**:
宿主 `session_projcache` 域里既没有对应会话、也没有清册行或 `session-trash/` 目录的记录；只由维护卡手动清；任何一环读不出都整体失败，不折成 0 条。
_唯一实现_: `src/trash/projection-cache.ts` 的 `orphanProjectionCacheIds` / `cleanProjectionCacheOrphans` / `dropDeletedSessionCache`。

**附件清理（attachment cleanup）**:
永久删除或孤儿附件清理时按计划删掉 `.dsh` 内独占 / 无引用的图片副本；不碰源文件、普通文件与共享引用。
_唯一实现_: `src/trash/attachments.ts` 的 `executeImageAttachmentRemoval` / `cleanOrphanImageAttachments`。

**项目目录（`projectDir`）**:
宿主 `projectKey(cwd)` 的产物，**有损**（分隔符那段拆不回真实路径）。
_唯一实现_: `src/shared/project-key.ts` 的 `escapeProjectKey` / `unescapeProjectKey` / `NO_CWD_PROJECT_DIR`；cwd 到目录名的判据住 `src/ports/host-port.ts` 的 `projectDirOfCwd`。
_Avoid_: 项目路径、cwd（那是宿主的原始路径）。

**会话目录段（session dir segment）**:
`sessions/<项目目录>/<段>` 里那一段，宿主 `encodeSegment` 的逐字镜像；无损。移入回收站把它写进条目 id，恢复照条目 id 原地回放，不从 `sessionId` 重编。
_唯一实现_: `src/shared/session-path.ts` 的 `encodeSessionSegment` / `decodeSessionSegment`；唯一调用点住 `src/trash/entry.ts` 的 `sessionDirForId` / `sessionDirSegmentOf`。
_Avoid_: 会话 id（清册身份，不拼路径）。

**缺席（absence）**:
路径「不在」的唯一判据：`stat` 抛 `ENOENT` 或 `ENOTDIR`。权限、断挂载、I/O 是**读错误，不是缺席**——要响亮失败、零写入（ADR-0039）。
_唯一实现_: `src/ports/fs-port.ts` 的 `isAbsentPath`。
_Avoid_: 不存在（口语）、读不到（那恰恰不是缺席）。

**回收站（trash）**:
被移入回收站的会话本体，住数据根 `session-trash/`，与 `sessions/` **同卷**（整目录 `rename`）；**不自动过期**。
_无单点实现_: 插件概念：清册、目录、快照与面板各司其职。

**条目（trash entry）**:
回收站里的一行。`id` = `<移入回收站时刻 UTC>-<目录段>`，回收站目录名就是它；那一段是**会话目录段**，不是原始 session id。
_无单点实现_: 线上形状住 `src/shared/apply-values.ts` 的 `TRASH_ENTRY_SCHEMA`（`src/shared/wire.ts` 派生类型）、落地形状与路径闸住 `src/trash/entry.ts`。
_Avoid_: 行、记录（太泛）。

**条目显示名（entry display name）**:
清单行、详情标题排与子会话行显示的名字。次序：子会话 label → 清册 `title` → 日志 `session/title` → 未命名兜底。
_唯一实现_: `src/client/trash-view.ts` 的 `preferredNameOf` / `detailNameOf` / `displayNameOf`；子会话行兜底住 `src/client/subagent-section.tsx` 的 `rowName`。裁决见 ADR-0058。
_Avoid_: 拿主会话的 `title` 给子会话起名（同批会撞名）。

**详情块（detail block）**:
详情正文的一格，判别联合：`user` / `assistant` / `reasoning` / `tool` / `injection` / `system` / `compaction`。只回尾部一页，块数与正文两道闸；`olderCursor` 是块序号，不是时间戳。
_唯一实现_: `src/trash/detail.ts` 的 `createDetailFold`；线上形状住 `src/shared/wire.ts` 的 `TrashDetailBlockWire`。
_Avoid_: 消息（一条消息可以拆成多个块）。

**工作步骤展示（work steps view）**:
详情的阅读档位：简洁 / 标准 / 详细 / 完全展开——同一份块的四种投影，不是四套渲染器；档位不跨会话记住。
_唯一实现_: `src/client/session-detail.tsx` 的 `ViewMode`；分组住 `src/client/detail-blocks.ts` 的 `threadItems`；自动连翻预算住 `src/client/use-detail-pager.ts` 的 `AUTO_OLDER_PAGE_LIMIT`。

**提问轨（prompt rail）**:
详情右缘的提问导航：有提问时出现，一句一格，悬停出预览，点一下补页到那句。
_唯一实现_: `src/client/prompt-rail.tsx` 的 `PromptRail`；补页与当前句住 `src/client/use-prompt-rail.ts` 的 `usePromptRail`；判据住 `src/client/use-detail-rail.ts` 的 `useDetailRail`。
_Avoid_: 轮次轨（这里按用户提问分格，不按 turn）。

**档（panel tab）**:
回收站面板里与另一档平级的一份内容（回收站档 / 归档档）：一条装配线 + 四格版面；两档状态各一份、互不读写（ADR-0060 第 4 条），差异全在 adapter。
_唯一实现_: `src/client/use-panel-tab.ts` 的 `usePanelTab` / `PanelTabAdapter`；四格版面住 `src/client/panel-tab.tsx` 的 `PanelTabFrame`；两档视图住 `src/client/trash-tab.tsx` / `src/client/archive-pane.tsx`。
_Avoid_: 标签页 / tab（宿主 tab 是导航控件）。

**未分组（ungrouped）**:
原工作区已从宿主账本删掉的条目归入的组；永远沉底。与空 cwd 的「未记录项目」不是同一件事。
_唯一实现_: `src/client/trash-view.ts` 的 `UNGROUPED_PROJECT_DIR` / `groupByProject`。

**清册（manifest）**:
条目的索引，住宿主 storage 域（介质在 `storages/`）；**内部索引、不用手碰**，外部真相是 `session-trash/` 的目录，两者由对账拉平。只记文件里真有的事实。
_无单点实现_: 活的面是宿主 storage 域；绑定住 `src/trash/manifest.ts` 的 `createStorageManifest` 与 `src/trash/storage-manifest.ts`。

**对账（reconcile）**:
真相读前先与 `session-trash/` 目录修回一致：多出的目录重建行、目录没了的摘行、认不出的当外人。幂等、零漂移零写入。
_唯一实现_: `src/trash/reconcile.ts` 的 `reconcileTrash`。

**清册读面（trash ledger）**:
清册的两条读法：真相读 `list()` 先对账再交行；`raw()` 只回清册、不对账也不写行（ADR-0012）。
_唯一实现_: `src/trash/ledger.ts` 的 `TrashLedger`。
_Avoid_: 账本（本仓「账本」指宿主工作区注册表）。

**清册作用域（trash scope）**:
purge 这条写路径的拿目标 owner：接一份清册快照、自持收缩视图，只做拿目标、把计划交给执行器；删的能力由执行器注入。
_唯一实现_: `src/verbs/trash-scope.ts` 的 `createTrashScope`。

**同批已带走集（batch carried）**:
同一批里已被前一条带走的 id：delete 的 session 域只分 fresh / carried；restore 的 entry 域由收缩视图判 carried。
_唯一实现_: `src/verbs/batch-carried.ts` 的 `createEntryCarried` / `createSessionCarried`。

**写入进度（write progress）**:
一趟写动作的遥测快照：身份（动作 + id 集）、k/N 与步骤码；写动作在到达序链上串行 ⇒ 全局一份记录无歧义，`/progress` 纯读它。生命周期随进程，宿主重启不留残留。
_唯一实现_: `src/verbs/write-progress.ts` 的 `writeProgress` / `readWriteProgress`。

**进度面（write progress face）**:
写入进度按写身份认领后的界面脸，渲染成进度行：认领上出 k/N、当前步骤与已用秒数；认领不上只说排队中（不冒领另一趟写的 k/N）；没认领到就不出进度行，按钮忙碌文案兜底。
_唯一实现_: `src/client/use-write-progress.ts` 的 `WriteProgressFace`；渲染住 `src/client/write-progress.tsx` 的 `WriteProgressLine`。

**写身份认领（write-identity claim）**:
浏览器半判定「这条进度是不是我这趟写」的机制：`action` 相同且 `ids` 与本批有交集才认领；空集名单归「没认领到」，同 action 不相交出「排队中」。
_唯一实现_: `src/client/use-write-progress.ts` 的 `claimProgress`。

**路由读面（route read）**:
路由记录上的一格：`none` / `list`（真相读）/ `raw`（索引快照）；处理函数只消费路由交来的 `RouteRead`。
_唯一实现_: `src/api/route-table.ts` 的 `RouteSpec.read` / `RouteRead`。
_Avoid_: 纯度（纯度管是否进到达序链）。

**组（group） / 组根（group root）**:
一次移入回收站带进来的父会话与在盘上、进了回收站的孩子；孩子行记 `parentEntryId`。**接得住孩子的只有组根**。
_无单点实现_: 组语义的纯函数面住 `src/trash/groups.ts`。

**会话闭包（session closure）**:
「一个根的全部后代」与「同一个会话的两代写法」的唯一口径：先 `bareSessionId` 归一，再逐层收（防环、首见去重）。组员判据是 `origin:'subagent'`（ADR-0038）。
_唯一实现_: `src/domain/closure.ts` 的 `closureOf` / `orphanRootsOf` / `firstByBare` / `bareSessionId` / `sessionIdShapes`。

**盘上后代（stranded descendants）**:
跟着父被移入回收站、但没进成回收站、仍留在 `sessions/` 的后代；与组里带进来的孩子是两件事。
_唯一实现_: `src/verbs/permanent-removal.ts` 的 `planVisibleTrash` 产出的 `VisibleTrashGroup`。

**无主子会话（orphan subagent）**:
`origin:"subagent"`、且父既不在语料也不在清册的会话；清理是永久删除，不自动跑、只由维护卡手动触发，只清会话目录、会话独占的图片副本与这些会话自己的投影缓存记录。
_唯一实现_: `src/verbs/orphan-subagents.ts` 的 `orphanGroupsOf` / `loadOrphanGroups`。

**活体（live session）**:
宿主内存里 attach 着的会话（可能带 agent handle）；**与「在跑」不是一回事**。
_无单点实现_: 宿主进程里的活会话；本插件只经身份面观察。
_Avoid_: 运行中（那是有 activity）。

**活体准入（live admission）**:
写前逐个问「现在有活动吗」（`workspace/session-activity` 非空）；任一有就整组拒绝、零副作用。什么时候查、查哪些 id 归调用方。
_唯一实现_: `src/verbs/live-admission.ts` 的 `assertNoLive`。

**永久删除（permanent removal）**:
无恢复路径的删除；三条路：purge / 清空回收站 / 无主子会话清理。计划函数只读，执行器拿到计划才动盘。
_唯一实现_: `src/verbs/permanent-removal.ts` 的 `executeRemoval` / `planTrashRemoval` / `planOrphanRemoval`。
_Avoid_: 与「彻底删除」混用（界面文案可另说，仓内统一说永久删除）。

**成员在场（member presence）**:
成员在宿主可见列表里的状态：离场 = 摘活体并发 `api-session/removed`；归位 = 目录与账本都写回后才发 `api-session/added`。
_唯一实现_: `src/verbs/member-presence.ts` 的 `createMemberPresence`；动词面形状住 `src/ports/presence-port.ts`。

**归档（archive）**:
宿主「从分组面藏掉」那一档，只反映用户自己的归档状态；**回收站不使用它**（移入回收站不调 `archiveSession`，ADR-0008）。恢复时迁移式取消归档的旧条目判据：`wasArchived:false` 且当前仍归档；`wasArchived` 只记移入回收站前的事实。
_无单点实现_: 宿主的归档位；本插件只读 + 旁路观察。

**通告（announce）**:
让客户端当场删掉 / 加回一行的两条宿主事件；冷会话没有活体可摘，通告照发。
_无单点实现_: 事件面归宿主；本仓决定何时成对触发（`src/verbs/member-presence.ts`）。

**场景（client scene）**:
浏览器半跨槽位现场的一份可实例化集合。注册面激活时安装一份；各贡献经 Provider 读同一实例；没有 Provider 时回退进程场景。**未安装即抛错**，不懒建第二份；测试每例换新。
_唯一实现_: `src/client/scene.ts` 的 `ClientScene` / `createClientScene` / `ClientSceneProvider` / `useClientScene` / `installClientScene` / `getDefaultClientScene`。

**清单状态（trash list state）**:
`useTrashQuery` 交出的唯一清单真相：`loading` / `ready(rows)` / `unknown(failure)`；`unknown` 不向下游交任何行。`refreshing` 不是第四态。
_唯一实现_: `src/client/use-trash-query.ts` 的 `useTrashQuery`。

**首帧快照（first-paint snapshot）**:
面板跨挂载留下的上一次成功读数（清单、选中、详情账本）；挂载首帧先画它，随后静默重读。只活在进程内。
_唯一实现_: `src/client/trash-snapshot.ts` 的 `readTrashSnapshot`。

**意图名（intent name）**:
首帧快照「何时丢什么」的命名动作：`reloadSucceeded` / `reloadFailed` / `emptiedTrash` / `rowGone` / `writeSucceeded` / `noteSelection`。
_唯一实现_: `src/client/trash-snapshot.ts` 的 `reloadSucceeded` / `reloadFailed` / `emptiedTrash` / `rowGone` / `writeSucceeded` / `noteSelection`。

**详情账本（detail ledger）**:
按行身份记下的已成功读到的详情；两档各持一份、互不读写。上限与淘汰口径只有一条。
_唯一实现_: `src/client/detail-ledger.ts` 的 `DetailLedger` / `writeDetail` / `DETAIL_LEDGER_LIMIT`。

**详情保持（detail hold）**:
换到还没读过的条目时，详情先继续画上一条已就绪的那一帧（正文 `inert` + `aria-busy`）；不是骨架。
_唯一实现_: `src/client/use-detail-reader.ts` 的 `useDetailReader` / `DetailState`。

**意图预取（intent prefetch）**:
hover / focus 过预设延时才读，连续划过只认最后一次；只热身账本，不动选中。
_唯一实现_: `src/client/use-prefetch.ts` 的 `useDelayedPrefetch`。

**写入座位（write seat）**:
一次写入发生在哪个界面位置，就在哪个座位绑定呈现材质、闸与重读通道；各座位共用一条生命周期。
_唯一实现_: `src/client/write-seats.ts` 的 `deleteSessionFromMenu` / `restoreFromPanel` / `purgeFromPanel` / `unarchiveFromArchiveTab`。

**回执摘要（receipt summary）**:
`/apply` 回执的读法与摘要：落地 id、中性失败、逐条失败与附件读数一次派生。
_唯一实现_: `src/client/receipt.ts` 的 `summarizeReceipt`。

**顶层浮层（top layer）**:
文档序里最上层的模态对话框与菜单；Esc 的归属判据（清单只问有没有，它自己不是其中一员）。
_唯一实现_: `src/client/ui/top-layer.ts` 的 `hasTopLayer` / `isTopLayer`。

**重开等待（pending open）**:
移入回收站 / 恢复后等目标重新出现在清单里再打开：一张票、一条订阅、一个放弃 timer，不轮询。
_唯一实现_: `src/client/pending-open.ts` 的 `createPendingOpen`。

**孩子视图（child view）**:
两档详情正在看某个孩子时的离清单导航态：主体切到孩子，清单选中仍在父行；单级，返回回到父的详情。
_唯一实现_: `src/client/use-trash-panel-controller.ts` 的 `childView`；`src/client/use-archive-panel-controller.ts` 的 `ArchiveChildView`；收尾顺序、返回两程与导航面住 `src/client/use-panel-child-view.ts` 的 `usePanelChildView`。
_Avoid_: 下钻（那专指窄档清单→详情）。

**后发读赢（latest-wins）**:
同一类异步读里只有最新发起的那次允许落地；只做 compare-and-set。重读节奏与清单读路都投影它。
_唯一实现_: `src/client/store.ts` 的 `createLatestWins`；消费者 `src/client/use-gated-refresh.ts` / `src/client/use-panel-list-read.ts`。
_Avoid_: 防抖、节流（它不改变发起时机）。

**拖放移入回收站（drag to trash）**:
会话行拖到侧栏「回收站」入口松手即移入回收站：不弹确认框，撤销横幅兜底；payload 是宿主拖拽写进 `text/plain` 的 session id，未登记 id 静默忽略；拒收（运行中的行、写入被拒）是**动效**不是状态——抖动 + 原因胶囊，「移不进回收站」只有一套视觉；拖的行在多选勾选集里时一拖把整集移入回收站。
_唯一实现_: `src/client/trash-drop.ts` 的 `DropPlan` / `resolveDropPlan`；状态机 `src/client/drop-machine.ts` 的 `createDropTargetMachine`；投放面 `src/client/trash-entry.tsx` 的 `TrashPanelIcon`。
_Avoid_: 拖拽回收（是移入回收站不是归档）、拖拽彻底删除（永久删除永远走确认框）。

**范围勾选（range check）**:
多选模式内 Shift+点把「锚点→目标」整段并入勾选（不替换、不反勾）；锚点 = 最近一次单条勾 / 取消的那条，锚点缺失或不可见就退化成单条；范围只跨可见行。
_唯一实现_: `src/client/batch-selection-store.ts` 的 `toggleRange` / `toggleRangePick`；`src/client/use-list-selection.ts` 的 `rangeCheck`；宿主列表的分派 `src/client/batch-pick.ts` 的 `rangePick`。
_Avoid_: 范围选择（与「选中看详情」的「选中」撞词）。
