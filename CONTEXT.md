# CONTEXT.md — dsh-session-delete

本仓的**领域词表**。这里只回答「这个词在本仓指什么、别用什么词」；行为判据住代码与测试，架构形状住 `docs/architecture.md`，界面规格住 `docs/ui-spec.md`，难逆的裁决住 `docs/adr/`。

探索代码前先读这一份：代码里的命名以它为准。要引入一个这里没有的词，先想清楚是不是在发明本仓不用的语言。**哪条事实住哪个家，见 `docs/architecture.md` §4 的唯一主人清单**；本文不重复那张表。

## 这是什么

在宿主里**删除会话**：删除 = 移入回收站（可恢复），另设显式的彻底删除；回收站之外还有两类**手动**维护的存量：**无主子会话**与**孤儿附件**。两半：**Node 半**（动盘、动清册、动宿主服务）与**浏览器半**（槽位里的界面）。

## 名词

**数据根（home）**:
宿主运行时数据根：显式配置 > `$DSH_HOME`（空白视为未设）> `~/.dsh`。插件只镜像后两级；解析住 `src/ports/home.ts`。
_唯一实现_: `src/ports/home.ts` 的 `resolveHome`。

**通道（channel）**:
浏览器半到 Node 半的取数路径：同源 fetch 宿主 `connection.fetch.register` 的 exact Fetch 路由（`/api` + 插件前缀）。Host/Origin/浏览器认证归宿主 `/api` bridge；支持面是 web UI 与桌面端，二者的标准组合都装 `client-connection`，没有旧前缀 fallback。段名前缀与唯一基础路径住 `src/shared/wire.ts`；客户端探测与附件 URL 住 `src/client/remote.ts` / `src/client/attachment-view.tsx`。
_唯一实现_: `src/api/connection-route.ts` 的 `registerConnectionRoutes`；`src/client/remote.ts` 的 `createHttpRemote` / `probeChannel`。
_Avoid_: 接口、API（太泛；通道专指这条双半取数线）；fallback / 旧前缀（已随单通道收掉）。

**会话（session）**:
宿主持久化的一条对话。落盘为 `sessions/<项目目录>/<会话目录>/session.vN.jsonl.zstd`——zstd **多帧**，第一行是 header（含 `id` 与 `cwd`）；一个目录里可以并存多代日志，只读版本号最大的那代（`src/log/session-log.ts`）。
_Avoid_: 对话、聊天记录（那是用户视角的内容，不是持久化单位）。

**附件（attachment）**:
会话消息里的 `image` / `file` block，指向宿主附件库里的一个内容寻址对象；不是用户磁盘上的原图。读取优先走宿主 `attachments` 服务的 `readImage` / `readFileStream`（ADR-0035）；服务缺席或引用元数据不够才直接 fs。
_唯一实现_: `src/trash/attachments.ts` 的 `attachmentsInContent`；读取面 `src/ports/attachments-port.ts` 的 `createAttachmentsPort` 与 `src/api/attachment.ts` 的 `readAttachmentResponse`。

**附件库（attachment store）**:
`$DSH_HOME/attachments/v1`：图片在 `objects/`，普通文件在 `file-objects/` + `files/`。宿主所有、没有删除接口。
_Avoid_: 缓存（它是宿主持久副本；派生请求缓存在 `cache/attachments`）。

**附件引用（attachment reference）**:
会话消息 `content[]` 里指向附件库对象的 `image` / `file` block；`attachmentId` 是唯一寻址依据，`name` 只做下载名。
_唯一实现_: `src/trash/attachments.ts` 的 `attachmentsInContent`。

**同源取数闸（same-origin fetch gate）**:
只挂附件字节段的浏览器取数约束：拒 `Sec-Fetch-Site` 为 same-site / cross-site 的请求，以及与 Host 头不同 authority 的 http(s) Origin / Referer；桌面壳的 `dsh-app:` 来源与三头全缺的非浏览器客户端放行。拒绝回 403 + 失败信封。只挂这一段是因为只有它的响应能被别的页面当 `<img>` 渲染（字节 oracle）；其余八段是 JSON，跨源读不到。
_唯一实现_: `src/api/connection-route.ts` 的 `isSameOriginFetch`；声明住 `src/api/route-table.ts` 的 `fetchGate`。
_Avoid_: 请求栅栏（旧概念已随 ADR-0033 删除；这里只收字节 oracle，不做身份 / 归属判定）。

**可调项（config）**:
宿主 profile 的 patch 层里给本插件的三只旋钮（孤儿预览条数 / 附件响应上限 / JSON 扫描上限）；不是界面设置，也不跨到浏览器半。
_唯一实现_: `src/config.ts` 的 `DEFAULT_CONFIG` / `normalizeConfig` / `Config`（Standard Schema）；`apply` 归一一次后作为 `CoreDeps.config` 注入，读方从 deps 读。
_Avoid_: 设置（界面设置页）、环境变量（配置只走宿主的 patch 层，ADR-0037）。

**引用扫描（reference scan）**:
判断图片对象是否仍被引用：读全部会话日志、全部 `session-trash` 目录与 `storages` / `cache` JSON；任一读不出就按"不可知"处理，删除整体跳过（fail closed）。
_唯一实现_: `src/trash/attachments.ts` 的 `imageIdsOfDir` / `collectRemainingImageRefs`。

**独占附件（exclusive attachment）**:
被本次永久删除的会话引用、且剩余任何会话/派生存储都不再引用的图片对象。只删这一种。
_唯一实现_: `src/trash/attachments.ts` 的 `planImageAttachmentRemoval`。

**孤儿附件（orphan attachment）**:
`$DSH_HOME/attachments/v1/objects` 下、任何引用源（全部会话日志 + 全部 `session-trash` 目录 + `storages` / `cache` JSON）都不再引用的图片对象。只由插件设置页的维护卡手动检查与清理；只删这些 `.dsh` 内的图片副本，源文件与共享引用不在其中。
_唯一实现_: `src/trash/attachments.ts` 的 `scanOrphanImageAttachments` / `cleanOrphanImageAttachments`。
_Avoid_: 无主附件（父会话不在的是「无主子会话」；孤儿附件说的是"没有任何引用"）。

**附件清理（attachment cleanup）**:
永久删除或孤儿附件清理时，按计划删掉 `.dsh` 内独占 / 无引用的图片副本；不碰源文件、普通文件与共享引用。
_唯一实现_: `src/trash/attachments.ts` 的 `executeImageAttachmentRemoval` / `cleanOrphanImageAttachments`。

**项目目录（`projectDir`）**:
宿主 `projectKey(cwd)` 的产物（`--…--` 裹边、分隔符折成 `-`、非分隔符走 `~XXXX` 转义）。**有损**：分隔符那段拆不回真实路径。
_Avoid_: 项目路径、cwd（那是宿主的原始路径；`projectDir` 是有损编码）。

**缺席（absence）**:
路径「不在」的唯一判据：`stat` 抛 `ENOENT` 或 `ENOTDIR`。权限、断挂载、I/O 等**读错误不是缺席**——那是"我们看不见"，要响亮失败、零写入，不许折成"没有"（ADR-0039）；引用扫描的「根不存在」仍按没有引用源处理。`FsPort.exists` 与 `rename` 的目标检查共用这一判据。
_唯一实现_: `src/ports/fs-port.ts` 的 `isAbsentPath`（`src/trash/attachments.ts` 的 `isMissing` 是它的别名）。
_Avoid_: 不存在（口语；判据只认那两种错误码）、读不到（那是读错误，恰恰**不是**缺席）。

**回收站（trash）**:
被删除会话的本体，住在数据根的 `session-trash/` 下，与 `sessions/` **同卷**（搬移靠整目录 `rename`，原子）。**不自动过期**；清空是显式动作。手工翻回收站目录时看到比清单多的目录，那是跟着父进来的子会话，各有自己的条目。
_Avoid_: 垃圾桶、删除列表（会把它说成一个 UI 或一个临时缓存）。

**条目（trash entry）**:
回收站里的一行。`id` = `<删除时刻 UTC>-<原目录名>`，**回收站目录名就是它**，恢复也靠它反推原目录名。形状与路径闸住 `src/trash/entry.ts`。
_Avoid_: 行、记录（太泛；条目专指回收站里的一行）。

**详情块（detail block）**:
回收站详情正文的一格，判别联合：`user` / `assistant` / `reasoning` / `tool` / `injection` / `system` / `compaction`。`tool` 由 `tool/call` 建块、`tool/result` 按 `callId` 回填；turn/step/job/request 这类簿记事件不成块。每次只回尾部一页，页有块数与正文总量两道闸（单块另有字符闸）；`olderCursor` 是块在日志里的序号（分页边界），不是时间戳。
_唯一实现_: `src/trash/detail.ts` 的 `readTrashDetail` / `PageBuilder`；线上形状住 `src/shared/wire.ts` 的 `TrashDetailBlockWire`。
_Avoid_: 消息（消息是日志里的 `user/message` / `assistant/message`；一条消息可以拆成多个块，工具块来自 `tool/call` 而不是 assistant content）。

**清册（manifest）**:
条目的索引，住在宿主 storage 域（介质在数据根下的 `storages/`）。它是**内部索引、不用手碰**；外部真正的事实来源是 `session-trash/` 里那些目录，两者由**对账**拉平。清册只记文件里真有的事实：随盘上随时变的数（还剩几个孩子、这次释放多少）现算现给、不落清册。
_Avoid_: 索引、数据库（清册是宿主 storage 域里的内部索引，但不是一个可查询的数据库）。

**对账（reconcile）**:
真相读由 `src/trash/ledger.ts` 的 `list()` 先与 `session-trash/` 的目录修回一致：多出的目录重建出行、目录没了的行摘掉、认不出的当外人（不动也不列）。幂等，且**零漂移零写入**；判据住 `src/trash/reconcile.ts`。谁走真相读、谁走 `raw()` 见 `docs/architecture.md` §4 与 ADR-0012。

**清册读面（trash ledger）**:
清册的两条读法：**真相读** `list()` 先对账再交行；**raw 索引** `raw()` 只回清册、不对账也不写行。谁走哪条见 `docs/architecture.md` §4 与 ADR-0012。
_唯一实现_: `src/trash/ledger.ts` 的 `TrashLedger`。
_Avoid_: 账本（本仓「账本」指宿主工作区注册表；清册读面不要与它混用）。

**路由读面（route read）**:
路由记录上的一格：`none` / `list`（真相读，先对账）/ `raw`（索引快照，不对账）。读段与 `/empty` 的处理函数只消费路由交来的 `RouteRead`，不自己挑 `ledger.list()` / `raw()`；`/apply` 的写动词读面归动词自己（谁写谁读）。
_唯一实现_: `src/api/route-table.ts` 的 `RouteSpec.read` 与 `RouteRead`（由 `src/api/dispatch.ts` 交出去）。
_Avoid_: 纯度（纯度管是否进到达序链；`count` 是 pure/不读，`detail` 是 pure/raw）。

**清册作用域（trash scope）**:
一份调用方选好读面的清册快照上的收缩视图——purge 这条写路径的「拿目标」owner。写入口 = 真相读；报告入口不经作用域（`/orphans` 直接把 raw 快照交 `loadOrphanGroups`）。**选哪一格由调用方（路由行 / 批量层）定好交进来**（ADR-0012 的边界）；组与收缩视图归它且**不外露**（三态与按组收缩的判据是内部闭包，读「组」的 `claimOf` / `withoutGroup`）：`purge(id)` 只收一个 id（选组、同批带走的幂等、`trash-empty` 的原文点名都在它里面），`purgeAll()` 清全部行，`orphanGroups(roots?)` 把当前视图原样交给「无主子会话」的扫描。
_唯一实现_: `src/verbs/trash-scope.ts` 的 `createTrashScope`。
_Avoid_: purge-trash（三行 glue 已被作用域吸收；「彻底删除」说的是动作，不是模块）。

**同批已带走集（batch carried set）**:
同一次 `/apply` 里已经被前一条带走的 id。删除按会话 id 记（会话 id 域按「会话闭包」的 `bareSessionId` 归一后再记），恢复按条目 id 记，各一个 adapter；它决定这一条还该不该交给动词，purge 那一半连同收缩中的当前视图（盘上后代要按清册里还在的 id 排除）住「清册作用域」。组语义仍读「组」。**不要也叫「账本」**：本仓的「账本」指宿主工作区注册表（`workspaceOf` / `attach` / `detach`），是另一件事。
_唯一实现_: `src/verbs/batch-carried.ts`
_Avoid_: 账本（同批集合不要与宿主工作区注册表混用）。

**组（group） / 组根（group root）**:
一次删除搬进来的父会话与**在盘上、进了回收站**的孩子。孩子那行记 `parentEntryId` 指向父那行的 id。判据只有一条：**接得住孩子的只有组根**——自己不记 `parentEntryId` 的那一行；父行不在、或父行自己也是孩子时，孩子必须自己占一行。**组的闭包按组根算，不按直接孩子算**（`kind:'parent'` 一次问一层，问到问空为止）。组语义住 `src/trash/groups.ts`。
_Avoid_: 批次、集合（组是删除时一起搬进来的成员关系；批次是操作单位）。

**会话闭包（session closure）**:
「一个根的全部后代」与「同一个会话的两代写法」的唯一口径：比对一律先把 id 去掉 `session-` 前缀（`bareSessionId`；一个 id 的全部写法由 `sessionIdShapes` 给出，逐层问宿主时按写法问），闭包在 parent(bare) 到 children 的索引上逐层收（深度不设上限、防环、首见去重）。`closureOf` 收单根闭包，`orphanRootsOf` 在整表语料上收「父既不在语料也不在清册」的根闭包组，`firstByBare` 是按首见去重的唯一写法。端口保留「一层一次宿主调用」的 adapter 职责（`descendantsByParent`），动词保留各自的对象映射——闭包本体不再有第二份实现。组员的判据是 `origin:'subagent'`：普通 fork 的 `parentSession` 只是来源记录——闭包不把 fork 收作组员、也不穿过它，但 fork 自己做根时它的 subagent 孩子照常算成员（ADR-0038）。
_唯一实现_: `src/domain/closure.ts` 的 `closureOf` / `orphanRootsOf` / `firstByBare` / `bareSessionId` / `sessionIdShapes`。
_Avoid_: 传递闭包、bare id 去重（算法名与实现细节可以出现在注释里说明为什么，命名与词条只说「会话闭包」）。

**盘上后代（stranded descendants）**:
跟着父被删、但**没进回收站**、仍留在 `sessions/` 上的后代（级联落地之前删掉的那些存量）。与「组里带进来的孩子」是两件事，界面上各说各的，不许一个冒充另一个。
_唯一实现_: `src/verbs/permanent-removal.ts` 的 `planTrashRemoval`（`PlannedTrashRow` 的 `strandedCount`）。

**无主子会话（orphan subagent）**:
`origin:"subagent"`、且父**既不在语料也不在清册**的会话。清理是**永久删除**——不搬进回收站、**不自动**跑，且只清会话目录与会话独占的图片附件副本（投影缓存不在范围内；共享图片保留，判据见 ADR-0020）；检查与清理只由插件设置页的维护卡手动触发，回收站面板不再扫描它（ADR-0021）。根闭包组的纯核心在「会话闭包」（`src/domain/closure.ts` 的 `orphanRootsOf`）——`orphanGroupsOf` 是按语料对象映射的薄包装，归堆与去重两边都去 `session-` 前缀。组内后代同样只收 `origin:'subagent'` 的会话；闭包不穿过普通 fork（ADR-0038）。
_唯一实现_: `src/verbs/orphan-subagents.ts` 的 `orphanGroupsOf` / `loadOrphanGroups`。

**活体（live session）**:
宿主内存里 attach 着的会话。删除 / 彻底删除 / 孤儿清理遇到成员在跑 ⇒ **整组拒绝、零副作用**；「在跑就整组拒绝」的判据住 `src/verbs/live-admission.ts`，删除时把 session 与它的 agent handle 一起摘掉（见 ADR-0008）。
_Avoid_: 运行中（“运行中”可能指 agent 正在跑；活体指宿主内存里 attach 着的会话）。

**活体准入（live admission）**:
一次写之前逐个问「这个会话在宿主内存里 attach 着吗」；任一在跑就整组拒绝、零副作用，原文点名那一个会话。**什么时候查、查哪些 id 归调用方**——永久删除的时机住 `docs/architecture.md` §4「永久删除的计划与执行」行（ADR-0027），删除与孤儿清理各自交名单。
_唯一实现_: `src/verbs/live-admission.ts` 的 `assertNoLive`。
_Avoid_: 安全检查（太泛；这里专指写之前那一次逐个问活体）。

**永久删除（permanent removal）**:
没有恢复路径的删除。仅有的三条路径是单条 / 批量 purge、清空回收站、无主子会话清理；都走 `/apply` 或 `/empty`，不自动过期。
_唯一实现_: `src/verbs/permanent-removal.ts` 的 `executeRemoval`（计划侧 `planTrashRemoval` 与 `planOrphanRemoval`）。
_Avoid_: 彻底删除与永久删除混用（本仓统一说「永久删除」；界面文案可以另说）。

**永久删除计划（permanent removal plan）**:
一次永久删除之前要记下的全部事实：哪些**成员**（含盘上后代）与目录要删、各自**实测**多少字节、哪些会话要退归档集 / 摘账本，以及**活体准入**。计划函数**只读**；执行器拿到计划后才动盘，不再量；第一笔写前的活体复查见「活体准入」。purge 与 orphan-clean 共用这一对；journal 不参与永久删除（它只服务有反向动作的一次成员移动）。计划与执行住 `src/verbs/permanent-removal.ts`（成功回执的字节念计划、执行期只记进度）；**活体准入的判据**住 `src/verbs/live-admission.ts`。裁决见 ADR-0027。

**成员在场（member presence）**:
一个成员在宿主可见列表里的状态。**离场** = 摘活体（session + agent）并如实发 `api-session/removed`；**归位** = 目录 / 账本两件写都回去后才发 `api-session/added`。判据与成对通告住 `src/verbs/member-presence.ts`；动词经 `CoreDeps.presence` 的 `PresenceCapability` 调用（端口形状住 `src/ports/presence-port.ts`）。批量恢复仍由 `src/verbs/batch.ts` 发起一次 `announceRestored(ids)`（单条就是长度为 1 的批，ADR-0014）。
_唯一实现_: `src/verbs/member-presence.ts` 的 `createMemberPresence`（动词面形状住 `src/ports/presence-port.ts`）。

**归档（archive）**:
宿主「从分组面藏掉」那一档，只反映**用户自己**的归档状态；**回收站不使用它**（删除不调 `archiveSession`，见 ADR-0008）。旧版本删除留下的归档态条目在恢复时迁移式取消归档；`wasArchived` 只记删除前的事实。
_Avoid_: 隐藏、回收站（归档不是删除，回收站也不是归档）。

**通告（announce）**:
让客户端**当场**删掉/加回一行的两条宿主事件（`api-session/removed` / `api-session/added`）。冷会话没有活体可摘，通告照样必须发。
_Avoid_: 通知、事件（太泛；通告专指这两条成对的客户端事件）。

**渲染侧快照（visible-rows snapshot）**:
宿主行槽位登记这份行列表在渲染期交出的读数：脏了才重读，干净时回同一个引用；变化由槽位组件的挂载 / 注销与登记值更新通告，不靠定时重读，也不观察 DOM。判据与裁决见 ADR-0034。
_Avoid_: 缓存（这里只讲「同一引用」这条 snapshot 契约，不是通用缓存）；轮询（没有定时器在重读登记）；DOM 扫描（可见行不再从 DOM 反查）。
_唯一实现_: `src/client/host-rows.ts` 的 `useVisibleSelectableRows`（订阅骨架住 `src/client/store.ts` 的 `createLazyStore`）。

**批量选择动作（batch pick）**:
可见行之上的一组选择动作：全选、全选判定与模式内整行点击守卫；可见行的事实源仍是槽位登记，选中集仍住选择 store。
_唯一实现_: `src/client/batch-pick.ts` 的 `selectAllVisible` / `areAllVisibleRowsSelected` / `useSelectionRowClickGuard`。
_Avoid_: 选择面（选中集与多选态住 `src/client/batch-selection-store.ts`；这里说的是动作）；DOM 行枚举（可见行来自槽位登记，ADR-0034）。

**重开等待（pending reopen）**:
撤销恢复后等客户端摘要表出现目标会话、再 `openSession` 的那一段；订阅驱动，最多等一个放弃边界，不轮询。
_唯一实现_: `src/client/pending-open.ts` 的 `createPendingOpen`。
_Avoid_: 轮询、定时重开（等待由 store 通知驱动；ADR-0036）。

**顶层浮层（top layer）**:
挂在文档上的模态对话框与菜单的总称，也是「谁在最上层收 Escape」的判据：名单按文档序，最后一个就是最上层。`Modal` 的关闭键与清单的 Esc 退下钻都问它，不各写一份选择器。
_唯一实现_: `src/client/ui/top-layer.ts`。
_Avoid_: 弹窗（太泛；这里专指名单上那两类与「最上层」判据）。

**清单状态（trash list state）**:
`useTrashQuery` 交出的唯一清单真相：`loading`（还没读到）/ `ready(rows)`（有行）/ `unknown(failure)`（读不到）。`unknown` 不向下游交出任何行——选择、导航、分组与页脚动作都不再读旧行；清空失败同样落 `unknown`。
_唯一实现_: `src/client/use-trash-query.ts`。
_Avoid_: 缓存、空清单（`unknown` 不是空，`ready([])` 才是空）。

**维护卡（maintenance card）**:
插件设置页（`plugins.bundle.config`，按 bundle 包名寻址）里的一张卡，装两段手动维护：孤儿会话与孤儿附件。检查只读、清理过确认框、清完自动重查；挂载不发请求，没有定时器。
_唯一实现_: `src/client/maintenance-settings.tsx` 的 `MaintenanceSettings`（读数与动作住 `src/client/use-maintenance.ts` 的 `useMaintenance`）。
_Avoid_: 设置面板、清理任务（「面板」专指回收站面板；这里没有自动任务）。

**写入座位（write seat）**:
一次 `/apply` 写入发生在哪个界面位置：菜单删除、批量删除、外部撤销恢复、面板恢复 / 永久删除。座位拥有自己的呈现材质、闸与重读通道；逐条收尾顺序与 `anySuccess` 门仍住 `src/client/write-settlement.ts`，busy 的生命周期住 `src/client/busy-gate.ts`。
_唯一实现_: `src/client/write-seats.ts`。
_Avoid_: 写入入口、按钮处理（座位说的是一个界面位置的整趟材质，不是某颗控件的回调）。

**回执摘要（receipt summary）**:
一次写 `/apply` 回执的唯一派生物：成功 id、失败表、中性 id、失败 verdict、部分计数、按动作取的相关落地 id（delete 的条目 id / restore 的回盘会话 id）、跨 `ok` 相加的附件清理读数（`skipped` 取第一条）与 `anySuccess`。写入座位与收尾只消费摘要，不再各自 walk `verdicts`。
_唯一实现_: `src/client/receipt.ts` 的 `summarizeReceipt`。
_Avoid_: 回执（写回执的原始 `Receipt` 仍住 `src/client/receipt.ts`，是摘要的输入，不是调用方的读法）；`count` 的逐条数值仍由 `src/client/batch-select.tsx` 的 `fetchCounts` 读 `verdicts`，它不产摘要。

**待确认动作（pending action）**:
面板状态机里等待确认的一条 / 一批 / 整站动作；控制器拥有 `pending`、`pendingEntries` 与 request 意图，确认框只渲染。
_唯一实现_: `src/client/use-trash-panel-controller.ts`。
_Avoid_: 确认框状态（框只管呈现；开合与关框规则不在视图里）。

**孩子视图（child view）**:
回收站详情正在看某个子条目时的离清单导航态：详情主体切到孩子（同一套元信息、正文与分页），清单选中仍在父行，组动作仍按整组；单级，返回回到清单选中那条的详情。入口是父详情的「子会话」段（裁决见 ADR-0029）。
_唯一实现_: `src/client/use-trash-panel-controller.ts` 的 `childView`。
_Avoid_: 下钻（下钻专指窄档清单→详情那一层，孩子视图在详情内部）；子会话详情页（不是新页面或新段，只是详情主体换人）。

**后发读赢（latest-wins）**:
同一类异步读里只有最新发起的那次允许落地；晚到的旧响应直接丢弃。它只做 compare-and-set，不拥有防抖、轮询、定时器或焦点策略。
_唯一实现_: `src/client/store.ts` 的 `createLatestWins`。
_Avoid_: 防抖、节流（后发读赢不改变发起时机，只裁决谁落地）。

**引用归一（latest ref）**:
输入允许逐渲染换新对象，回调只经一枚 ref 读最新那一份：依赖它的回调身份恒稳，可安全进 effect 依赖。「输入必须是稳定引用」的隐式契约由它消除。
_唯一实现_: `src/client/store.ts` 的 `useLatest`。
_Avoid_: 稳定引用契约（那正是被它消除的隐式契约）；缓存（它不缓存计算，只指向最新输入）。
