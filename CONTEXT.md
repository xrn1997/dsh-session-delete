# CONTEXT.md — dsh-session-delete

本仓的**领域词表**。这里只回答「这个词在本仓指什么、别用什么词」；行为判据住代码与测试，架构形状住 `docs/architecture.md`，界面规格住 `docs/ui-spec.md`，难逆的裁决住 `docs/adr/`。

探索代码前先读这一份：代码里的命名以它为准。要引入一个这里没有的词，先想清楚是不是在发明本仓不用的语言。**哪条事实住哪个家，见 `docs/architecture.md` §4 的唯一主人清单**；本文不重复那张表。

## 这是什么

在宿主里**删除会话**：删除 = 移入回收站（可恢复），另设显式的彻底删除；回收站之外还有两类**手动**维护的存量：**无主子会话**与**孤儿附件**。两半：**Node 半**（动盘、动清册、动宿主服务）与**浏览器半**（槽位里的界面）。

## 名词

**数据根（home）**:
宿主运行时数据根：显式配置 > `$DSH_HOME`（空白视为未设）> `~/.dsh`。插件只镜像后两级；解析住 `src/ports/home.ts`。
_唯一实现_: `src/ports/home.ts` 的 `resolveHome`。

**会话（session）**:
宿主持久化的一条对话。落盘为 `sessions/<项目目录>/<会话目录>/session.vN.jsonl.zstd`——zstd **多帧**，第一行是 header（含 `id` 与 `cwd`）；一个目录里可以并存多代日志，只读版本号最大的那代（`src/log/session-log.ts`）。
_Avoid_: 对话、聊天记录（那是用户视角的内容，不是持久化单位）。

**附件（attachment）**:
会话消息里的 `image` / `file` block，指向宿主附件库里的一个内容寻址对象；不是用户磁盘上的原图。
_唯一实现_: `src/trash/attachments.ts` 的 `attachmentsInContent`。

**附件库（attachment store）**:
`$DSH_HOME/attachments/v1`：图片在 `objects/`，普通文件在 `file-objects/` + `files/`。宿主所有、没有删除接口。
_Avoid_: 缓存（它是宿主持久副本；派生请求缓存在 `cache/attachments`）。

**附件引用（attachment reference）**:
会话消息 `content[]` 里指向附件库对象的 `image` / `file` block；`attachmentId` 是唯一寻址依据，`name` 只做下载名。
_唯一实现_: `src/trash/attachments.ts` 的 `attachmentsInContent`。

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

**回收站（trash）**:
被删除会话的本体，住在数据根的 `session-trash/` 下，与 `sessions/` **同卷**（搬移靠整目录 `rename`，原子）。**不自动过期**；清空是显式动作。手工翻回收站目录时看到比清单多的目录，那是跟着父进来的子会话，各有自己的条目。
_Avoid_: 垃圾桶、删除列表（会把它说成一个 UI 或一个临时缓存）。

**条目（trash entry）**:
回收站里的一行。`id` = `<删除时刻 UTC>-<原目录名>`，**回收站目录名就是它**，恢复也靠它反推原目录名。形状与路径闸住 `src/trash/entry.ts`。
_Avoid_: 行、记录（太泛；条目专指回收站里的一行）。

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

**请求栅栏（request trust fence）**:
打到 `/dsh-session-delete-api` 的请求归不归本插件办，两件事分开说：**归属**（Host 是否属于本次部署——回环名 / 监听 bind 字面量）与**身份**（远程客户端是否带宿主已认证的 Web 身份，承宿主 `connection` 服务）。裁决三词：`allowed` / `untrusted`（归属不对）/ `unauthenticated`（归属对、缺身份），两条 403 原文按裁决各回各的。Origin / Referer 只是附加约束，与 Host 同名不构成归属证明。
_唯一实现_: `src/api/request-trust.ts` 的 `judgeRequest`（身份面住 `src/ports/connection-port.ts` 的 `ConnectionPort`）。裁决见 ADR-0022 / ADR-0023。
_Avoid_: 同源栅栏（归属不看 Origin 同不同名；DNS rebinding 下同名照样是外人）；认证 / 登录（身份承宿主，插件不建立也不校验凭据）。

**同批已带走集（batch carried set）**:
同一次 `/apply` 里已经被前一条带走的 id。删除按会话 id 记、恢复/彻底删除按条目 id 记，各一个 adapter；它决定这一条还该不该交给动词，entry 适配另交 purge 一份收缩中的当前只读视图（盘上后代要按清册里还在的 id 排除）。组语义仍读「组」。**不要也叫「账本」**：本仓的「账本」指宿主工作区注册表（`workspaceOf` / `attach` / `detach`），是另一件事。
_唯一实现_: `src/verbs/batch-carried.ts`
_Avoid_: 账本（同批集合不要与宿主工作区注册表混用）。

**组（group） / 组根（group root）**:
一次删除搬进来的父会话与**在盘上、进了回收站**的孩子。孩子那行记 `parentEntryId` 指向父那行的 id。判据只有一条：**接得住孩子的只有组根**——自己不记 `parentEntryId` 的那一行；父行不在、或父行自己也是孩子时，孩子必须自己占一行。**组的闭包按组根算，不按直接孩子算**（`kind:'parent'` 一次问一层，问到问空为止）。组语义住 `src/trash/groups.ts`。
_Avoid_: 批次、集合（组是删除时一起搬进来的成员关系；批次是操作单位）。

**盘上后代（stranded descendants）**:
跟着父被删、但**没进回收站**、仍留在 `sessions/` 上的后代（级联落地之前删掉的那些存量）。与「组里带进来的孩子」是两件事，界面上各说各的，不许一个冒充另一个。
_唯一实现_: `src/verbs/permanent-removal.ts` 的 `planTrashRemoval`（`PlannedTrashRow` 的 `strandedCount`）。

**无主子会话（orphan subagent）**:
`origin:"subagent"`、且父**既不在语料也不在清册**的会话。清理是**永久删除**——不搬进回收站、**不自动**跑，且只清会话目录与会话独占的图片附件副本（投影缓存不在范围内；共享图片保留，判据见 ADR-0020）；检查与清理只由插件设置页的维护卡手动触发，回收站面板不再扫描它（ADR-0021）。
_唯一实现_: `src/verbs/orphan-subagents.ts` 的 `orphanGroupsOf` / `loadOrphanGroups`。

**活体（live session）**:
宿主内存里 attach 着的会话。删除 / 彻底删除 / 孤儿清理遇到成员在跑 ⇒ **整组拒绝、零副作用**；「在跑就整组拒绝」的判据住 `src/verbs/live-admission.ts`，删除时把 session 与它的 agent handle 一起摘掉（见 ADR-0008）。
_Avoid_: 运行中（“运行中”可能指 agent 正在跑；活体指宿主内存里 attach 着的会话）。

**活体准入（live admission）**:
一次写之前逐个问「这个会话在宿主内存里 attach 着吗」；任一在跑就整组拒绝、零副作用，原文点名那一个会话。**什么时候查、查哪些 id 归调用方**——永久删除仍把准入放在计划里、在任何写之前（ADR-0006）。
_唯一实现_: `src/verbs/live-admission.ts` 的 `assertNoLive`。
_Avoid_: 安全检查（太泛；这里专指写之前那一次逐个问活体）。

**永久删除（permanent removal）**:
没有恢复路径的删除。仅有的三条路径是单条 / 批量 purge、清空回收站、无主子会话清理；都走 `/apply` 或 `/empty`，不自动过期。
_唯一实现_: `src/verbs/permanent-removal.ts` 的 `executeRemoval`（计划侧 `planTrashRemoval` 与 `planOrphanRemoval`）。
_Avoid_: 彻底删除与永久删除混用（本仓统一说「永久删除」；界面文案可以另说）。

**永久删除计划（permanent removal plan）**:
一次永久删除之前要记下的全部事实：哪些**成员**（含盘上后代）与目录要删、各自**实测**多少字节、哪些会话要退归档集 / 摘账本，以及**活体准入**。计划函数**只读**；执行器拿到计划后才动盘，只写、不再量、不再判活体。purge 与 orphan-clean 共用这一对；journal 不参与永久删除（它只服务有反向动作的一次成员移动）。计划与执行住 `src/verbs/permanent-removal.ts`（成功回执的字节念计划、执行期只记进度）；**活体准入的判据**住 `src/verbs/live-admission.ts`，计划只决定它在任何写之前跑。裁决见 ADR-0006。

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
宿主 DOM 这个组件树之外的事实源，在渲染期交出的读数：脏了才重读，干净时回同一个引用；变化由适配器里的观察者通告，不靠定时重读。判据与裁决见 ADR-0015。
_Avoid_: 缓存（这里只讲「同一引用」这条 snapshot 契约，不是通用缓存）；轮询（没有定时器在重读 DOM）。
_唯一实现_: `src/client/host-rows.ts` 的 `useVisibleSelectableRows`（订阅骨架住 `src/client/store.ts` 的 `createLazyStore`）。

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

**后发读赢（latest-wins）**:
同一类异步读里只有最新发起的那次允许落地；晚到的旧响应直接丢弃。它只做 compare-and-set，不拥有防抖、轮询、定时器或焦点策略。
_唯一实现_: `src/client/store.ts` 的 `createLatestWins`。
_Avoid_: 防抖、节流（后发读赢不改变发起时机，只裁决谁落地）。
