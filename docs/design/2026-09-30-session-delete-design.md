# 会话删除插件 · 设计

状态：**已实现并接通**（Node 半 + 浏览器半，四个动词经宿主 web server 上的插件专属前缀路由，见 §10；边界红检见 §8 门 3）。**真机验收（§8 门 4）2026-09-30 跑了两轮**：第一轮暴露活体会话删后掉进「未分组」（修法见 §4 末触点 ③⑤）；第二轮把 删除 / 恢复 / 彻底删除 三条都走通，又暴露两个新问题并已修——**未分组会话删不掉**（账目改为可选，§4 触点②）与**客户端陈旧行**（宿主不会再列的会话在客户端那一行挂着，直到重连；靠触点 ⑤ 的如实通告解决）。
本文件是现状设计（触点 / 边界 / 错误形状 / 验证门）的唯一家；决策与被否决的替代在 §10。

## 1. 问题与证据

DSH 把"归档"做成了一等公民服务，**但没有删除会话的口**。三条实测证据：

1. `workspaceRegistry.delete(id)` 的官方语义是"只移除注册记录、顺序条目和会话账本——**目录、用户文件、实时会话和已持久化日志一概不动**"；`detachSession` 亦明言 "Never touches the session's own stored log"。
2. 会话持久化服务 `ctx.sessionPersistence` 只有 `create / open / stat / list`，没有 delete。
3. 宿主包里确实存在 `session/delete`，但那是 **ACP 协议**的 `AGENT_METHODS.session_delete`（由 "the agent advertises the `sessionCapabilities.delete` capability" 门控）——面向"外部客户端驱动 agent"，**不是插件可注入的存储 API**。这一条最容易误判成"官方有删除口"。

结论：删除必须本插件自己动数据。

## 2. 范围

**做**（三个动作 + 一条读面）：删除（移入回收站）／恢复／彻底删除；**读单条回收站会话的日志**（元信息 + 人与助手的文字），只为"该不该恢复"提供判断材料（2026-10-15 加，判据与实测见 `2026-10-15-trash-detail-design.md`）；**助手正文按 Markdown 排版**（2026-10-15 真机反馈后从"不做"里挪进来：`react-markdown` + `remark-gfm`，判据与三条收口见那份档 §6）；**多选批量彻底删除**（2026-10-15 同日第二批，用户点头翻掉下面那条"批量操作"的一半：只批量**删**，不批量恢复；**2026-10-17 按用户裁定补上批量恢复**——多选从此两件事都能做，批量恢复带确认框、单行恢复仍直接执行）；**宿主会话列表的批量删除**（2026-10-17 第十三批：在会话行上勾选 N 条一次移入回收站，形状与判据见文末第十三批）。

**不做**（要加先问）：正文检索（跨条目搜关键词）、工具调用与模型推理的回放、展开全文的分页加载、收藏、闲置自动清理、跨机同步、附件的引用计数回收、agent 工具面、独立的回收站页面、自动过期。

## 3. 数据布局

| 东西 | 位置 | 谁拥有 |
|---|---|---|
| 会话本体 | `~/.dsh/sessions/<转义cwd>/<会话目录>/session.vN.jsonl.zstd` | 宿主 |
| 回收站本体 | `~/.dsh/session-trash/<时间戳>-<原目录名>/`（时间戳只用于排序，**原目录名原样保留**，恢复按它放回） | 本插件 |
| 回收站清单 | 本插件自己的 `ctx.storageDomain`，域 `xrn1997_session_delete_trash`（介质落在 `~/.dsh/storages/`） | 本插件 |

三条约束，都不是口味问题：

- **回收站必须与 `sessions/` 同卷**：删除与恢复都靠整目录 `rename` 完成（原子、瞬时）。跨卷 rename 会以 EXDEV 失败，那就只能退化成"拷贝完再删"。
- **绝不能放进 `sessions/` 里面**：宿主的枚举约定是 `<sessions>/<项目目录>/<会话目录>/`；在它内部放回收站目录，会被当成一个"项目"，其下每条又被当成会话，于是产生幽灵项目与点不开的幽灵会话。
- **不放 profile 目录**（重装/清 profile 会连数据一起走，语义也不对），**不放 `~/.dsh/storages/`**（那是 KV/JSON unit 的家，键"绝不进入文件路径"，拿它装压缩日志树是拿错工具）。

**清单丢失不致命**，因为会话文件自描述：解压后第一行即 header，含 `id` 与 `cwd`（v3/v4 均如此，实测）。且**目录名 == 会话 id**（v3 无前缀、v4 带 `session-` 前缀）⇒ 恢复必须按**记录下来的原目录名**放回，不自行拼接；清单若丢，可从 header 的 `cwd` 反推它属于哪个项目。

## 4. 删除的五个触点

> **2026-10-16 起这五个触点是「按组」跑的**：一条父会话与它在盘上的子会话（宿主 header 里 `origin:"subagent"` + `parentSession`）算一组，组里每个成员各自走一遍下表（各自一格目录、各一行清册，孩子的行记 `parentEntryId`）；任一个成员在跑 ⇒ **整组拒绝**、零副作用，某个成员搬不动 ⇒ 已搬的**整组退回**。判据、来源面与真机门见 10-15 稿 §11。

| 触点 | 删除时 | 恢复时 |
|---|---|---|
| ① 会话目录 | `rename` 进回收站 | `rename` 回原项目目录 |
| ② 工作区账本 `tables.workspaces[<ws>].sessionIds` | `ctx.workspaceRegistry.get(workspaceId).detachSession(sessionId)`；**账目是可选的**——宿主的"删除工作区"会留下没有账目的会话（它们显示在「未分组」下），那种会话照样能删：跳过这一步，清单里工作区记空串 | `ctx.workspaceRegistry.get(workspaceId).attachSession(sessionId)`；清单里是空串**或那个工作区已经被删掉**（`workspaceExists` 为假）就跳过——会话照常回盘、归入「未分组」（2026-10-17 第十四批） |
| ③ 已归档表 `global.archivedSessionIds` | **确保**在归档集里：未归档则官方 `archiveSession` 归档，已归档一个字节都不动；记下"原本是否归档" | 原本未归档的官方 `unarchiveSession` 放回树里；原本已归档的不动 |
| ④ 投影缓存行 `storages/session_projcache/sessions/<id>.json` | **不碰**（§8 门 1 已结；但"删除后没有读面再返回它"只对**冷会话**成立，见本节末的活体一栏） | 不碰 |
| ⑤ 宿主内存里的活体会话 `ctx.sessions` | **尽力**摘掉：`get(id)` → `liveEntryFor(session).detach()`（宿主 owner 自己用的那条摘除口），并**如实通告**客户端：`api-session/removed` | **如实通告**加回：`api-session/added`，摘要取自宿主自己的会话列表（`ctx.sessionController.list()`），不自己造行 |

前置守卫：问一次宿主的活跃 seam（`workspace/session-activity`，判据见 §5），会话在跑则拒绝。

**执行顺序**——删除 `③ → ② → ①`，恢复 `① → ② → ③`，每一步失败即回滚已做的步骤：

- 删除先归档再摘账本：归档是"把它从分组面藏起来"的那一步，**必须早于摘账本**——否则两步之间会有一段"无主且可见"的窗口，而客户端正好把它派生成「未分组」。
- 摘账本在动文件之前：反过来若文件先挪走而账本摘失败，账本里会留下一条指向不存在会话的行（这正是社区插件专门写一份 repair 去修的不一致）。
- 恢复是逆序：文件先回来，再挂账本，最后按记录还原可见性（原本未归档的取消归档，原本已归档的不动）。
- **清单是这串里的最后一步写，失败同样回滚**：删除的 `manifest.add` 失败 ⇒ 目录搬回原处、账本挂回、归档态还原；恢复的 `manifest.remove` 失败 ⇒ 重新归档藏回、摘账本、目录放回回收站。不回滚的话，留下的分别是"文件在回收站里、面板却看不见"与"目录已回 `sessions/`、回收站还挂着它"的孤儿。
- **彻底删除没有回滚**（它要的就是删掉），所以它的写序是**先删目录、后摘清单行**：反过来的话目录还在而清单行没了，那些字节再也收不回；现在这个顺序下，摘行失败留下的是一条"目录已无、行还在"的记录，**重试即可清掉**（`purge` 对不存在的目录跳过、照样摘行）——自愈，不是半吊子。

**可见性是并集，摘账本挡不住活体。** 分组面 =「会话列表 × 工作区账本」：成员资格是"账本里有 id 且 header 的 canonical cwd 等于工作区路径"；而**列表本身**是 `sessionQuery.listSessions()` = 磁盘上的持久化 **∪** 内存里 attach 着的活体会话（`ctx.sessions`，`dsh-api-session-controller` 的 `list()` 对活体直接取内存摘要）。所以 ①②③ 之外还有一条：

- **冷会话**（本机运行期没打开过）：搬走文件 + 摘账本 ⇒ 两个来源都没有它 ⇒ 侧栏立刻干净，连「未分组」都不会出现（§8 门 1 的读数就是这一类）。
- **活体会话**（本机运行期打开过/发过消息）：搬文件只清掉并集的一侧，`session.list` 照样把它交出来；账本一摘它就"无主"，客户端派生分组时收进「未分组」。**实测（2026-09-30 真机）**：文件已进回收站、账本已摘，侧栏仍留着一行、正落在「未分组」下。宿主**没有**"让内存忘掉一个活体会话"的官方面（`ctx.sessions` 只公开 `get/list/create/fork/…`，摘除权在创建它的 fiber 手里；`ctx.agents` 的 handle 同理归创建者），所以删除只能靠**归档**把它挡在分组面外——这就是触点 ③ 从"摘归档表"改成"确保归档"的原因；而**真正把它从列表里请掉**靠触点 ⑤（下条）。

**触点 ⑤ 是本仓走宿主内部入口的两处地方之一**（2026-09-30 决定，真机实测）。会话 store 的摘除只有一个口子：`ctx.sessions.liveEntryFor(session).detach()`——`liveEntryFor` 是 store 的公开方法，`entry.detach` 就是 owner 自己用的那个单次摘除闭包（内部 `store.delete(id)` + `attachments.delete(session)` + 发 `session/disposed`）。**为什么只能走到这一层**：真正干净的是"拆掉跑着它的那具 agent"（agent 的 effect 链会按序把会话一起带走），但那是 `ctx.agents.create()` 返回的 handle 里的 `dispose`，而宿主的控制器 `createOrAdopt` 只取 `.agent`、**把 handle 丢掉了**；`ctx.agents` 也没有 `liveEntryFor` 那样的取 entry 入口（会话 store 有、agent store 没有，逐成员面核过）。**代价（已知并接受）**：只摘会话不拆 agent，那具仍注册着的 agent 之后若走到 `flush(session)`，会撞 `liveEntryFor` 抛 `session "…" is not live in this store`。所以触点 ⑤ 只做**尽力清理**（端口契约：不抛；读不到 live store / 形状不符 / detach 抛 ⇒ `unknown`，宿主列表不再含它 ⇒ `evicted` / `not-live`），且**跟宿主版本必复核**（成员名与行为在 asar 里逐字读过）。

**第二处是"通告"，它才是让客户端那一行消失/回来的真正手段**（同一批复盘出来的结构性缺口）：客户端那一行只由两条路更新——重连时的整表重列（`handleConnected` → `refreshList`），或宿主转发的 `api-session/*` 事件；而删除一个**冷**会话时宿主**不会**发任何事件（`session/disposed` 只在摘掉活体时才有）⇒ 那一行会一直挂到下次重连（真机实测：删完 + 彻底删除之后，客户端那一行还在、点开还能看）。两条通告都发宿主**自己声明并转发**的事件（`dsh-api-remotes` 的 `API_REMOTE_FORWARDED_EVENTS` 里有 `api-session/removed` / `api-session/added`，mode 都是 `emit`；转发器就是 `ctx.on(event, …)` 的普通监听者，而 cordis 的 `dispatch` **只在 emit 带 carrier（首参是对象/函数）时才过 filter**）⇒ 不带 carrier 地 emit 会被全量派发到转发器、再到客户端的 `ctx.remote.$on(...)`。**只在"宿主列表确实已经不含它"（`evicted`/`not-live`）时才通告移除**：`unknown` 时沉默——那时发"已移除"是假话，客户端重连后那一行会自己长回来。恢复侧同理：摘要取自宿主自己的会话列表（客户端 `handleSessionAdded` 要的正是 `summaryFor` 那套形状），取不到就不发——恢复本身已经完成，只是要等下次重连才上屏（与"外部塞一个会话目录进去"同款行为）。**⑤ 与通告在 `purge` 里也走一遍**：彻底删除的条目可能是修复前删的、或那条会话又活了过来，所以它同样先摘活体、再按同一门槛（`evicted`/`not-live` 才通告）发 `api-session/removed`。

## 5. 边界

- **live 会话**：磁盘上没有任何存活标记（实测 446 个会话目录里没有存活标记文件；**2026-10-16 更正**：当时的括号写的是「只有那一个 `.jsonl.zstd`」，已被推翻——一个目录**可以并存两份**日志（换代留底，本机 7 个目录如此），那不是存活标记，读哪一代见 10-15 稿 §1.4），liveness 只在内存 ⇒ 必须查注册表；**首版一律拒绝**（`sessiondelete/live`），不替用户终止正在跑的活。活跃判据用**宿主官方的那一条**，不自创第二套：`ctx.waterfall("workspace/session-activity", { sessionId }, () => Promise.resolve([]))`，**空数组 = 无活动**，非空即判 live——宿主自己的 `archiveSession` 准入读的就是同一条 waterfall（见 §9），所以我们的拒绝与它的归档准入同源。第三方插件 ctx 上这条可用（隔离宿主实测：`typeof ctx.waterfall -> function`，未知 id 拿到 `array length 0`）。
- **附件不连带**：`~/.dsh/attachments/v1/objects` 是**全局内容寻址**，与会话不是父子关系 ⇒ 删除不连带、恢复不涉及；被删会话独享的附件会留成垃圾，**不做回收**（要做得先有引用计数，属另一件事）。
- **回收站不自动过期**：不设天数上限（魔法数字）；界面显示条数与占用，清空是显式动作。
- **数据根只镜像后两级**：`resolveDshHome(configured, env)` 的优先级是「显式配置 > `$DSH_HOME`（空白视为未设）> `~/.dsh`」，本插件只实现后两级。**这不是偷懒**：平台的同款 helper `dshHomePath()` 逐字是 `join(resolveDshHome(), …)`、同样不传 `configured`；`ctx.profileContext` 按 launcher 原文只装 profile 位置 / 启动 bundle 名 / 调用覆盖 / 遥测开关，不含数据根；宿主自己的服务是各自声明 `Config.dshHome`、由装配方填的 ⇒ **第三方没有"问出显式配置"的口**。表现：那种 profile 下文件探测落空 ⇒ 删除/恢复以 `not-found` 拒绝、零副作用（sessions 与回收站同源、永远同卷，**不会**跨卷 rename）。
- **恢复默认走 `attachSession`（id 前插，即排在账本首位）**。"原位恢复"要记下账本序号并用 `insertSessionBefore`，列为待定项（§11）。**工作区已被删掉（宿主的「删除工作区」只删注册、保留日志）时不挂账本**：会话照常回盘、归入「未分组」，清单行在点之前就说清这一点（2026-10-17 第十四批）。
- **不做"删一半"的状态**：任一步失败即回滚已做的步骤，并把原始错误带上（见 §6）。

## 6. 错误形状

动词与端口一律 `throw verbError('<因>', message, cause?, details?)`（`src/verbs/errors.ts`），由**唯一一张映射表** `src/remote/map-error.ts` 折成插件专属域 `sessiondelete/<因>`——它同时认宿主两条类型化错误（按 `this.name`，并**沿 `cause` 链**看进去，否则动词那层笼统的 `io` 会把这两行永远挡在客户端之外）。两半之间的载具是宿主 web server 上的插件前缀路由（§10 通道那条），**线上是失败信封里的 `error.code` / `error.message` / 可选 `error.details` 三件**（2026-10-17 对齐官方 `rpcErrorSchema` 那三件，见第十二批）：浏览器半按 `code` 字符串判别（不看 instanceof，JSON 里也没有实例），`message` 是上屏的原文，`details` 是**结构化附带物**——宿主类型化错误自己身上的 `sessionId` / `activity` 等就地过桥，不降级成单个码一句谎。**域名取插件专属的 `sessiondelete`，避免与宿主官方域重名**：

| 码 | 触发 |
|---|---|
| `sessiondelete/live` | 会话正在运行 |
| `sessiondelete/not-found` | 会话目录不存在，或宿主的持久化里没有它（推不出项目目录）。**没工作区账目不算 not-found**——未分组的会话照样可删 |
| `sessiondelete/trash-empty` | 要恢复/彻底删除/看详情的条目不在清单里 |
| `sessiondelete/project-missing` | 恢复时目标项目目录不存在（不静默建目录） |
| `sessiondelete/io` | 文件操作失败；原文进 `message`（原始 cause 只住在宿主进程里，出不了进程边界）。**详情的读盘/逐帧解压失败也落这一码**——帧解不开就整条判失败，绝不回半截正文（2026-10-15） |
| `WorkspaceUnknownSessionError` → `sessiondelete/not-found` | 宿主"会话未知"的类型化错误（`archiveSession` 的已知性检查）——我们的码是**映射**来的，不是自己判的 |
| `WorkspaceActiveSessionError` → `sessiondelete/live` | 宿主"仍有活动在跑"的类型化错误（`archiveSession` 的活跃准入）——同样是映射，不是自己判的；我们与宿主读的是同一条 waterfall（§5） |

路由层自检（未知路径 / 方法不对 / 请求体不对）也走**同一张表**，落到 `sessiondelete/io` + 一句说清哪儿不对的 `message`——不给这条薄线另开一套错误词。**但 HTTP 状态不再一律 200**（2026-10-17）：请求本身不对就用它自己的 4xx（`400` 请求体 / `405` 方法 / `404` 未知路由，栅栏拒 `403`），**操作失败**才回 200 + 信封（"盘上没有""原目录已不在""会话在跑"这些是办完才知道的结果，不是请求不对）。信封在 4xx 上照样在场、原文照样读得出（浏览器半先解体再看状态）。`ROUTE_CODES` 那三个名字是**抛出处给读代码的人看的站点标签**，一律折成 `io` 上客户端——它们不是 §6 这五个码，不许冒充。

**别域的官方码原样过桥**（同一批）：带 `workspace/*`、`session/*`、`gateway/*` 这种官方 `<域>/<名>` 形状的抛出物（以及已经带标记位的远程失败）**不改写、不二次包装**，`code` 与它的 `details` 一起带出。把它们折成 `sessiondelete/io` 就是把宿主的判断抹成我们的，客户端拿到的 code 从此不能说真话。

本地失败（同进程内调用）不进这张映射表。

## 7. 界面

> **2026-10-15 形态改版已落地**：状态④ 从"居中一列卡片"改成「清单在左、选中那条的详情在右」，并新增状态⑥（单条详情）。动作**没有**跟着搬进详情——那一版当天按真机反馈回退，「恢复」「彻底删除…」仍在清单行右侧（判据见 10-15 稿 §6）。判据、实测与验收读数在 `2026-10-15-trash-detail-design.md`；本节是现状。

六个状态（**本节就是界面规格**——本仓不另存像素稿，结构与层级以这段为准，皮肤只由官方 token 决定）：① 会话条目「…」菜单里的红色「删除」② 确认框（主按钮是官方 `variant="primary"`——宿主浅色下它是近黑 `bluish-1000`、深色下近白 `bluish-50`，**从来不是蓝**："蓝"是当年手绘稿的占位配色留下的错觉，2026-10-01 真机浅色截图后改正；正文明说可恢复；**目标在盘上带着后代时，那张卡片下面先说「含 N 个子会话，将一起移入回收站。」，再说那句可恢复**——2026-10-16 按 issue #3 补的：那几行宿主的列表里本来就不显示，点之前不说就没人知道少了一整片。N 由**一次计数读**在打开确认框的那一刻现问（当初是第六个端点 `POST /subagent-count`，2026-10-17 起它是 `POST /apply` 的 `action:"count"` 一支——纯读、不进串行链、与级联同一个闭包口径，见第十二批），读不到就整句不出现、也不写「含 0 个」，且**绝不让主按钮点不动**，见 `10-15` §12）③ 删除后即时撤销提示（停留 6 秒；宿主 Toast 默认 3 秒） ④ 回收站清单：**按项目分组的卡片列表，住在左栏 420px 定宽里**（`box-sizing:border-box`，含给滚动条的 10px 右内边距），每条两行（标题 / 「删除于 … · 大小」，绝对时间在 `title`；**组视图另挂两段，各说各的**：跟着父一起进回收站的孩子说「含 N 个子会话」，级联落地前删的那些**还留在盘上**的说「盘上还剩 M 个子会话」——两个数来源不同、不许互相冒充，一个都没有就半句不出（不许拿 0 冒充"没有"），判据与实测见 10-15 稿 §10/§11；**原工作区已被删掉的条目另挂一行**「原工作区已不存在，恢复后归入未分组」——这是这一条的属性、不是某次动作的失败，点之前就要看见，2026-10-17 第十四批），**动作在行右侧**——「恢复」描边、「彻底删除…」安静的红，与 2026-10-01 那版同形；整行还是 `role="option"`（点行=选中看详情，点按钮=动作，两件事不打架），选中态用宿主"active"那一档 token（`--dsw-alias-button-ghost-active-fill` / `-border`）；条数与合计占用住头部，页脚那句必须看得见（不套省略号）⑤ 彻底删除的红色二次确认（单条与清空**共用同一个**确认组件，主按钮都用页脚那款实心红；上面那句「整页唯一一块实心红」说的是面板本体，浮层是另一层；**单条那张卡片的 `{size}` 报的是这一次会释放的字节 = 父 + 折进来的孩子**，与页脚合计共用同一个算式 `releaseBytesOf`——2026-10-16 按 issue #2 定的口径，彻底删除按组走，说"我即将失去多少"就不能只说父那一格。清单行里那个 `{size}` 仍是这条会话自己的，理由见 `10-15` §12③）⑥ **单条详情**（右栏 / 窄档下钻时铺满）：标题行（清册标题优先，空串才回落日志里的 `session/title`；这里**不摆动作**）+ 元信息三组（时间／体量／位置，含日志 header 的**无损 `cwd`**）+ 正文（人与助手的文字按序成列；**助手走 Markdown**（`react-markdown` + GFM，原始 HTML 落不成节点、链接与图片渲成不可点的文本），**用户提问走原话**（`pre-wrap` 字面），不显示推理段与工具调用）。**消息行的皮肤抄宿主自己那两张表**（`MessageItem.module.css` / `AssistantMarkdown.module.css`）：只有用户有气泡（`--dsw-specific-bubble` + `--dsw-radius-xl` + `10px 16px`），助手不铺底不给边框、正文铺满栏，字号一律 `--dsh-content-font-*` 那根轴；正文排版抄 `MarkdownText.module.css` + `CodeBlock.module.css`（见 `src/client/ui/markdown.css` 文件头记的三处有意差异）。四态＝未选中（一句引导）／读数中（一句"正在读" + 骨架）／读数失败（原文 + 重试，只坏这一块）／有内容。**注入条数与截断条数必须上屏**（「另有 N 条宿主注入的上下文未显示」「还有 N 条未显示」）——正文比日志里的 `user/message` 少一大截是过滤的结果，不能让它读起来像"这条会话就这么点内容"。

- **入口**：菜单项挂 `sidebar.workspaces.session.menu.item`；回收站入口是**一对座位**——`sidebar.panellist` 的一行图标（行本体归宿主：按钮 / 名字 / `aria-current` 选中态 / 折叠 tooltip，我们只交一个 glyph）+ `main` **同字 key** 的中央面板（清单本体）。**两条必须同批注册**：`ctx.layout.selectPanel(id)` 对没在 `main` 里注册的 id 直接抛。为什么不挂底栏，见 §10。
- **空态与面板自身的状态机**：回收站那一行始终在（面板行的常驻性归宿主）。**不做计数角标**（glyph 座位只有 16/18px，角标只能压到邻行）；条数与合计占用住面板头部；**面板头部不摆任何动作**（那一排动作住在面板体顶端，见下条；曾有的「刷新」按钮 2026-10-16 已删——清单每次读都先对账，见 `10-15` §9/§9.1），头部只剩标题与那行计数。面板本体四态：**读数中**（「正在读回收站…」）／**空**（「回收站是空的」，且底部**不出现**「清空回收站…」）／**读数失败**（宿主原文上屏 +「重试」按钮，绝不吞）／**有条目**（分组卡片列表）。
- **两档形态与断点（2026-10-15，真机反馈后定值）**：面板用满中央列（不再限宽 760 居中），**盒子宽 ≥900 且清单里有东西可看**才走左右两栏（清单默认 420 可拖 + 一根侧栏式把手〔10px 命中区、2px 视觉线〕+ 详情吃余下、正文自己限宽 860 左对齐），**<900 走下钻**（清单铺满；点行 → 详情铺满 + 「← 返回清单」）。清单为空或读数失败时**不分栏**：那一栏既没有可选项也没有动作，白占一半宽度（10-15 稿 §2.3 第 1 条），失败那块自己的「重试」负责把清单读回来。宽度来自 `usePanelWidth`（`ResizeObserver` 观测面板自己那一块的 **border-box 宽**，走 `entry.target.getBoundingClientRect().width`；不是 `window.innerWidth`，也不是 `contentRect.width`——后者已经扣掉内边距，再拿去跟「整块盒子多宽才分栏」那个阈值比就是**扣两次**，真机上就是这么退化成单列的）。900 这个数是算出来的：两栏各守一条读得开的下沿——详情至少 399，而中间那一格固定要吃 90（两道 gap 32 + 把手 10 + 页内边距 48）⇒ 地板 489，于是清单在 900 这一档被夹到 **411**（比默认窄 9px，那一档本来就抢不动宽度）；2026-10-15 用真 Chromium 重量过这一档：**清单 411 / 详情 399 / 正文 389 / 横向溢出 0**。旧稿这里写的是"420 + 33（两道 gap 与分隔）+ 399 + 48 ≈ 900，量到 详情 399 / 正文 374"——那个 33 按的是当时那根 1px 的 `border-l2` 分隔；拖分栏那批把中间换成 10px 的把手之后没人重算过，差的正是那 9px。反证：同一份两栏 DOM 硬塞进 405px 时详情横向溢出 74、整框溢出 82 ⇒ 窄于此该下钻，而不是挤成两根读不了的柱子。
- **清单那一列自己可以收（2026-10-15 同日第二批，三件）**：① **组折叠**——组头是 `<button aria-expanded>`（抄宿主 `DisclosureRow` + 官方 chevron 几何），折叠的组**条目不进 DOM**（不是 `display:none`），组头与计数留在原地；② **一键全部折叠/展开**；③ **两栏之间那根线可拖**（视觉抄宿主 `ConversationRoot` 的 `.widthHandle`），`role="separator"` 可聚焦、←→ 各 20px、Home 回 420、End 到上限。宽度夹在 `[330, 面板宽 − 489]`（**2026-10-16 更正**：这里曾写 480，那是按"中间分隔只有 1px"推的，而拖分栏那批换成的 `.sd-width-handle` 命中区是 10px ⇒ 地板 489 = 正文 399 + 间隙 32 + 那一格 10 + 页内边距 48，与本段几何那条同源；900 那一档于是把清单夹到 **411**，比默认窄 9px 而**仍能往里拖**）：**330 是扫出来的**（真 Chromium 上 240→420 每 10px 一档：两颗按钮永远放得下，因为它们 `flex:none`、缩的是文字列；真正的下沿是「删除于 … · 224KB」那一行不再被省略号截断——280 差 50px、320 差 10px、**330 归零**）；上限那条来自"详情还读得开"，于是 900 那一档上限正好回到 420，**拖不动是设计而非 bug**。窗口变窄时宽度在**读**的那一刻重新夹，不等到下次交互。**曾经还有第四件「整条左栏收起」，同日第四批之后按用户裁定删了**（"感觉没啥用"）——判据与删掉之后剩下什么见 §10。
- **那一排住面板体顶端，不住清单列里（同日第三批，真机反馈后改的位置）**：从左到右是「全部折叠 / 全部展开」、「多选」；曾住在最右的「**刷新**」（第三批收进这一排、第四批从文字降级成图标）**2026-10-16 按用户裁定删除**——它的活已由"每次读清单先对账"承担（`10-15` §9/§9.1），留下的这一排只剩两个视图开关。搬出来的两条理由照旧：① 它原先住在滚动容器里，长清单滚到底会把开关滚走；② 当时还有个「整条左栏收起」，开关若住在清单列里，收起之后就随清单一起消失 = 单向门——**那条功能后来删了，但这一排留在原地**（理由①仍然成立，而且它已经形成位置习惯）。排的宽度上限跟着清单列走，所以视觉上仍然"属于清单"。
- **多选态下组头也有一颗勾选框，三态**：勾满=实心、只勾几条=`indeterminate`（原生那根横杠。它**不是属性而是 IDL 字段**，写进 JSX 会被 React 当未知属性丢掉，只能挂 ref 命令式赋值）+ `aria-checked="mixed"`、一条没选=空。点它说的是"**这个项目全部会话**"，判据走 `group.entries`——**折叠起来看不见的条目也算**（折叠只是不进 DOM，不是它们不存在）；全勾着再点 = 整组取消，不是退到半选。勾选框住在折叠按钮**外面**（`<input>` 是交互内容，不能嵌进 `<button>`），所以组头那一行现在是"勾选框 + 按钮"并排——点勾选框不会顺手把那组折叠掉（有用例钉住）。
- **组头那颗按钮必须显式 `text-align:start`**：宿主 `DisclosureRow` 那份是 `div`，没有这个坑；我们这行要做成可点的 `<button>`，UA 样式表的 `text-align:center` 会渗进里面的文字，真机上就是**项目名整条居中**（2026-10-15 截图）。量页读到 `textAlign: start` / 标题左缘 74px（多选态让给勾选框后是 96px）才算过。
- **状态一律不跨会话记住**（折叠集与拖出来的宽度都是）：这是纯视图偏好，为它开一条 Node 半通道不值；而 `localStorage` 那条路**没验过就不走**——宿主桌面壳的文档 origin 是不透明的 `null`（AGENTS.md 实测 `dsh-app:` 不是 special scheme），大概率直接抛。关掉面板再回来是默认形状，这条如实写在这里。
- **多选（2026-10-15 同日第二批开的口子，2026-10-17 补上批量恢复）**：进多选 ⇒ 行右侧两颗按钮**整排退场**、勾选框出在标题**左侧**（照用户给的参考图那一版布局；勾选框本体用宿主 `Checkbox` 那款原生 `input` + `accent-color`，不自绘圆框）、头部那行换成「已选 N 条」、页脚那颗从「清空回收站…」**换成「恢复 N 条」（描边）+ 「彻底删除 N 条」（实心红）两颗**（实心红仍在最末位——"整页唯一一块实心红"靠不换位置来守），一条没勾时两颗都置灰 + 悬停给原因。**一次点击 = 一次 `POST /apply`**（2026-10-17 第十二批改掉"串行逐条各发一次"：整批一次清册快照、一次宿主会话表预取、一次通告，逐条结果按 id 落回自己那一行；形状与代价见那份 §13 与本稿第十二批），顺序按**清单从上往下**而不是点击顺序，失败原文落回它自己那一行、多选态不退。两件事的"点之前要过框"不同：**彻底删除带确认框（不可逆）**，**批量恢复也带确认框（2026-10-17 用户裁定：一批条目多、去向是各自的旧项目目录，点之前要看一眼有哪些）**——单行的「恢复」仍直接执行，恢复是加法、且那条路一直如此。
- **键盘**：清单是 `role="listbox"`（单选），行 `role="option"` + `aria-selected`，roving tabindex——**落点那条规则 2026-10-15 复核批改过**：原先只让"选中那行"拿 `0`，而 `listbox` 自己是 `tabIndex:-1`，窄档又从不自动选中 ⇒ 一次没点过时**全行都是 `-1`，键盘根本进不了清单**（这不是"能聚焦但不好用"）。现在落点 = 选中那行，选中不存在或被折叠收起时落到**第一条可见行**，其余 `-1`；↑↓ 在**拍平后的顺序**里环移（未选中时 ArrowDown 落到第一条），Enter/Space 在窄档下钻，下钻中 Esc 退回清单并把焦点交还给那一行（Esc 的监听挂 `document`——下钻时清单不在 DOM 里，挂容器上是死路径）。两处随 2026-10-15 那批跟进：**↑↓ 只走展开的组**（折叠起来的行不在 DOM，让方向键停在一条看不见的行上就是"按了有反应、屏幕上什么也没发生"），因此选中那条被折叠时 `aria-activedescendant` **不设**（指向一个不存在的 id 是假引用）；**多选态下 listbox 加 `aria-multiselectable`、`aria-selected` 改说勾选、Enter/Space 切换当前行的勾选**（↑↓ 仍是移动光标，所以同一行再按一次是取消勾选——切换语义，不是"确认"）。详情块**不加 `aria-live`**：读数中到读完是整块替换，加了会把整篇正文念一遍。
- **动作与它的原因待在同一行**（2026-10-15 真机反馈后回原形）：「恢复」「彻底删除…」住在清单行右侧，失败原文也回到那一行下面（error 字色 + 警示 glyph）。详情那块只负责看——把动作搬进详情试过，代价是左栏得压到 316 才放得下「光标题」，用户读起来就是「左侧太窄」；两颗按钮回到行右端之后，420 的左栏留给标题 214px、给动作 152px。
- **失败写在出事的那一块上**（改版后仍是同一口径，只是分了三块）：清单读不到 ⇒ 清单那块原文 + 重试（不是空态）；某条正文读不到 ⇒ 只在详情那块说，清单照常可选；`detail` 端点挂了不影响四个入口出现与否（接通性由探测 `GET /ping` 决定，见下一条）。
- **组头的项目名**从宿主 `projectKey` 反推：`--…--` 裹边与 `~XXXX` 十六进制转义还原成原字符（还原函数 `unescapeProjectKey` 住在两半共用的 `src/shared/wire.ts`，与 Node 侧的编码镜像配对），**完整原串**交给组头的 `title`（分隔符那一层是有损的、拆不回真实路径，故不作声称）。
- **运行中**：菜单里「删除」置灰并提示"会话正在运行，先停止再删除"。
- **未接通态（取数通道缺席）**：客户端半在注册任何入口之前先**探测一次**取数通道（同源 `GET <前缀>/ping`，见 §10；**2026-10-17 第十二批改的**：原先探测拿 `GET /list` 当健康检查，而 `list` = 对账 + 装配 + 两次宿主读数 ⇒ 每次页面加载都跑一遍全盘对账，为的只是问一句"你在不在"）；探测不过 ⇒ **一个槽位贡献都不注册**（连同那一对面板座位）——菜单行也一样：通道不在时点它只会开一个必然失败的确认框，半吊子 UI 比没有 UI 更糟。"不可用"以**入口不出现**表达，不新造禁用态 UI；宿主页面上看不出本插件的存在，但**不会因为本插件而死**。反过来，探测**过了**（哪怕回的是失败信封）就照常注册：那次往返已经证明路由在、依赖接上了、错误映射也生效了，失败该做的是把原文交给用户看。`/ping` 的判据**只可能是这句话**——它不碰清册、不碰盘、不进串行链，所以它答得了"通道在不在"、答不了"此刻有几条"（那是 `/list` 的事，2026-10-17 复核时特意钉在用例里：`ping` 那次读数不许被当成清单读数用）。
- 配色/圆角/图标全部走**主题 token**（`--dsw-alias-*` 与 `--dsw-radius-*`），一个颜色字面量都没有（字号是宿主同类面读数的字面量 px，见 `trash-panel.tsx` 头注）；界面不另存像素稿，结构与层级住在本节。**控件与图标自造**（2026-10-02 起）：`src/client/ui/*` 是照官方 `dsh-client-ui-primitives@0.2.0-rc.2` 随包发布的明文 CSS/JS 逐条抄下来的（类名加 `sd-` 前缀、`@keyframes` 改名、只保留 token 引用），本插件**不再 import 任何宿主客户端包**——理由与被否决的替代见 §10，抄写的保真度核对见 §8 门 4。
- **可见文案一律走 Client locale 服务**（2026-10-02 起）：全部中文/英文字面量收在 `src/client/copy.ts` 的命名空间字典里（`zh` 真源 + `en` 逐键镜像），经 `ctx.get('locale')` **可选读**（服务在就 `register` + `bind`，不在则降级到内置 zh；**不进 `inject`** —— 客户端条目 pending = 宿主进程死）；面板行那一行的名字用 **thunk**（`() => t('trash.title')`，宿主 `resolveSlotLabel` 的 JSDoc 即 "thunks follow the active locale"）。

**批量删除的四个态**（2026-10-17 第十三批）：宿主会话列表上的**多选模式**（「⋯ → 多选」进入；模式内整行点击勾/取消并屏蔽会话切换 + 行首/行尾勾选 + 选中行底色 + 浮条已选清单（同一位置全选↔取消全选，汇总在列表头，0 条也显示模式与退出））、**批量确认框**、**批量撤销横幅**、**部分失败态**（框不关、原文落行、可重试）——结构与文案形状住文末第十三批（同一事实只住一个家）；单删的 ①②③ 不受它影响，两套并存。

## 8. 验证门（顺序即优先级）

1. **幽灵行实验（红检在前，实现第一步）——已结（2026-09-30；隔离数据根上的数据层取证）**。做法：在 `DSH_HOME=<临时目录>` 的隔离宿主里造一个真落盘的冷会话（`sessions/<projectKey>/<id>/session.v4.jsonl.zstd`）→ 经官方冷读路径给它落一行投影缓存 → 经**我们的** `sessiondelete/delete` 删掉它。三处读数：① **官方会话列表读面全部不再返回它**——`session.list`（`sessionController.list`，UI 侧栏那条）、`sessionQuery.listSessions()`、`registry.listStoredHeaders()`、`sessionPersistence.list()`、`registry.list()` 的 `sessionIds` 五处都是「删前有、删后无」；**重启后已复核 4 处**（`registry.listStoredHeaders()` / `registry.list()` 的 `sessionIds` / `session.list` / `sessionQuery.listSessions()`），这 4 处重启后仍然无（启动期从磁盘 header 重建索引也造不出幽灵行）；第五处 `sessionPersistence.list()` 的重启读数只记在报告对照表里、**无逐字原文**，未单独取证；② **缓存行原样留在原地**：`storages/session_projcache/sessions/<id>.json` 删前删后同一个文件、字节数未变、`identity` 与 `title` 行未变——删除动词一个字节都没碰它；③ **归档集成员按预期变化**：`registry.archivedSessionIds` 走 `[] → [id]（我们手动归档）→ []`——**该读数取于 ③ 还是「摘归档表」的版本**；同日 UI 层复核后 ③ 已改为「**确保**归档」（§4 触点③），所以现在的删除会让 id **留在**归档集里。**结论：缓存行不必碰（§4 ④ 保持"不碰"，归属写死）**——残留行是**不可达的孤儿**：投影缓存服务没有枚举面（方法面只有 `recordFor / cachedSnapshot / cachedPredecessorTitle / viewRecord / hydratePrepared / write / coldSnapshot`…，一行只能靠「会话 header 做身份见证」读到），而删除之后没有任何读面再交出这个 header。**不碰的代价**：每个被删会话留下一个孤儿 JSON（本实验 4141 B）且**没有回收者**；恢复侧照旧不碰（冷读会用 identity 过滤，同名 id 但 `createdAt`/`cwd`/`isSeeded` 不同的新会话不会串味）。**UI 层的核验点**：侧栏与"已归档"页有没有像素级残影、客户端有没有自持列表绕过服务端读面。**UI 层已核（2026-09-30 真机 + 客户端派生代码）**：① "已归档"页确为「会话列表 ∩ 归档集」——客户端 `groupByWorkspace` 按 `sessionVisible` 过滤，`archivedFilter === "only"` 时判据就是 `archived.has(id)`；② **本门那句"删除后没有任何读面再返回它"只对冷会话成立**：真机上一条**活体**会话（本机运行期打开过）被删后，文件已进回收站、账本已摘，侧栏却仍留着一行、落在「未分组」下——因为 `listSessions()` 是"持久化 ∪ 内存活体"的并集，而摘掉活体没有官方口（§4 末）。修法即触点 ③ 改为"确保归档"，已落码。**这条经验同时说明**：数据层红检（本门）与 UI 层验收是两个面，**冷/活**是它们的边界条件。
2. **全链路**：临时会话 删 → 回收站有条目 → 恢复 → 能在侧栏打开且内容不变 → 彻底删除 → 文件消失。
3. **边界红检**：正在跑的会话被拒（`sessiondelete/live`）；归档过的会话删后恢复仍处归档态；恢复时项目目录不匹配被拒；清单条目在而目录被人为移走时不静默跳过；**删后分组面不得再出现该会话（活体会话亦然）**。**已跑（2026-09-30）**：前四条都在**隔离 `DSH_HOME` 上的活宿主**（desktop 0.2.0-rc.2，镜像 desktop 组成的临时 profile）上经 §10 那条前缀路由逐条取证，读数与判据一致。live 那一条的**活跃状态**由宿主官方 admission seam（`workspace/session-activity`）报出——隔离 home 里没有凭据、跑不起真 agent turn，所以状态是喂进去的，但判据是宿主的；同一条会话也被宿主自己的 `archiveSession` 以 `WorkspaceActiveSessionError` 拒绝，两侧同源。**同批复核了 §6 的 `not-found` 判据（活宿主）**：`readSessionHeader` 对未知会话抛的原文仍是 `cannot validate session '<id>': session persistence holds no such session`（`src/ports/host-port.ts` 的判据串命中），`POST /delete` 未知 id 得 `sessiondelete/not-found`。**这条判据的脆弱面（未修，跟版必重跑）**：单测夹具（`tests/assembly.test.ts`）复读同一句字面量 ⇒ 宿主改文案不会让任何用例转红，只有活宿主复核能发现。**第五条（删后分组面）是 2026-09-30 真机验收时才暴露的**：当时触点 ③ 是"摘归档表"，活体会话因此掉进「未分组」；③ 改成"确保归档"后由它保证，**已于 2026-10-02 真机复测通过**（用户按日常用法跑过并勾选确认覆盖到这一条；单测侧另钉在 `tests/delete-session.test.ts` 的调用序上）。**第六条（未分组可删可恢复）同一天暴露**：侧栏「未分组」下的会话（宿主的"删除工作区"留下的、没有账目的那种）点删除报 `sessiondelete/not-found`——原实现把"账本里有它"当硬前提；已改成"账目可选"（触点 ② 那行），单测钉在 `tests/delete-session.test.ts` / `tests/restore-session.test.ts`。
4. **真机验收**：在 desktop 0.2.0-rc.2 上按日常习惯删一个真会话，手感"顺手"。**已跑三轮（前两轮 2026-09-30；第三轮 2026-10-16 跑的是两栏 + 详情 + 拖栏 + 多选那批，仍在 `0.2.0-rc.2`，四处逐条读数见本节末尾那条复核批）**：第一轮暴露"删完仍留在「未分组」"（= 触点 ③⑤ 那条边界）；第二轮 删除 / 恢复 / 彻底删除 三条都走通，手感"顺手"，同时暴露并修掉**未分组会话删不掉**与**回收站面板不刷新**（面板只在挂载时取一次数，删除发生在侧栏菜单那边，没有共同父组件 ⇒ 加了一个模块级失效通告台）。**浏览器半这轮改动只做到"激活与渲染"这一层**：隔离活宿主上侧栏出「回收站」行、面板开得起来显示正确空态、零控制台报错、宿主存活；"点删除→面板当场刷新"的**交互**因该环境内置浏览器无可见视口（指针/hover 被拒、宿主会话行菜单 hover 才渲染）没驱动成，改由 RTL 端到端用例（`tests/client/index.test.tsx` 的"删除成功后回收站面板立刻刷新"）覆盖。**下一次动浏览器半时，交互那一层仍要按 AGENTS.md 的硬约束在有可见浏览器的隔离 home 上补一次**。**入口迁位这一批已在隔离活宿主上跑过（2026-09-30）**：镜像 desktop 组成的隔离 profile（`dsh-base` + `dsh-web-app` + 小说 + 本插件，两个插件都走 `plugin add link:`）上起 web 宿主，浏览器侧读数四条——① 侧栏面板列表出现 `aria-label="回收站"` 的行，类名是宿主自己的 `_2H3hWW_panelRow`（rail 态 36×36，label 来自**我们的注册元数据**）；② 点击后该行 `aria-current="page"`；③ 中央列渲染出 `data-dsh-session-delete="trash-panel"`（隔离 home 里没有回收站 ⇒ 空态「回收站是空的」，说明探测过、四端点通）；④ 控制台零 error/warn（没有 `web boot: N entry did not activate`）。**带真会话的完整手感（删 → 恢复 → 彻底删）仍归真机验收，未跑**。**2026-10-01 卡片改版这一批的验收状态**：结构、时间分桶、危险动作层级三档都在单测与一张 token 精确的静态替身上量过（1500px / 520px 两档：正文列宽 760、卡片 57px 等高、按钮 28px、无横向溢出；行内 danger 计算底色 `rgba(0,0,0,0)`、批量那块 `rgb(242,90,90)`），但**卡片分支当时还没在真宿主上渲染过一次**——那四条活宿主读数走的是空态，而 `relativeTime` 与组头的 folder glyph 只在有条目时才被调用；这套单测对「真产物少一个具名导出」又是**免疫**的（`vitest.config.ts` 把整包 alias 到替身，缺席落在渲染期而不是加载期，见替身头注 ⑦）。**同日补齐（2026-10-01 真机·浅色，用户截图）**：回收站 3 条 / 2 组，组头（`D-develop-GitHub-dsh-session-delete`、`D-develop-GitHub-dsh-novel`）、`relativeTime` 分桶（"刚刚删除 · 22KB"、"删除于 7分钟前 · 350KB"）、两档危险动作（行内安静红 + 页脚唯一一块实心红）全部出得来。**同一张图还证明了「删完面板当场刷新」**——撤销提示「打招呼确认在线状态 已移入回收站」仍在屏上，而那一行已经进了清单（失效通告那条路径此前只由 RTL 用例覆盖，设计稿 §8 门 4 上一段那句"交互那一层没驱动成"就此结掉）。浅色下卡片确实只剩 `border-l4` 一根描边（`bg-base` 与 `bg-layer-2` 浅色同为 `bluish-00`），分组靠组头 + 间距站住，读得下来；**深色下的新版未看**（同一批 token，风险低）。这张图**不覆盖**控制台读数与键盘路径。**归档往返同批复核（2026-10-01，用户真机）**：未归档的删除→恢复后仍是未归档，归档过的删除→恢复后仍在归档态——门 3 那条边界在日常习惯的用法下重认一次（我一度把侧栏两条灰行疑成"取消归档没生效"，实测不是：那是宿主的常态呈现）。

门的判据要能被机器判；跑门取**退出码**而不是管道里的话（`cmd > log 2>&1; echo $?`）。

**2026-10-02「自造控件 + 文案走 locale」这一批的验收状态**（改了浏览器半，所以按 AGENTS.md 的硬约束要走的还是"有可见浏览器的隔离 home"那一趟）：

- **单测**：171 个用例全绿（新增 `tests/client/copy.test.ts` 钉接线：服务在→注册字典并 bind、服务缺席→退回内置 zh 且不注册、disposer 真进 effect、`splitOn` 不丢字；`tests/skeleton.test.ts` 新增"浏览器半源码里没有任何 `@deepseek-ai/*` 的 import"，与既有的"Node 半只许 import type"合成一条完整的跨插件红线）。
- **抄写保真度（机械核对，非眼力）**：把 `src/client/ui/ui.css` 与我们抄的那份官方明文 CSS 按选择器映射表逐属性比对，**零差异**（2026-10-15 起来源是九张官方表：`Button` / `Tag` / `Modal` / `Tooltip` / `Toast` / `Menu` / `Checkbox` / `DisclosureRow` 加 `ConversationRoot` 的 `.widthHandle` 那一族；来源清单以 `ui.css` 文件头为准）。差异只允许三类：类名 `sd-` 前缀、`@keyframes` 改名（它们都在全局命名空间里，撞名会互相覆盖），以及 `ui.css` 文件头点名的**两处自造**（`.sd-resizing`，宿主那份没有对应类；`[data-dsh-session-delete="trash-row"]:focus-visible`，2026-10-16 补的清单行键盘焦点描边，判据在 2026-10-15 §1.3）与**一处已声明的差别**（把手不跟指针画那条短线，由 JS 侧 pointer capture 承担）。**声明条数不再钉在文档里**——上一版钉的是"214 条、六个模块"，抄写的表一多它就变成假基线，比对口径改成"按来源表逐属性零差异"。四段动画体（`modalEnter` / `tooltip-in` / `dsh-toast-in` / `dsh-toast-fade`）也逐字核过。
- **几何（headless Edge + 宿主深色 token，真组件渲出来的 DOM）**：把 `TrashPanel`（3 条 / 2 组，JSdom 里渲出的 DOM 原样搬进量尺页）+ 深色 token（从 `app.asar` 的 `dsh-client-ui-theme/lib/client.js` 抽 416 个变量，抽查 `bg-base #151517` / `bg-layer-2 #2c2c2e` / `label-primary #f9fafb` / `state-error-primary #f25a5a` 与实测记录一致）+ `ui.css`，在 1200px 与 405px 两档宿主中央列上量：**正文列宽 760（宽档；窄档 357 = 405 − 24×2 内边距）、三张卡片等高 57px、按钮 28px(sm)/36px(md)、圆角 16px/8px、页与滚动区横向溢出均为 0、行内 danger 计算底色 `rgba(0,0,0,0)`、批量那块 `rgb(242,90,90)`、确认框 380px 宽居中且圆角 28px** —— 与 2026-10-01 那批在**真机**上量到的数字逐项一致，即"自造控件没改变 §7 的界面规格"。
- **活宿主复核（2026-10-02，隔离 `DSH_HOME` + 镜像 desktop 组成的 `sdcheck` profile + `plugin add link:`，宿主 desktop 0.2.0-rc.2）**：① 侧栏出「回收站」`panelRow`、点开后面板挂载（`[data-dsh-session-delete="trash-panel"]` 在）、`aria-current="page"` 由宿主置上；② **控制台零条消息**（连 warn 都没有，更没有 `web boot: N entry did not activate`，也不见 `pending (waiting for service…)`）⇒ `ctx.get('locale')` 那条路在真宿主上成立；③ 我们的 `<style data-dsh-session-delete>` 在文档里 ⇒ 那条"工厂物化时注入 `<style>`"的通道真的被宿主收下了；④ **切语言当场生效**：把界面语言切到 English 后 `document.documentElement.lang` 变 `en`，侧栏那一行由「回收站」变 **`Trash`**、面板内文案整体变英文（"The trash is empty / Refresh / Pick Delete in a session's '…' menu…"）——**这一条是 locale 接线的判决性读数**：我们自己的兜底只有中文，出英文只可能来自宿主服务 + 我们的 `en` 字典，且面板行名走的是 thunk（`syncPanels` 在 `locale/change` 时重读）。**这一趟用脚本里的 DOM `click()` 驱动**（切语言、开面板），不是真指针：本环境的会话内浏览器没有可视表面，指针动作被拒（`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE … viewport=0x0`）。
- **人眼那一层（2026-10-02，用户真机）**：本环境的会话内浏览器没有可视表面（指针动作被拒），所以交互与"有条目的面板"由用户在**他自己的真机**上按日常用法跑过一遍，逐条勾选确认覆盖到四件：① 悬停「删除」那一行的原因提示、确认框（Esc / 点蒙版关、关完焦点回原位）、撤销提示停留 6 秒；② **有条目的**回收站面板在真宿主里的样子（深色配色下的卡片列表）；③ 整条流程 删 → 恢复 → 彻底删除；④ 删完之后侧栏不再出现那一行。**记录口径**：这是用户的目视结论（勾选确认），**没有截图、也没有逐字读数**——与 2026-10-01 那批"用户截图 + 我逐项读数"的证据等级不同，如实记在这里。

**2026-10-15「两栏 + 单条详情」这一批的验收状态**（改了浏览器半**和** Node 半：Node 半必须重启宿主，浏览器半那趟仍按 AGENTS.md 的硬约束要在有可见浏览器的隔离 home 上过——**下面除最后一条真机门外都是本地读数**；2026-10-15 同日又追加了一批"渲 Markdown + 抄宿主样式"的改动，读数按同一批列在下面）：

- **单测**：244 条全绿（`tests/` node project + `tests/client/` jsdom project）。新增六处：`tests/zstd-frames.test.ts` 11 条（无尾／有尾两变体、无缝铺满、每片解回原文、一帧多块的 Raw 双块、块界越界必抛、截断帧必抛、空 buffer 零帧；**那一行曾钉"9 条"，2026-10-16 按 `vitest run` 重读更正为 11**）、`tests/session-log.test.ts` 6 条（跨帧顺序、一帧多行、**半行跳过并计数**、带字典的帧解压失败 ⇒ 说清第几帧、非对象行交给策略层、空输入全零统计）、`tests/trash-detail.test.ts` 11 条（按清册定位、注入四类不进正文只进计数、推理与工具调用不进正文、认不出的 type 忽略、条目缺席 `trash-empty` 且一次文件读都不做、目录/日志不在 `io`、读盘抛带原文、载荷闸与 `omitted`、生产两个闸值 3000/500000 钉死）、`tests/api.test.ts` +5 条（成功信封不回灌清册字段、`trash-empty`、`io`、方法/字段自检、栅栏四形态）、`tests/client/` 新增 `trash-detail.test.tsx` 16 条（这里曾钉"15 条"，2026-10-16 按 `vitest run` 更正）与 `use-panel-width.test.tsx` 3 条、**`tests/client/markdown.test.tsx` 6 条**（块级结构真被渲〔标题/列表/粗体/GFM 表〕、围栏与行内码分开、**裸 HTML 变不成节点**、链接渲成文本且地址只进 `title`、图片渲成「[图片 · alt]」、样式挂在 `.sd-md`）。
- **渲 Markdown 之后的两条实测更正**：① `tests/client/trash-detail.test.tsx` 补 2 条（这两条已含在上面那份 16 里，不是 15 + 2）——**同一段源在用户与助手两侧长出不同 DOM**（用户那侧反引号与星号仍是字面、`code`/`strong` 一个都没有）与**只有用户那一行有气泡**（`[data-sd-bubble]` 全页恰好一个，且父级是 `[data-sd-msg="user"]`）。② 裸 HTML 那条用例第一次写错了：我以为 react-markdown 默认**丢掉**那段源，实测（10.1）它是**转义成字面文本**——页面上看得见 `<img …>` 这串字符，但它落成不了节点。用例与 `src/client/markdown.tsx` 的收口注释都按实测改正。
- **依赖与纯度（新增 `react-markdown@10.1.0` + `remark-gfm@4.0.1` 之后重跑三道门）**：`pnpm test`／`pnpm typecheck`／`pnpm build` 退出码 0／0／0（**不许接管道**，否则退出码被吃掉——本仓栽过一次）。浏览器半产物 **755.74 kB（gzip 166.08 kB）**，其中本仓源码 136.5 kB、inline 进来的第三方 **686 kB / 71 个包**（最大三块：`micromark-core-commonmark` 110kB、`mdast-util-to-hast` 49kB、`mdast-util-to-markdown` 41kB——最后一块是 GFM 的**序列化侧**，我们只解析不产出，被 dep 图拖着）。产物里的 `require()` 仍然**只有** `react`、`react-dom`、`react/jsx-runtime` 三个键 ⇒ 平台表之外的东西一个都没漏进去。**过程中构建失败过一次**（真缺陷，不是配置噪声）：`unified → vfile` 用 package.json 的 `imports` 分流 Node/浏览器两套实现（`#minpath: { node: …, default: ….browser.js }`），而 CJS 输出下 rolldown 按 Node 条件解这张图，选中了带 `node:path`/`node:url`/`node:process` 的那一支 ⇒ 撞我们那道纯度门。**先把 importer 打出来定位**（临时把 importer 塞进门报错信息、跑一次构建），再试最小变量（把 `'require'` 从 `conditionNames` 摘掉——**不改变结果**，条件是解析器自己加的，我们这一层摘不掉），最后在 `tsdown.config.ts` 加 `resolveBrowserBranchImport`：只认那三个 `#` 请求、且**必须**在同级目录找得到 `.browser.js` 才接，否则返回 `null` 交回默认解析让纯度门重新响。`tests/skeleton.test.ts` 为它补 3 条（含一条"真装的 vfile 旁边确实有那三个浏览器实现"）。
- **存量用例的改写账**：`tests/client/trash-panel.test.tsx` 到这一批是 31 条（复核批之后 61 条，见下面的第六批）。2026-10-15 那一版把动作退出行时，原 20 条里 6 条"行内两颗按钮"被改写成"先选中再看详情"（**一条都没删**）；动作回行内之后**那 6 条又逐项改回原断言**，同时保留新加的交互（两栏/下钻/键盘/缓存/详情失败隔离）与"详情里不摆动作"那条反向钉子。**账要对得上**：改回来的是 6 条，不是 6 条新增。`tests/client/index.test.tsx` 的夹具补了 `detail` 成员，断言未动。
- **几何（一次性量尺页：jsdom 渲出的真 DOM + `ui.css` + 从 `app.asar` 抽出的宿主 token 两套〔浅 388 个变量 / 深另算，静态表 197 个〕，headless Chromium 上量）**：1200 与 2400 两档 **左栏 420**（`box-sizing:border-box`，含给滚动条的 10px 内边距）/ **行标题区 214 + 行动作区 152** / 行高 **57**（与 2026-10-01 真机读数一致）/ 行内两颗按钮在位 / 横向溢出 **0**（面板、左栏、详情三处各为 0）/ 中间那一格 10px（`.sd-width-handle` 的命中区，视觉线是 `::after` 的 2px、静止时 `opacity:0`） / 选中态 深 `rgb(67,69,74)`+`rgb(129,133,140)`、浅 `rgb(235,238,242)`+`rgb(151,157,166)`，未选中 深 `rgb(44,44,46)`、浅 `rgb(255,255,255)` / 「彻底删除…」计算底色 `rgba(0,0,0,0)`、字色 深 `rgb(242,90,90)` 浅 `rgb(236,19,19)` / 页脚那块是整页唯一实心红 / 2400 档正文按 **860** 收口 / 断点下沿 900 档 清单 411、详情 399、正文 389、溢出 0（2026-10-15 复核批重量：地板从 480 改到 489 之后，那一档的清单被夹到 411，详情正好落在 399 那条下沿上；旧读数"详情 399 / 正文 374"按的是中间 1px 分隔，已经翻篇）；405 档下钻 详情 357、正文 332、「← 返回清单」在位、溢出 0；**同一份两栏 DOM 硬塞进 405px ⇒ 详情横向溢出 74、整框 82**（这就是断点存在的量化理由）。上面这批数字在动作回行内、左栏 316→420、阈值 760→900 之后重量过一遍，与 `src/client/trash-panel.tsx` 的三个常量逐项一致。
- **抄完宿主样式之后的重量（同一条量尺路：jsdom 渲出的真 DOM〔含 `<TrashPanel>` 走到"详情已渲"那一帧〕+ `ui.css` + `markdown.css` + 从 `app.asar` 主题包里抽出的 416 个 token 注进 `:root`，真 Chromium 上量）**：正文 `.sd-md` **14px/24px**（= 宿主 `--dsw-font-markdown-base` 在 `--dsh-content-font-size:14px` 下的读数）、`h2` 19px/28px/700、`p` 上下各 16px、代码块 **11px/19px** + 内边距 16 + 圆角 16px + 底色 `--dsw-alias-markdown-code-block`、行内码 12.25px（`0.875em`）圆角 8px、表头表体 13px 内边距 `10px 16px`。**用户气泡** 底色 `rgb(237,243,254)`（= 浅色 `--dsw-specific-bubble` → `--dsw-static-deepseek-50`）、圆角 20px（`radius-xl`）、内边距 `10px 16px`、14px/22px、`pre-wrap`；**助手那一行** 计算底色 `rgba(0,0,0,0)`、边框 `0px`、宽度铺满正文栏（372 / 672 / 330 三档各等于那一档的 `.sd-md` 宽）。**横向溢出**：面板框 0（900／1200／405 三档），清单列 410（420 扣内边距）、行高 57、两颗按钮右缘 420 与 314 都在行内；长标题那行的 151px 是 `text-overflow:ellipsis` **有意**吃掉的。**唯一的横向滚动落在表自己身上**：表 `display:block` + `overflow-x:auto`，`scrollWidth-clientWidth` 在 900／1200／405 三档分别是 404／104／446，父层与整框仍为 0 ⇒ 文件头那条"宿主用 `.tableScroll` 那层 div，我们只能把滚动挂在 `table` 上"的差异**成立**（匿名表盒按 CSS 2.1 §17.6.2.1 继承 `border-collapse`，行间实测无 1px 缝：`tr` 顶边 669→711.5→774.5 与上一行高度严丝合缝）。**量法先验过**：token 第一次抽取用块级正则，抽出的表里有 `--dsw-font-markdown-base` 但浏览器算出来是空——原因是宿主把 CSS 装在 JS 字符串里、值中带 `\"` 转义，转义不解开整条声明被解析器丢掉（读数会退化成 16px/normal，看着像"宿主就是这个字号"）；改成按 `--名:值;` 抓 + `JSON.parse` 解转义之后读数才对上。**截图仍拿不到**：本环境的会话内浏览器没有可视表面（`take_screenshot` 报 `visible=false`）。
- **真机门（§8 门 4 那条硬约束）：未跑，交用户**。判据清单见本仓 2026-10-15 那档 §4 第 6 条与交付时的可勾选表；本环境的会话内浏览器没有可视表面（指针动作被拒），所以"选中一条出正文"这类交互只能由他在真机上目视，量尺页与单测都替代不了它。

**2026-10-15 同日第二批「折叠 / 收起 / 拖栏 / 多选」的验收状态**（只动浏览器半 ⇒ 走 HMR；按 AGENTS.md 那条硬约束仍要在有可见浏览器的隔离 home 上过一遍再装 live profile）：

- **单测**：272 条全绿（244 → 272）。新增 `tests/client/use-column-resize.test.tsx` 9 条（默认值、上下限夹住、面板变窄时读数重新夹、←→/Home/End、separator 的 aria 三件、"按下才算在拖"、没按着时 move 不动、`max < min` 时停在 min）、`trash-panel.test.tsx` +19 条（折叠那一组后条目不进 DOM / ↑↓ 跳过折叠行 / 折叠时 `aria-activedescendant` 不悬空 / 一键全部折叠展开 / 收起清单后详情铺满 / 窄档没有收起与分隔线 / 拖栏与键盘改列宽 / 收起再展开不丢宽度与折叠；多选 10 条：两颗按钮退场、点行切换勾选且不改详情、**直接点勾选框只翻一次**（`Checkbox` 里 `stopPropagation` 的钉子）、未勾选时页脚置灰且不弹确认、按清单顺序串行 `purge` 并重读一次、部分失败原文留各行、重读后剔掉不存在的 id、收起左栏自动退出多选、`aria-multiselectable` 与 `aria-selected` 两套语义、Enter/Space 切换光标行）。
- **一处被实测推翻的算数**（记下来因为它改变了对"下限该定在哪"的判断）：`LIST_COLUMN_MIN` 第一版按"行内两颗按钮放得下"算出 280，真 Chromium 上按 10px 一档扫 240→420 发现**按钮那一档从来不是约束**（两颗按钮 `flex:none`，再窄也是文字列缩，240 也"放得下"），真正的下沿是「删除于 … · 224KB」那一行什么时候不再被省略号截断：280 差 50px、320 差 10px、**330 归零** ⇒ 定 330。同一次扫描顺带读到：420 档长标题被省略号吃 151px（有意）、多选档勾选框占 16px 后标题多截 15px、四档横向溢出全 0（面板框 / 清单列 / 工具排各为 0）。
- **构建与纯度**：`pnpm test`／`typecheck`／`build` 退出码 0／0／0；浏览器半 **777.81 kB / gzip 173.24 kB**，产物里的 `require()` 仍只有 `react` / `react-dom` / `react/jsx-runtime` 三个键（这批没引任何新依赖）。`ui.css` 那份抄本多了两张来源（`Checkbox.module.css`、`DisclosureRow.module.css`）与一处**点名的自造**（`.sd-resizing`），文件头已记；§8 门 4 那条"逐条声明比对"下次复核时要按新的来源表数。
- **真机门：未跑，交用户**。这一批尤其依赖目视：拖动的跟手感、折叠动画缺省是否难看、置灰按钮的悬停原因提示在真宿主菜单/面板的裁剪容器里出不出得来（`Tooltip` 走 `portal`，但只有真机能证）。

**2026-10-15 同日第三批「那一排常驻 + 组勾选」的验收**（真机反馈四句：收起那颗位置不对、刷新不该在头部、组名要左对齐、多选要能整项目选；仍只动浏览器半）：

- **单测**：278 条全绿（272 → 278）。新增 7 条：刷新变图标（无文字、按 `aria-label` 点得动、仍重读一次、且它住在那一排里）、那一排常驻（收起后只剩「展开清单」+ 刷新，「全部折叠」「多选」随清单隐去，再展开都回来）、多选态每个组头一颗勾选框（非多选态一颗没有）、点组头 = 该项目全部条目入选且**含折叠的组**、三态（半选 → 勾满 → 再点清空，含 `aria-checked="mixed"`）、点勾选框不触发折叠、组头 `textAlign: start`。
- **几何（同一条量页路，四档：默认 / 收起 / 多选 / 拖到 330）**：那一排宽 = 清单列宽（420 / 330），刷新贴排的右缘（445 / 355）；图标两颗各 36px、文字那颗 68/44px；组头 `textAlign: start`、标题左缘 74px（多选态让给 16px 勾选框 + gap 后 96px）、计数右缘 433 = 列内右缘；330 那一档**元信息截断量 0**（印证下限）；四档横向溢出全 0。
- **构建**：`test`／`typecheck`／`build` 退出码 0／0／0；浏览器半 **783.09 kB / gzip 174.82 kB**，`require()` 仍只有 React 家族三个键（这批没引依赖，只多抄了一枚官方 `IconPanelLeftOutline` 几何）。`ui.css` 那份抄本因此又多一条**点名的自造**（组头那颗按钮的 `text-align`，宿主那份是 div 不需要）。
- **真机门**：同上一批——拖动手感、图标按钮密度（一排四颗里两颗是图标）、悬停说明在真宿主里出不出，仍只能他目视。

**同日第五批：删掉「整条左栏收起」**（用户一句"感觉没啥用"）。跟着走的有：`listCollapsed` 状态、`toggleListCollapsed`（连带它"收起时自动退出多选"那条耦合——没有收起就没有这条要防）、`trash.toolbar.collapseList` / `expandList` 两个键（zh+en 一起摘，键集合仍逐字相同）、官方 `IconPanelLeftOutline` 那枚几何（只有它在用，不留死代码）。**留下的**：那一排仍在面板体顶端（理由换成"不随长清单滚走"，用例从"收起后还在"换成"它是面板的直接子级、不在清单列的滚动容器里"）、刷新仍是图标、清单列宽仍可拖。用例 278 → 276：**删 3 条**（"收起后清单不在 DOM"、"收起时自动退出多选"、"收起后那一排只剩两颗图标"）、**加 1 条**（那一排是面板的直接子级、不在清单列的滚动容器里——把"常驻"这条从"为了收起"换成"为了不被滚走"）、**另 2 条改写成不依赖它的形状**（"窄档没有分隔线"、"折叠与拖宽互不干扰"）；`typecheck` 0、`build` 0，浏览器半 **780.64 kB / gzip 174.23 kB**（比带着它小 2.45 kB），`require()` 仍只有 React 家族三个键。

## 9. 实现前先验的前提（已实测，2026-09-30）

探法：探针跑在**隔离数据根**上——`DSH_HOME=<临时目录> dsh --profile t1probe --from-default-profile web --patch <探针 patch> --no-open --port 0`（宿主 = desktop 0.2.0-rc.2 自带 CLI；探针是一份纯 ESM `probe.mjs`，用 `--patch` 的 `insert` 挂进 profile，跑完即删、不入库）。

- **平台模块表（外壳冻结基线）：成立**。**（本条的"我们用 primitives/slots"是 2026-09-30 当时的取数结论；2026-10-02 起本插件不再 import 任何宿主客户端包，`PLATFORM_MODULES` 收到 React 家族三个键——裁定与代价见 §10，本节保留原始实测不改写。）** 它是外壳 bundle 里 `staticModules` 的实参，**9 个键**：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。我们组件要用的四样里，**React 家族 / primitives / slots 在表内**；**`@deepseek-ai/dsh-client-connection` 不在表内**——它在 asar 里是一条**动态包 row**（自己的 `package.json` 声明 `dsh.client.platform === "web"` 并导出 `./client`），浏览器半对这张冻结表只做**精确键匹配**，未命中的 `dsh.client.external` 请求才会落到 `graphRows.get(<包名>)`（它自己的 row，`<pkg>/client` 与裸包名等价）⇒ 我们的 client bundle 要用 connection，就必须在 `dsh.client.external` 里**逐字**声明它。（**已证的是：「不在 9 键表内」**；「它是动态包 row / 必须走 external 精确请求」由下面 ②③ 两条原文坐实，不再是推断。）证据（全部只读 `app.asar`，取数命令见本条目末）：① 静态表：`dsh-web-frontend/dist/assets/vendor-CCJJTK99.js` 里 `function rM(){return{react:Ef,"react/jsx-runtime":If,"react-dom":Rf,"react-dom/client":Df,"@deepseek-ai/cordis":sf,"@deepseek-ai/dsh-client-store":lh,"@deepseek-ai/dsh-client-ui-slots":hh,"@deepseek-ai/dsh-client-ui-primitives":sE,"@deepseek-ai/dsh-client-ui-dockkit":XS}}`，以及 `this.modules=o.create({boot:n.__DSH_BOOT__,staticModules:rM(),…})`。② connection 的声明与 bundle：`dsh/node_modules/@deepseek-ai/dsh-client-connection/package.json` 原文含 `"exports": { "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" } }` 与 `"dsh": { "client": { "inject": [], "platform": "web", "immediately": true } }`；同包 `lib/client.js` 在 asar 内实存（59411 B）。③ 解析路径（`dsh-client-modules` 两半的原文）：Node 半 `lib/index.js` 只把 `decl.platform === "web"` 的包变成 client row —— `if (decl === void 0 || decl.platform !== "web") { this.pkgMeta.set(sourceKey, null); return null; }`，紧接着缺 `./client` 导出即抛 `client-modules: <pkg> declares dsh.client but exports no "./client" bundle`；同文件 `orderByModuleGraph` 的 JSDoc 是 "An `external` specifier is either the package row it names (`<pkg>/client` aliases the bare package) or a static-table name that adds no graph edge."，实现即 `rowsById.get(name) ?? rowsById.get(stripClientSuffix(name))`。浏览器半 `lib/client.js` 的冻结表就是 `this.seed = new Map(Object.entries(options.staticModules))`（= 上面 9 键），到达循环是 `for (const request of row.external) { const id = stripClientSuffix(request); if (this.seed.has(request) || this.loadCache.has(id)) continue; const dependency = this.graphRows.get(id); if (dependency !== void 0) await this.arriveDependency(row.id, dependency, next, visited); }`；seed 与 row 都没有该名字时抛 `client-modules: require("<spec>") missed the module table — not a platform seed word, not a materialized module, and no registered package factory`。**坑**：把 `app.asar` 里所有 `"@deepseek-ai/*"` 字符串拉出来会得到 312 个包名（含 Node 半），那不是这张表，整串抄进 `PLATFORM_MODULES` 是错的。
  取数命令（照抄即可，只读 asar；非可打印字节已替换成 `.`）：

  ```bash
  A="<DeepSeek Harness 安装目录>/resources/app.asar"   # Windows 默认在 %LOCALAPPDATA%/Programs/DeepSeek Harness 下
  # ① 9 键静态表
  node -e 'const fs=require("fs");const s=fs.readFileSync(process.argv[1]).toString("latin1");const i=s.indexOf("\"react/jsx-runtime\":");console.log(s.slice(i-40,i+420).replace(/[^\x20-\x7e]/g,"."))' "$A"
  # ② 取 asar 内任意文件（换路径即取别处，如 dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js）
  node -e 'const fs=require("fs");const A=process.argv[1],p=process.argv[2];const fd=fs.openSync(A,"r");const h=Buffer.alloc(16);fs.readSync(fd,h,0,16,0);const L=h.readUInt32LE(12),base=8+h.readUInt32LE(4);const jb=Buffer.alloc(L);fs.readSync(fd,jb,0,L,16);let n=JSON.parse(jb.toString("utf8"));for(const seg of p.split("/"))n=n.files[seg];const b=Buffer.alloc(+n.size);fs.readSync(fd,b,0,+n.size,base+ +n.offset);process.stdout.write(b.toString("utf8"))' "$A" dsh/node_modules/@deepseek-ai/dsh-client-connection/package.json
  ```
- **槽位名：验证时机 = 客户端半首次注入（菜单项、面板行与中央面板见 §10）**。`slots` 是浏览器侧注册表（`@deepseek-ai/dsh-client-ui-slots` 是上表里的静态键），**Node 半注入不到**——实测：`inject` 数组带 `slots` 时插件停在 `pending (waiting for service: slots)`；不带 `slots` 时读 `ctx.slots` 抛 `cannot get property "slots" without inject`。所以 Node 半的探针**验不了槽位名**；`sidebar.workspaces.session.menu.item` / `shell.overlay` / `sidebar.panellist` / `main` 成立与否由客户端半首次注入判（官方规则：撞未声明槽位在**插件激活时**响亮失败；`main` 另有第二条：`selectPanel` 对没注册面板的 id 抛 `main panel "…" is not registered`，asar @21199710——所以面板那条**必须与行同批**注册）。
- **客户端 `remote.<namespace>` 的 `$mount` / loader 契约：已实测——这条路对一个薄插件不成立，通道据此改建**（原先是"未成立的前提"，现已是结论 + 裁决）。浏览器侧 `remote.<ns>` **只能**由**生成的 Typert 远程描述符贡献**经 `ctx.remote.$mount(...)` 挂上：网关客户端面原文 `function remoteServiceKey(namespace) { return \`remote.${namespace}\` }` 与文件头注 "Client projection of generated Typert Remote descriptors. Contributions install traced remote.<namespace> services."；盒内装配 `@deepseek-ai/dsh-api-remotes/lib/client.js` 的 `$mount` 走的是一份**写死的 25 条**官方清单（productAnalytics / agentPresets / userQuestions / commands / account / sessionController / jobController / workspaceController / terminal / pluginManager / pluginInventory …），**不含、也不会包含第三方包**；官方同形包（`@deepseek-ai/dsh-cordis-host-runner` / `-dsh-client-ui-plugin-manager` / `-dsh-host-plugin-inventory`）都自带生成物并声明 `exports["./typert"]` → `lib/typert.host.js`、`exports["./remote"]` → `lib/typert.remote-client.js`，`files` 里列这两个文件。**生成器本身也卡在本仓的仓形上**（只认 `<root>/packages/<pkg>/` 布局、靠源码装饰器发现、`./client` 只反推 `src/client.ts`），且全宿主**没有动态发现**（`'/remote'` 零命中）⇒ 第三方要那个命名空间只能**自挂自**（生成物 + `zod` + 搬包布局）。⇒ 裁决：**通道改建在宿主自己的 web server 上**（§10），客户端半**只声明 `slots`**（只声明本插件构建产物或宿主公开面保证存在的成员），取数通道一律**运行时探测** + 缺席则优雅缺省（§7「未接通态」）。**声明错东西的代价不是报错而是装机即崩**：前端启动自检逐字 `Error: web boot: 1 entry did not activate` / `@xrn1997/dsh-session-delete: pending (waiting for service: remote.sessiondelete)`，桌面壳把这条升级成 `reportFatal(..., "web-boot")` 并结束整个进程。
- **宿主服务能否注入：成立**。`workspaceController` / `workspaceRegistry` / `sessions` / `storageDomain` 四项写在第三方插件的 `inject` 数组里**全部 resolve**（都读到 `object`），插件正常 activate 并打印。实证：隔离宿主日志里 `probe: apply reached: every declared dependency resolved` + 四行 `ctx.<service> -> object`。**退化路径（只做文件层）不需要**。
- **`attachSession` / `detachSession` 成立——但挂在 `registry.get(wsId)` 返回的实体上，顶层没有；§4 触点② 不需要改**。前一轮测的是**顶层**成员面（`workspaceController.attachSession` / `workspaceRegistry.attachSession`），拿到 `undefined` 是**假阴性**：这两个方法属于 `Workspace` **实体**。两路证据：(a) `app.asar` 的接口声明目录里有 `{ name: 'Workspace', declaration: 'export interface Workspace { readonly id; readonly path; readonly title; readonly createdAt; readonly updatedAt; readonly sessionIds; setTitle(title): Promise<void>; attachSession(sessionId: SessionId): Promise<void>; insertSessionBefore(sessionId, beforeSessionId?): Promise<void>; detachSession(sessionId: SessionId): Promise<void>; status(): Promise<"ok" | "missing-dir">; }' }`（`WorkspaceArchiveSessionRequest` 等请求形状在同目录里逐条可读），实体实现即唯一写路径 `mutate` 上的 `sessionIds` 增删——`attachSession` 把 id 前插、`detachSession` 过滤掉，`mutate` 再按 `id + canonical cwd` 剪一遍；(b) **隔离数据根上的运行时探针**（2026-09-30 第二轮；`registry.list()` 为空时先 `registry.create(<临时目录>)` 造一个再 `get`）：`entity constructor.name -> WorkspaceEntity`、`typeof entity.attachSession -> function`、`typeof entity.detachSession -> function`、`typeof entity.insertSessionBefore -> function`、`typeof entity.status -> function`；**同一次运行的对照**是顶层的 `registry.attachSession` / `registry.detachSession` / `controller.attachSession` / `controller.detachSession` 全为 `undefined`——实体面成立与顶层面缺位在一次运行里同时拿到。**官方 `workspaceController` 的 remote 面一共 11 个**（`@Remote(...)` 装饰器原文）：`create`、`initializeDefault`、`rename`、`delete`、`insertBefore`、`insertSessionBefore`、`archiveSession`、`unarchiveSession`、`pinSession`、`unpinSession`、`follow`（流）。其中 `archiveSession` 的注释是 "Hide one known Session from Workspace grouping surfaces"（即 §4 触点③ 的全局归档集），`insertSessionBefore` 是 "Move one accounted Session within a Workspace"（排序），`delete` 是 "Delete one **workspace registration** while retaining its directory and every session log"——**§1 证据 1 引的正是它，删的是工作区不是会话**。而 `workspaceRegistry` 的 `Service.init` 序列是 `listStoredHeaders → replaceHeaderIndex → bootstrap → indexLiveSessions → rebuildEntities → reportFilteredCandidates`，即成员资格**至少有一部分是从磁盘 header 索引推出来的**（另见注释原文 `their accounting slots remain either way so unarchiving restores position`）。⇒ **§4 触点② 就按 `ctx.workspaceRegistry.get(workspaceId).detachSession(sessionId)` / `.attachSession(sessionId)` 写，不需要改设计**。
- **同批落下的宿主接口原文**：`WorkspaceRegistry.inject = ['storageDomain', 'sessionPersistence']`；`get(id) { return this.entities.get(id) }`（`entities = new Map()`），`create(path, title?)` 要求一个**已存在的绝对目录**（`realpath` 规范化，相对/不存在/非目录一律拒绝）；`delete(id)` 是**删工作区注册**（保留目录与每一份会话日志），**未知 id 是幂等 no-op**（返回 `false`）。
- **`archiveSession(sessionId, options = {})` 的真实语义**（JSDoc + 实现原文）：会话必须已知（`sessionKnown`：live 或已持久化，**与它有没有 workspace 账目无关**）；不带 `options.stopActivity === true` 时先问一次活跃（判据见 §5），**有任何活动即抛 `WorkspaceActiveSessionError`、一个字节都不写**；带 `stopActivity` 则跳过活跃检查、写完档再请 `workspace/session-stop` 的提供方停活；**归档在同一次持久化写里丢掉该会话的 pin**（pin 与归档互斥）；**已归档的 id 直接返回**（不写、不问、不停）；未知 id 抛 `WorkspaceUnknownSessionError`。对应 zod 请求形状：`archiveSession` = `{ sessionId, stopActivity?: boolean }`、`unarchiveSession` / `pinSession` / `unpinSession` = `{ sessionId }`、`insertSessionBefore` = `{ sessionId, beforeSessionId? }`——两侧都按这个形状验参。
  原文切片（`node -e` 把 asar 读成 latin1 后 `lastIndexOf("Archive one session durably")` 前后切片，非可打印字节打成 `.`；命中处 = `dsh/node_modules/@deepseek-ai/dsh-workspace/lib/types/index.js` +12995。下面这段把 `.` 还原成换行按可读形态排布，字面量与命令输出逐字一致）：

  ```bash
  node -e 'const fs=require("fs");const s=fs.readFileSync("<DeepSeek Harness 安装目录>/resources/app.asar").toString("latin1");const i=s.lastIndexOf("Archive one session durably");console.log(s.slice(i-60,i+2600).replace(/[^\x20-\x7e]/g,"."))'
  ```

  ```js
  /**
   * Archive one session durably. The session must exist (live or in session
   * persistence); its workspace accounting ... or lack of one ... is irrelevant.
   * Without `stopActivity` the session must also be inactive: the
   * `workspace/session-activity` waterfall is asked once, and any reported
   * activity rejects with {@link WorkspaceActiveSessionError} before anything
   * is written. With `stopActivity` the archive is written without an
   * activity check, and the `workspace/session-stop` providers are then asked
   * to stop the session's work: the durable archive set is what a provider's
   * `agent/pre-step` gate reads, so every wake the stops induce is already
   * blocked. Archiving drops the session's pin in the same durable write.
   * (pinning and archival are mutually exclusive). An already archived id
   * resolves without writing, asking, or stopping.
   * @param sessionId - The session to archive.
   * @param options - Whether running work is stopped instead of refusing.
   * @returns resolution after durability and, with `stopActivity`, after every stop request was issued.
   */
  archiveSession(sessionId, options = {}) {
      return this.enqueueOperation(async () => {
          // The chain slot serializes against every other registry write, so this
          // check-then-write pair cannot interleave with another archive.
          if (this.requireState().archivedSessionIds.includes(sessionId))
              return;
          if (!(await this.sessionKnown(sessionId))) {
              throw new WorkspaceUnknownSessionError(sessionId, 'archive');
          }
          if (options.stopActivity !== true) {
              const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]));
              if (activity.length > 0)
                  throw new WorkspaceActiveSessionError(sessionId, activity);
          }
          const state = this.requireState();
          await this.setState({
              ...state,
              archivedSessionIds: [...state.archivedSessionIds, sessionId],
              pinnedSessionIds: state.pinnedSessionIds.filter(id => id !== sessionId),
          });
          if (options.stopActivity === true)
              await this.stopSessionActivity(sessionId);
      });
  }
  ```

  ⇒ 三条语义逐行可见：**已归档 = 一进来就 `return`**（不写、不问、不停）；**丢 pin 与归档集同一次 `setState`**（pin 与归档互斥）；**`stopActivity` 时先写档、再 `stopSessionActivity`**；不带 `stopActivity` 时先问 waterfall、有活动即抛、一个字节都不写。`sessionKnown` 另取一处（同法换字面量：`lastIndexOf("Whether a session is live, header-indexed")`，取 +900）——原文 `async sessionKnown(id) { if (this.ctx.get('sessions')?.get(id) !== undefined) return true; if (this.headers.has(id)) return true; await this.indexHeaders(await this.listStoredHeaders()); return this.headers.has(id); }`，即三个来源（内存 live → header 索引 → 现列一次持久化再查索引），JSDoc 原文 "Only a definite miss returns false ... a failing `sessionPersistence.list()` propagates so storage faults never masquerade as an unknown session."；紧邻的 `stopSessionActivity` 实现是 `await this.ctx.parallel('workspace/session-stop', { sessionId })`（JSDoc：a failing provider is logged, never a reason to keep the session visible）。
- **其余实测成员面**（实现时挑动词用；下面括号里的 55/32/19 是 `Object.getOwnPropertyNames` 沿原型链的点数，**含 `constructor`/`toString`/`__proto__` 等 Object 原型成员，实际服务面更少**——别当契约面用，按动词逐个 `typeof x.y === 'function'` 判）：`ctx.workspaceRegistry`（55）含 `delete`、`deleteKnown`、`archiveSession`、`unarchiveSession`、`pinSession`、`unpinSession`、`insertBefore`、`create`、`createCanonical`、`list`、`listStoredHeaders`、`readSessionHeader`、`resolveByPath`、`sessionPaths`、`sessionKnown`、`invalidSessionPaths`、`stopSessionActivity`、`rebuildEntities`、`table`、`state`、`global`、`headers`；`ctx.sessions`（32）含 `create`、`list`、`get`、`enter`、`detachEntered`、`liveEntryFor`、`prepare`、`fork`、`store`、`projections`、`counter`（`enter` / `detachEntered` 是 live 会话的进出，不是账本成员资格）；`ctx.storageDomain`（19）含 `open`、`closeAll`、`domains`、`reserved`、`get`、`config`；`ctx.workspaceController`（19）= 上面 11 个 remote 方法 + `typertRemote` / `feed` / `commands` / `config` / `ctx` / `name` / `@deepseek-ai/dsh-typert-protocol/remote-methods`。
- **幽灵行是否出现**（§8 门 1）**已结**（隔离数据根上的数据层取证）——结论见 §8 门 1，归属见 §4 第 ④ 行。

**探针附带观测（实现时要用）**：本宿主 loader 的 `inject` **只支持字符串数组**；写成 `{ required: [...], optional: [...] }` 对象时，对象键被当成服务名，插件停在 `pending (waiting for services: required, optional)`（实测）。隔离数据根确被尊重：临时 home 下自行长出 `.anonymous-user-id`、`.credentials.yaml`（本机新签的 161B 存根，不是用户凭据的拷贝）、`profiles/t1probe/`（`--from-default-profile web` 展开的 4 个文件）、`storages/workspace.json`；同期 live `~/.dsh/profiles/` 里没有多出 `t1probe`。

## 10. 已定的选择与被否决的替代

| 选择 | 被否决的替代 | 理由 |
|---|---|---|
| 删除 = 移入回收站（可恢复）+ 独立的彻底删除 | 一步 `rm` | 误点一次不心疼；代码量与直接 rm 差不多 |
| 只挂官方声明的槽位、**不 disable 任何官方插件** | disable + 替换 `workspace` / `session-projection-cache`（社区归档插件的做法） | 后者为了 UI 覆盖去换宿主服务；实测 2026-09-30 在 desktop 0.2.0-rc.2 上崩：`ui-deliverables … pending (waiting for service: sessionController)` |
| 回收站入口 = **全局面板**（`sidebar.panellist` 一行图标 + `main` 同字 key 的中央面板），清单本体就是那块中央面板 | ① 底栏 `sidebar.footer.action`（原方案，实现过一版）；② 侧栏顶部图标 + 角标（更早被否决的替代） | ① 这条座位的**惯用形**（座位目录 + 官方占用者 CSS 读出来的）是「42px 整行 + 图标 + 文字 + 右对齐 12px 计数」：`client-ui-cordis` 的占用者是 `.layer{flex:none;width:100%;height:42px}` + `.badge{width:calc(100% + 4px)}`，而座位容器只有 `.footerActions{display:flex}`（无 gap、无 wrap）——**它自己的占用者就吃满整行且拒绝收缩 ⇒ 这条座位对第二个租户不稳**（按这套 CSS 在对照稿里量：容器 clientWidth 287 / scrollWidth 394，primitives 那条 106.8px 宽、其中 106px 落在侧栏右缘之外）。而我们交的是 primitives 的 `Button ghost/sm` 小药丸 + `Tag` 芯片，与惯用形完全不同形。**⚠ 2026-09-30 隔离活宿主实测更正**：在镜像 desktop 组成的隔离 profile 上，`sidebar.footer.action` 槽**渲染为空**——`ui-cordis` 虽在组成树里（`--dump-config` 可见 `id: ui-cordis`），它的客户端半并没有挂上那条占用者（侧栏 DOM 逐字 `<div data-slot="sidebar.footer.action" style="display: contents;"></div>`，零子节点）。所以旧实现在真机上的问题，更准确的定性是**「不是这条座位的惯用形」**（孤立的小药丸贴底栏，与下方 42px 的「设置」行不同形），而"被第二个租户整条挤出去"只在 Cordis 占用者真挂上时才发生——**这条判据随宿主组成走，不是常量**。宿主自己的文案也把这个位置认领了：`ui-cordis` 的 `"panel.hint": "运行控制在左下角设置上方的 Cordis 面板"`。② 原来否掉「顶部图标」的理由是「太隐蔽」，但那条 `panelList` 现在是**有名字的一等导航层**——官方「插件」与第三方「小说」都在这儿，`label` 由宿主 `resolveSlotLabel(options.label)` 解析后画成 `.panelTitle`、折叠时还有宿主 Tooltip，与当初设想中那个「只有图标 + 角标」的东西不是一回事。**代价明写**：计数角标没了（glyph 座位 16/18px 塞不下；`label` 支持 thunk，但宿主 `syncPanels` 只在槽位条目变化或语言变化时重读，拿它当活计数必然 stale），条数改住面板头部。读数出处：asar 的槽位声明与 `PanelRow` 渲染原文（§9 与上面的 CSS 原文）。逐格画面曾存于一次性对照稿 `session-delete-ui-relocate.html`，2026-10-01 随两份界面稿一起删除——它记的是**取证当时的形态**，判据全在本节与 §9，删了不影响复现。 |
| 两半之间走**宿主自己的 web server** 上的插件专属前缀路由（`/dsh-session-delete-api`，Node 半四个端点 `GET /list` + `POST /delete|restore|purge`（**2026-10-15 起是五个**：多的那条是 `POST /detail`，用 POST 表达一个读的裁定见那份 §3；**2026-10-16 起是六个**：又多了 `POST /subagent-count`；**2026-10-17 起收成五个段名**——写动词从"一条一段"合成**一段 `POST /apply`**（`{action, ids[]}`，一次 HTTP 带一组 id、逐条回结果，单条就是长度为 1 的批量，仓里不再留第二条执行路径），另加一段**纯探测** `GET /ping`；本条保留各批当时的形状不改写），浏览器半同源 fetch） | ① 官方 typert remote（原方案）；② **不**开通道（只留 Node 半） | ① 原方案的两处硬事实：生成器只认官方仓形（`<root>/packages/<pkg>/` + 源码装饰器 + `src/client.ts` 命名），且浏览器侧没有任何动态发现 ⇒ 第三方只能自挂自（生成物 + `zod` + 搬包布局 + 改客户端逻辑），代价与收益完全不成比例。**2026-10-17 复核补一条被否的**：换宿主 `ctx.connection.admit` / `requestRejection` 当栅栏也**否决**——rc.2 里 `isTrustedApiRequest` 缺 `host` 头**直接 false**、再要浏览器 cookie，而桌面壳转发前把两者都删了 ⇒ 换过去真机全 403（自建栅栏是**必需**，不是债）。② 通道跟着**能力归属**走：本插件没有后端、做的全是编排宿主既有能力，所以**借宿主自己的 HTTP 面**而不是另起一个服务；路由层只搬运，真相/账本/判据全留在宿主那边。**信封刻意与官方 unary 面同形**（`{ok:true,value}` / `{ok:false,error:{code,message,details?}}`），错误码仍是 §6 那五个——所以组件面与既有用例一行都不用改。前缀**必须插件专属**：宿主对重复的 `(kind, path)` 直接抛错，撞了整棵插件树 boot 失败；写口另加**同源栅栏**（回环 ∧ Origin/Referer 与 Host 同源；curl 形态放行），免得任意网页用 simple request 打这条本机写口——栅栏挂在**整条前缀路由**上（读口 `list`、`ping` 也一并拦，客户端探测用的就是被拦的那条读口）。**桌面壳那条路单独放行，且必须有**：壳的 `forwardWebRequest` 转发前删掉 `host`/`origin`/`cookie`/`sec-fetch-site` ⇒ 真机请求没有 `Origin`、只有 `Referer: dsh-app://app/`，判据要按 `protocol` + `host` 比（`dsh-app:` 非 special scheme，`URL.origin` 恒为 `"null"`）——漏了它，真机上四个入口一个都不出现，而 headless 直连 http 的过门读数看不出来。 |
| Node 半 `inject` 加 `webServer`（`dsh-host-webserver` 的服务名，逐字读实） | 服务名只写进变量、读时再试探 | 前缀路由是**能力本身**不是可选装饰：服务不在就该响亮失败（插件 pending 一眼可见，好过四个入口静默失踪）。"通道在不在"是**浏览器那半边**的事，由它自己探测（见 §7），两侧各答自己那一问。 |
| 不做自动过期 | 30 天后自动清 | 魔法数字；回收站增长很慢（本机 85 个会话合计 15M） |
| 不做附件回收 | 引用计数 GC | 需要新索引，属另一件事 |
| 首版不做 agent 工具面 | 挂插件专属前缀的工具让 AI 也能删 | YAGNI，要加是一句话的事 |
| live 会话一律拒绝 | 先停下会话再删 | 不替用户终止正在进行的活 |
| 客户端那一行**等宿主确实不再列它**才消失（动词返回 → 如实通告） | **乐观移除**：点下删除就立刻把行摘掉，不等落盘（旧界面稿 ④ 的「交互规则」里写过这条，2026-10-01 随稿删除时记到这里） | 提前摘行要在失败时说假话：搬文件/摘账本任一步失败都要回滚，而用户已经看见"没了"；通告那条路本来就负责表达"宿主不再列它"，两件事不该由一个动画代劳 |
| **控件与图标自造**（`src/client/ui/*`，按官方技能的处方抄明文 CSS/JS，类名加前缀、只留 token），**拆掉 `@deepseek-ai/dsh-client-ui-primitives` 依赖** | ① 保留 primitives 依赖（peer 精确钉死一代）；② 只把它从 `peerDependencies` 摘掉、运行时照旧 require | 用户 2026-10-02 的裁定是"这个插件不能钉死宿主版本"。**关键事实**：安装闸（`dsh-app-boot` 的 `evaluatePluginCompatibility`）**只比对 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 两类 peer**，而 primitives 是本插件唯一一条 dsh\* peer ⇒ 摘掉它，安装闸就不再由 peer 决定（2026-10-19 起改由 `engines.dsh` 的窗口表达，见 §11 与第十六批）。①被否：官方技能 `references/practices.md` 明写 "Do not require any Harness Client package as a module … They change without notice, a plain-JS plugin has no type check, and a throwing component blanks your slot entry (`slot entry crashed in '<slot>'`)"，而 peer 钉死正是"用安装闸去代替兼容性"这条别扭的路。②被否：那样安装闸放行了、运行时却仍吃一个会变的客户端包，等于把风险从"装不上"换成"装上了也未必对"，而且仍违反同一条官方规则。**代价明写**：控件样式从此由我们维护，宿主换菜单/卡片样式时本插件不会自动跟随（判据：`--dsw-alias-*` token 改名只会让外观变差，不会崩）；抄写保真度由 §8 门 4 的"按 `ui.css` 来源表逐属性零差异 + 两档几何"复核兜着（214 那个条数已不再钉，见第六批） |
| 可见文案收进 `copy.ts` 的命名空间字典，经 `ctx.get('locale')` **可选读**宿主 locale 服务 | ① 把 `locale` 写进客户端 `inject`；② 保持中文字面量散在组件里 | ①被否但不是错的：宿主自己的 `ui-sidebar` 就硬注入 `locale`（它知道那一代一定有）。本插件要跨代活着，而客户端条目 pending = **宿主进程死**（`web boot: N entry did not activate` ⇒ `reportFatal`），所以走宿主对可选服务的官方写法 `ctx.get('…')?.…`，缺席时降级到内置 zh。②被否：官方规则是 "Route visible UI text through the Client locale service"，且面板行名要靠 thunk 随语言切换 |
| 面板行名用 **thunk**（`() => t('trash.title')`） | 注册时把字符串求值好写死 | 宿主 `resolveSlotLabel` 逐字 `typeof label === 'function' ? label() : label`，JSDoc 即 "thunks follow the active locale"，且自带 `ctx.effect(() => ctx.locale.subscribe(syncPanels), 'ui-sidebar: panel labels')` ⇒ 切语言时这一行跟着走。**反向不成立**：`syncPanels` 只在条目或语言变化时重读，拿 thunk 当活计数必然 stale（§7 已记） |
| 详情按需读：**选中一条才去解压那一条**，面板存活期内每条只读一次 | 打开面板就把全部条目的正文预读出来；或每次切换都重读 | 本机实测：读一条最大 135ms、典型 3–80ms，而**全读一遍 2.0s 另加 280.7MB 解压量**——预读把一个瞬时动作变成一次长任务；反过来每次切换都重读，是同一件事白做两遍（缓存 keyed by `entryId`，恢复/彻底删除后丢掉那一条） |
| 详情走 `POST /detail`（体 `{entryId}`），信封与错误码复用现有那五个 | ① `GET /detail?entryId=…`；② 开新错误码（如 `sessiondelete/not-readable`） | ①被否：`dispatch()` 只吃 pathname，`requireString`／同源栅栏／错误映射整套都挂在 POST 支上，改成 GET 只是把同一道栅栏再写一遍，换来的只有语义好看——这条通道只服务本插件自己，没有外部消费者。②被否：条目不在清册 = `trash-empty`、读盘与逐帧解压失败 = `io`，§6 那张表一行都不用加；**多一个码就多一处两侧要同步的地方** |
| **正文只取 `source.kind === "user"` 的提问**，注入块不进正文但条数上屏；不显示推理段与工具调用 | ① 把所有 `user/message` 都当提问摆出来；② 复刻宿主的工具与推理回放 | ①实测不可用：本机最大那条真实提问 21 条、宿主注入块 241 条（`agent-instructions`／`runtime-context`／`skill-catalog`），不过滤就被淹掉；而"少了这么多"必须能跟页面对账 ⇒ `injectedCount` 上线。②被否：这类细节对"该不该恢复"信息量很低——**只给计数，不给回放** |
| **助手正文渲 Markdown**（`react-markdown` + `remark-gfm`），**用户提问仍是原话**（2026-10-15 真机反馈后推翻上一行里"不解析 Markdown"那句） | ① 保持 `pre-wrap` 纯文本；② 自写最小渲染；③ 连用户提问一起渲 | 触发点是他的原话"对话内容没有渲染，直接显示的是纯文本"。①被推翻；②被否：表格、嵌套列表、引用一深就漏，漏出来的样子是"少渲了半段"，比不渲更难查。③被否：用户那一栏是**他打过的那串字**，渲成 markdown 会把反斜杠与反引号的字样改掉——两侧语义不同，只助手侧过 `MarkdownBody`。库那条链的构建代价与 `vfile` 的浏览器分流见 §8 与 `AGENTS.md` |
| **详情消息行的皮肤抄宿主**（`MessageItem.module.css` / `AssistantMarkdown.module.css` / `MarkdownText.module.css`，逐字抄 + 三处有意差异） | 自己按 token 配一版（上一版就是这么写的） | 上一版的"右侧 UI 风格问题很多"具体错在两处：给助手也画了一张带边框的卡片（宿主那侧**只有用户有气泡**），以及字号用了自造的字面量 12.5/11px（宿主走 `--dsh-content-font-*` 那根轴）。抄过来之后，宿主调内容字号、换深浅色时这一栏跟着走 |
| 「恢复／彻底删除」**留在清单行右侧**，详情只负责看（2026-10-15 真机反馈后回到 2026-10-01 的形状） | 曾经落地过一版「退出行、只住详情」；也可以行与详情都放 | 那一版把左栏压到 316 才放得下「光标题」，用户第一眼的判断就是「左侧太窄」；而失败原文也跟着动作搬进详情之后，"动作与它的原因"被拆到两处。**代价回到我们这边**：两栏共存时左栏要 420px，详情那一栏在窄窗里更快触顶（阈值因此从 760 抬到 900，见 §7）。他 2026-10-15 的裁定原话：按钮还要和之前一样 |
| **多选能删也能恢复**（2026-10-15 同日第二批先开批量彻底删除；**2026-10-17 按用户裁定补上批量恢复**，判据与形状见 10-15 稿 §13） | ① 两套动作并存（多选态下行内两颗按钮照旧在位）；② 不进入"模式"，勾选框常驻行左侧 | ①被否：上一轮刚因为"行内挤不过去"回退过一次，两套语义叠在一行里只会再叠一次宽度账；而且批量确认框旁边还挂着一颗单条「彻底删除…」是手滑的邀请。②被否：常驻勾选框每天占掉标题 ~24px，而多选是偶尔用的。**代价**：一次点击换一种语义，`aria-selected` 在两态下说的是两件事（选中看详情 / 勾选进批量），所以两态各留了用例钉住；批量恢复另带确认框（去向是各自的原项目目录），页脚两颗按钮的形状见 10-15 稿 §13 |
| **批量执行一次 `POST /apply`（Node 半内部串行逐条），顺序按清单从上往下**（2026-10-17 第十二批把"浏览器半串行逐条各发一次"收成一段） | ① 并行 `Promise.all`；② 按点击顺序；③ 浏览器半循环 N 次 HTTP | ①并行会把"哪几条失败"变成一坨竞态，而这条恰恰必须逐条说清——失败原文要落回它自己那一行；且并行等于同时开 N 个整目录删除，宿主磁盘侧没必要吃这一下。②按点击顺序的话，"我先后点了哪几条"会影响一批不可恢复动作的执行顺序读感，没有收益。③被否：每条一次 HTTP 都把全量清册读与宿主会话表重扫一遍——100 条实测约 15ms/条，正是"恢复很慢"的来源；现在整批一次清册快照、一次宿主表预取、一次通告（见现状稿第十二批） |
| **折叠 / 收起 / 拖栏三处状态都不跨会话记住** | ① `localStorage`；② 存进插件自己的 storage domain（新端点） | ①**没验过就不走**：宿主桌面壳文档 origin 是不透明的 `null`（AGENTS.md 实测 `dsh-app:` 不是 special scheme），`localStorage` 在真机上大概率直接抛 `SecurityError`，写成 try/catch 静默降级则"记住"这件事本身是薛定谔的。②为一条视图偏好开一条 Node 半读写通道，代价与收益不成立（还要重启宿主）。**关掉面板再回来是默认形状**，这句如实写进 §7 |
| **左栏下限定在 330，不是算出来的 280** | 沿用"两颗按钮放得下"那条算式（它给的是 240 都行） | 真 Chromium 上按 10px 一档扫 240→420：按钮 `flex:none`，再窄也是文字列缩，**它从来不是约束**；真正会坏的是「删除于 … · 224KB」那一行——280 差 50px、320 差 10px、330 归零。这条也是"量法先于结论"的又一次现场：先按算式落了码、后去量，才发现量错了对象 |
| **那一排从清单列里搬出来，常驻面板体顶端**（同日第三批，真机指认"位置不对"之后定） | ① 收起那颗住头部（第二批的做法）；② 收起后把图标搬到详情标题行左侧；③ 收起后整排消失 | ①被否：同一件事的开关分在两处（头部一颗、清单里一排），而且收起之后头部那颗与清单再无空间关系。②被否：那颗钮会有两个位置，肌肉记忆学不会。③是单向门。搬出来一次解决三件：位置永远不变、不随长清单滚走、收起态只剩它自己。顺带把「刷新」也收进这一排（他要的）——**代价**：面板不再有"手动重读"的文字入口，重读只剩这一颗图标 + 关掉再开 + 失效通告自动重读 |
| **组头那颗勾选框是三态，且"选项目"含折叠起来的条目** | ① 两态（部分选中时看起来是空的）；② 只选当前展开的条目 | ①：勾了 3/109 之后组头毫无反映，人容易再点一次把三条取消掉。②：折叠只是"不进 DOM"的视图状态，让它偷偷改变一个批量动作的范围，等于让视图决定数据——"我选了整个项目"和"我其实只选了看得见的几条"必须是同一件事 |
| **组头按钮显式 `text-align:start`** | 照抄宿主 `DisclosureRow` 那份 CSS 就完事 | 抄本给的是 `div` 的形状，我们这行必须是可点的 `<button>`；UA 样式表的 `text-align:center` 会渗进里面的文字（真机截图上项目名整条居中）。**"逐字抄"不等于"结构相同"**——这一条差异记在 `ui.css` 头注里，属于已知偏离，不是漂移 |
| **「整条左栏收起」删掉**（同日第五批，用户一句"感觉没啥用"） | 留着（它已经做完了，只多一颗图标）；或改成"只折叠不收起" | 它换来的只有"详情铺满"这一格宽度，而代价是：动作住在行内 ⇒ 收起时「恢复 / 彻底删除…」一并看不见，想换一条或动手都得先展开——一个"看一眼就收"的开关，收完还得展开才能做事，收益就没了。**留下的东西**：那一排仍住面板体顶端（理由换成"不随长清单滚走"，不是"为了收起后还能回来"）。删的时候连带摘掉 `IconPanelLeftOutline` 那枚几何与两个文案键——只有它在用，不留死代码 |

## 11. 待定

- **跟版策略**：宿主要求只住一处——`package.json` 的**顶层 `engines.dsh`**（2026-10-19 第十六批起）。判据是 asar 里的官方原文：清单声明了 `engines.dsh` 时**只由该范围决定、`peerDependencies` 被忽略**；没有它才逐条比对 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer（预发布版本参与匹配）。§10 拆掉 `dsh-client-ui-primitives` 之后留下的"能装上"问题，现在由这个窗口正面回答：`>=0.1.7-rc.2 <0.3.0-0`（地板 = **完整功能**的最低代次：`0.1.7-rc.2` 由 CLI 台架验过四槽位齐全、激活零错误，**台架读数不进 `dshReleases`**；`0.1.7-rc.1` 缺行首槽位，`0.1.5` 起连会话行入口都没有。天花板 = 下一条线的起点，`-0` 把 0.3.0 的预发布也挡在外面）；peer 保持为零，两个家会写出两种结论。**"哪一代真的跑过"是另一笔账**：`dsh.compatibility.dshReleases` 只列真机复核过的代次——2026-10-19 记，桌面版 0.2.0-rc.2、0.2.1-rc.1、0.2.1-rc.2 均已在册；更高代次仍要真机复核才敢加名单（判据仍是 §8 门 3/4 那几条真机项），而窗口外的代次不是"没验过"，是**装不上**。**在册说的是"哪份产物"在那一代上跑过**：rc.1/rc.2 验的是 `link:` 回本仓的工作树；工作树已前移到 **0.2.1**（tag `V0.2.1`），而 npm 上仍只有 0.2.0——那份是 2026-10-17 从 tag `V0.2.0` 发的，`dshReleases` 里只有 `0.2.0-rc.2`，也不含第十四批的修复（`npm view @xrn1997/dsh-session-delete@0.2.0 dsh.compatibility` 实测）。所以三代在册与 `engines.dsh` **要等 0.2.1 发布后**才落到可安装产物上（`npm publish` 由用户手动执行）；发出去之前，README 那句"Tested with …"读作"这一份 dev 树在那几代上跑过"。名单与实测代次现在由 `tests/skeleton.test.ts` **双向**钉住（多塞一代没跑过也变红）。
- **原位恢复**要不要（需记账本序号 + `insertSessionBefore`）。
- 实现顺序由 writing-plans 产出。

**同日第六批：复核批（评审 13 + 8 条，逐条对代码验过再改）**

- **分隔那一格不是 1px**（承重的一条）。注释与 §7/§8 都按"1px 的 `border-l2`"推导过 900 这个断点，而拖分栏那批把中间换成了 `.sd-width-handle`——命中区 **10px**（视觉线 2px、静止 `opacity:0`）。按真 Chromium 重跑量尺（jsdom 渲出的真 DOM + `ui.css` + `markdown.css`，只测列宽与溢出，这几项由内联样式与 flex 决定、与宿主 token 无关）：地板 480 那一档读到 **清单 420 / 详情 390 / 正文 380 / 溢出 0**，比稿里那句"详情 399 / 正文 374"少 9px，而 374 本来就不是当时的结构能量出来的数。⇒ 地板改 **489**（= 详情 399 + 那一格 90），于是 900 那一档清单被夹到 **411**、详情正好 **399**、正文 389、溢出 0，两栏各自的下沿都守住；"那一档抢不动宽度"这条原意不变。
- **zstd 的 type 3 是 Reserved，不是"未压缩块"**：写缺失用例时拿合成夹具撞出来的——`zlib.zstdDecompressSync` 对 type 3 的帧一律 `Data corruption detected`，而我们的解析器原先照 Raw 那样吞 `size` 字节。真产物 36 904 帧里只有 Compressed 与 Raw，所以改成**遇到就抛**，不静默接受对面解不开的形态。同一趟更正了护栏那条机制：块头越界时 `readUint24LE` 用 `|` 读 ⇒ 恒回 **0**（不是 `NaN`），而 0 的 `Last_Block` 位没置位 ⇒ 没护栏就是每圈 +3 字节永不 break（当年那次卡死是真的，机制写错了）。
- **四处行为按稿补齐**：清单为空或读数失败时**不分栏**（§2.3 第 1 条，原先只要盒子够宽就渲右栏）；窄档清单**真铺满**（`maxWidth:760 + margin:auto` 是改版前的残留，与 §7 和它自己的注释都对着）；详情「删除于」**绝对 + 相对**两样都给（§2.3.4①）；窄档一次没点过时**第一行拿 tab 落点**（原先全行 `-1`，键盘根本进不了清单——`listbox` 自己是 `tabIndex:-1`，所以这不是"能聚焦但不好用"，是进不去）。
- **冗余收口**：死键 `common.refresh`（刷新已降图标）zh+en 一起摘；恒等函数 `trashFolder` 删；`ROW_DANGER` / `ELLIPSIS` 两份收成 `src/client/ui/recipe.ts`（改名 `QUIET_DANGER`，那条"不铺底"的理由从此只住一处）；绝对时间串与相对短语收成 `copy.ts` 的 `absoluteText` / `agoText` / `unitWord`，清单行与详情共用一张单位表（原先两处各抄一份 `BUCKET_KEY`）。**没合的两处失败卡片**：文案、重试对象（清单 vs 正文）、播报归属都不同，两个站点抽一层是提前抽象。
- **门 4 不再钉声明条数**（"214 条 / 六个模块"已被本批之外的三次抄写超越：`Checkbox`、`DisclosureRow`、`ConversationRoot.widthHandle`）。口径改成"按 `ui.css` 文件头那份来源表逐属性零差异"，允许的差异从两类改成三类（前缀、`@keyframes`、文件头点名的自造 + 一处已声明的差别；自造的条数只以本段上面那条 §8 口径为准，不在这里钉）。
- **`docs/superpowers/plans/2026-10-15-trash-detail.md` 删**（1510 行 TDD 计划稿，38a060f 入库）：不在本仓的真相列表里、内容被后续批次逐条证伪（"<760 下钻"、"ui.css 本轮一行都不改"、`SPLIT_MIN_WIDTH = 760`、左栏 316），还钉着个人机器的 pnpm 绝对路径。历史留在 git 里，随时回得来。
- **读数**：用例 276 → **286**（+7 面板：899/900 两档、空/失败不分栏两条、窄档铺满、tab 落点两条；+1 详情：删除于两样；+2 zstd：Raw+RLE 同帧且对面解得出同一句明文、type 3 抛）。`typecheck` 0、`build` 0，浏览器半 **786.40 kB / gzip 176.47 kB**（比第五批 +5.76 kB / +2.24 kB，来自新增的两个 helper、四枚文案键与详情那一格），`require()` 仍只有 React 家族三个键。
- **仍未覆盖**：浏览器半这几批在**有可见浏览器的隔离 home** 上的交互层复核（AGENTS.md 那条硬约束），以及 900 档那三处宽度在**真宿主**里的读数——本轮是量尺页，不是真机。

### 2026-10-16 复核批（两轴评审收口，**没有新功能**）

这批改的是"文档与注释里那些会漂的数"和四处实现缺陷/冗余。逐条：

- **`session-log` 改成跨帧带余量**（`src/log/session-log.ts`）。旧写法是**逐帧** `split('\n')`，一旦某帧切在行中间，那一条就变成"两半都解不开 JSON" ⇒ **静默少一条正文**（还顺手把一个多字节字符解坏）。头注②原先写"最后一帧可能是半行"，本机实测把这条前提证伪：扫 `~/.dsh/sessions` + `~/.dsh/session-trash` 共 **686 个 `.jsonl.zstd` / 92 445 帧**，**每一帧都以 `0x0a` 收尾**（连最后一帧）。所以这次改动救的不是真在丢的数据，而是**摘掉那条依赖**：以后写作侧改了 flush 形状也不会悄悄少一条。对账读数：新旧两种口径**逐条相等**（records 188 105 == 188 105、`unparsedLines` 0、`truncatedTailBytes` 0）。同时把 `truncatedTailBytes` 从"每帧累加"（实现）改回它自己文档说的那个口径——整条日志最后一个换行之后的字节数。
- **拖栏的 `resizing` 不再能挂死**（`use-column-resize.ts`）。把手在拖动途中被卸载是有的（面板窄过断点、或清单被读空 ⇒ `split` 翻了），卸载后的节点收不到任何事件 ⇒ `.sd-resizing` 常驻面板根、下次变宽时 `data-dragging` 还留着。补一条拖住期间的 window `pointerup`/`pointercancel`（复用同一个 `stop`），move 仍然只认把手、捕获那套没动。同一趟把这份头注里钉死的"399 + 33 + 48 = **480** ⇒ 900 那档上限正好回 **420**、拖不动是对的"删掉——调用方 `DETAIL_RESERVE` 早已是 **489**（本段上面那条几何），真实读数是**夹到 411、比默认窄 9px 而仍能往里拖**；`reserve` 的算式从此只住调用方与本段，不再在 hook 里存第二份。
- **详情的缺省时间不再当值用**（`trash-detail.tsx`）。`src/trash/detail.ts` 把 `createdAt` / `lastActivity` 初值写成 0，旧写法直接 `toLocaleString()` ⇒ 屏上「1970/1/1」，而 `spanText` 的 `Math.max(1, …)` 会把"不知道"报成「1 小时」。现在 0 一律降级成「—」，跨度两端任一缺省就**不答**。同一趟删掉本地那份 `absolute()`、改 import `copy.ts` 的 `absoluteText`——`absoluteText` 文件头写的正是"各自 `new Date(...).toLocaleString()` 一遍迟早会漂成两种样子"，本仓这份抄本违反的就是它自己那条。
- **`reasoningCount` 整条摘掉**（Node 半不再算、`hasReasoning` 一起走、两侧类型各少一行、`10-15` §3 那份接口同步）。判据：页面上没有一处读它，而 §7 明写"不显示推理段"——挂在线上只多两本要维护的账。要上屏时照 `toolCallCount` 那一格加回来。
- **清单行的键盘焦点描边落地**：`ui.css` 末尾 `[data-dsh-session-delete="trash-row"]:focus-visible { outline: 0.5px solid var(--dsw-alias-button-ghost-active-border); outline-offset: 1px }`。这是抄本表**第二处自造**（第一处 `.sd-resizing`），文件头、AGENTS.md 与本段 §8 门 4 那条一并从"一处"改成"两处"；`tests/skeleton.test.ts` 钉住"点名的两条真在表里 + 描边用的是选中态那枚 token"。此前 `10-15` §1.3 承诺了这条而表里没有——行是可聚焦的（roving `tabIndex`），而这一代 `--dsw-focus-ring-color` 逐字 `transparent`。
- **`MarkdownBody` 加 `memo`**。读实上游：`node_modules/react-markdown/lib/index.js:175-178` 里 `Markdown()` 每次调用都 `createProcessor(options)` + `runSync(parse(file))`，**整份文件一个 `useMemo`/`useRef` 都没有**（`MarkdownHooks` 那一支也一样）⇒ 面板任何一拍重渲（悬停、↑↓、「刚刚删除」那句读 `Date.now()`）都会把每条助手回复重解析一遍，闸值是 500 000 字符。**更正一处**：评审里先给的"把 `remarkPlugins={[remarkGfm]}` 提到模块作用域"是无效的——数组身份不是这里的变量，按住重渲才是。
- **`restore` 吃 `busy`**（`trash-panel.tsx`）：清单行那颗「恢复」本来就按 `disabled={busy}` 置灰，而 `busy` 只有彻底删除那条会设 ⇒ 那把锁是空的，连点会打两次远程。
- **文档/注释同步**：`markdown.css` 文件头去掉"214 条声明 / 只允许两类差异"（本批刚在 §8 门 4 停止钉条数）；`styles.ts` 那句"214 条"同改；§7 引导句"五个状态"→**六个**（那段本来就到⑥）；§10 表里"Node 半四个端点"补括注（第五个是 `POST /detail`）；`10-15` 里三处 kB 抄本收归本段（AGENTS.md 的规矩就是"读数只住 §8"）；本段那两处条数更正（`zstd-frames` 9→**11**、`trash-detail.test.tsx` 15→**16**，并写明 `138` 那"补 2 条"已含在 16 里）；README 详情字段从逐条清单改成**类别语气**（逐格名单以 `trash-detail.tsx` 为准，列出来就是一条会漂的清单）；`tests/client/index.test.tsx` 那条标题"后续四个端点"改成"动作各走自己那条 POST 段名"（它实际只钉了 delete + restore 两条）。
- **读数**：用例 286 → **291**（+1 session-log 跨帧拼回同一条且不计 unparsed；+1 拖栏把手中途卸载由 window 兜结束；+1 详情 0 值三格降级、不报 1970 也不报「1 小时」；+2 skeleton 抄本表那两处自造的声明与实现对上）。`typecheck` 0、`pnpm test` 0、`build` 0；浏览器半 **791.27 kB / gzip 178.49 kB**（比上一批 +4.87 / +2.02，来自跨帧余量、焦点那条规则与几处注释改写），Node 半 **56.49 kB / gzip 21.95 kB**（+0.78 / +0.42）。产物纯度照旧：`grep -oE 'require\("[^"]+"\)' lib/client.js | sort -u` 逐字三条 `react` / `react-dom` / `react/jsx-runtime`，`node:` 与裸内建 **0** 条。
- **本批真机门（2026-10-16 实跑，宿主仍是 desktop `0.2.0-rc.2`）**：四处只在真宿主上才露面的判据逐条过了——① 拖栏松手后文字照常选得中（`.sd-resizing` 不粘，这条正是本批修的那处）；② 键盘 ↑↓ 走清单时那圈新描边在宿主裁剪容器里出得来；③ 助手侧 Markdown 的正文字号跟宿主会话区那根轴一起走；④ 多选批量删部分失败时原文落回它自己那一行。**仍未跑的两条**：`0.2.1-alpha.*` 那几代——所以 `dsh.compatibility.dshReleases` 本批发版时**照旧只列 rc.2**，不多写一行；以及门 4"与官方逐属性零差异"里 `position: relative` 那一处疑点——本机没有可比对的 `app.asar`，留给下次有宿主安装包时按 `ui.css` 文件头那张来源表走一遍。

### 2026-10-16 空态居中修复批（没有新功能）

用户一句「当没有会话的时候，好像图标显示的有问题，现在位于左上角，而不是居中状态」——**两栏改造碰坏的旧面**，不是新功能。根因、三档读数（改造前链 (-5,-5) / HEAD (-198,-209) / 修后 (-5,-1)）与台架对读都在 `10-15` §8；修法是两行 flex（`list` 加 `flex:'1 1 auto'`、单列那处 `listPane` 给同款），断链的成因是两栏改造新插的 `list`（无 flex ⇒ 高度=内容高）与 `listPane` 在 BODY 这一**行**里按内容宽缩在左边。

- **单测**：291 → **292**（+1：空态的居中链；jsdom 没有布局，钉的是那条链本身）。`typecheck` 0、`test` 0、`build` 0（三道门退出码逐个 capture）。
- **读数**：浏览器半 **791.88 kB / gzip 178.76 kB**（+0.61 / +0.27，两条注释与一处 flex 声明），Node 半 **56.49 kB / gzip 21.95 kB**（未动）。产物纯度照旧：`require()` 逐字三条 React 家族，`node:` 与裸内建 0 条。
- **活宿主复核（本批已跑）**：临时 `DSH_HOME` + web 模板 + `plugin add link:`（宿主 rc.2，真 Chrome、有可见视口）上，空态图标相对面板中心 修前 **(-187, -248)** → 修后 **(-5, 0)**；种 3 条假清册记录后 `listPane` 761 = BODY（空态修前 398、非空修前 735）、行贴顶；面板自己的「清空回收站… → 彻底删除」真通路把空态带回、底部按钮按时消失；干净加载控制台零条 error/warn。
- **真机门交用户**：bug 是他真机看的，修好后的目视也归他；替身与台架读数只是我这一侧的证据。

### 2026-10-16 清单对账批：回收站目录是唯一需要手动动的地方

用户两个实验（把 `storages/xrn1997_session_delete_trash/` 改名搬走 → 刷新无反应、重启才消失；改回 → 刷新依旧不出、重启才回来）＋一句「那这个刷新有什么意义呢」定下的事：**只手摸 `session-trash/` 就好**（"如果动文件需要动两处，那很麻烦了，尤其是后者还是数据库"）。机制换代、五条口径、`projectDir` 反推链与台架读数都住 `10-15` §9——一句话：**每次读清单 = 对账 + 读**（`GET /list` 的正文变成 `reconcileTrash`），原选项"刷新时 close+open 域"作废（它服务的是手工编辑数据库，正是要避免的方向）。

- **单测**：292 → **309**（+9 对账：重建/回落 `_no-cwd`/摘行/零漂移零写/幂等/根缺席/坏名不碰/坏日志跳过/尺寸量不出不造行；+4 会话日志：回调 `false` 早停、`readSessionHeader` 三态；+4 api 层：带漂移的 `list` 两条、零漂移不读日志、到达序串行）。`typecheck` 0、`test` 0、`build` 0（三道门退出码逐个 capture）。
- **读数**：Node 半 **62.03 kB / gzip 24.06 kB**（+5.54 / +2.11，来自对账模块、早停与 header 读法、串行链）；浏览器半 **791.94 kB / gzip 178.79 kB**（+0.06 / +0.03，只改了 `wire.ts` 一句注释）。`require()` 仍只有 React 家族三个键。
- **活宿主复核（本批已跑，有可见浏览器）**：台架预置两类漂移 + 杂散文件——首读即对账（幽灵目录长行、孤儿行被摘、杂散文件不列）；运行中搬走目录点刷新行当场消失、搬回来点刷新当场回来；重建的行走「彻底删除」真通路清干净；控制台零 error/warn。逐条读数住 `10-15` §9。
- **真机门交用户**：判据 = 台架那三条（放目录→刷新长行、搬走→刷新摘行、搬回→刷新再长）在他的桌面版上照做一遍。

### 2026-10-16 刷新按钮删除批（没有新功能）

用户一句「要不把刷新按钮删了吧，没用」——同日对账批之后，那颗按钮不再承担别人替代不了的活（开面板/切走再切回/重启，任何一次读清单都会先对账），裁定删除。摘掉的面：`trash-panel.tsx` 的按钮与三处注释、`copy.ts` 的 `trash.toolbar.refresh`（zh+en 同摘）、`icons.tsx` 的 `IconRefreshOutlineRegular` 几何（只剩它在用，不留死代码）、那条「刷新降级成图标」的用例（换成"那一排只有两颗钮、刷新钮不存在"的反向钉，用例数不变）、README 那一句；`10-15` §9.1 是这批的补记，现状稿 §7 的规格句同步。

- **单测**：309 → **309**（删 1 加 1 净 0）。`typecheck` 0、`test` 0、`build` 0（三道门退出码逐个 capture）。
- **读数**：浏览器半 **790.74 kB / gzip 178.57 kB**（**-1.20 / -0.22**，就是那颗按钮、那枚几何与两条文案）；Node 半 62.03 kB / gzip 24.06 kB（未动）。`require()` 仍只有 React 家族三个键。
- **台架冒烟（本批已跑，有可见浏览器）**：隔离 home 打开面板——空态正常、那一排恰好两颗钮（「全部折叠」「多选」）、刷新钮 `aria-label` 全页零命中、控制台零 error/warn。
- **真机门交用户**：重启桌面 app 后面板那一排应当只剩两颗钮；"手动动目录→同步"仍照旧（切走再切回或重开面板，每次读都会先对账）。

### 2026-10-16 第八/九批复账：两个只读数 + 级联（**只补产物读数，没有新判断**）

那两批的判据、用例账与真机门都住在 `10-15` §10 / §11，唯独**没记产物读数**（issue #5 第二条点出来的漏记）。两批是**同一次提交**（`45536e2`：日志读最新一代 + 清单两个只读数 + 三个动词按组级联），所以共用那一趟构建。

- **读数（本机在 `45536e2` 上重建实测）**：Node 半 **73.79 kB / gzip 28.30 kB**（第七批 62.03 / 24.06 ⇒ **+11.76 / +4.24**，级联那三个动词按组走全部落在这里），浏览器半 **791.89 kB / gzip 178.77 kB**（第七批 790.74 / 178.57 ⇒ +1.15 / +0.20）。`require()` 仍只有 React 家族三个键。
- **口径**：issue #5 抄的那组（73.47 / 28.15、791.32 / 178.75）与重建值差 ≤0.6 kB——同一提交、不同 checkout 的行尾差异，**以重建值为准**；kB 从此只住本段，`10-15` §10/§11 各留一句指针。

### 2026-10-16 五张票收口批（第十批）：组按闭包、折行一条判据、释放口径、删除前那一次计数

评审开出的五张票（issues #1–#5）一次收掉：四条动代码、一条只动文档。判据、被否决的替代与真机门都住 `10-15` §12，本段只记门与读数。

- **单测**：342 → **358**（+16：`api` 六 / `assembly` 四 / `trash-panel` 一 / `delete-menu-item` 三 / `client/remote` 二；另**改写**既有三条——`assembly` 两条夹具补齐宿主本来会交回的 `header.id` 与 `header.parentSession`，`index.test.tsx` 那条"动作各走自己那条 POST 段名"现在钉三条并钉住**计数排在删除之前**）。每条新行为都是先看红再落绿：闭包那四条、折行不重复计数那条、确认卡片报整组字节那条、"点前就说"那条与 `client/remote` 那两条都逐个跑到过失败。**两条例外，如实记**：`api` 那两条"新段名的自检与栅栏"**当场就绿**——栅栏与 `requireString`/`requireMethod` 是挂在路由层整套上的结构性待遇，新段名落在同一张表里，这两条是**回归钉**（钉住"以后别给第六个段名开豁免"），不是红检。
- **三道门退出码**（逐个 capture，不接管道）：`vitest run` **0**（358 通过 / 23 个文件）、`tsc --noEmit` **0**、`tsdown` **0**。
- **读数**：Node 半 **77.23 kB / gzip 29.62 kB**（上一批 73.79 / 28.30 ⇒ +3.44 / +1.32，闭包那两张表与新端点都在 Node 半），浏览器半 **793.34 kB / gzip 179.48 kB**（+1.45 / +0.71：确认框那一次取数、`releaseBytesOf` 与一条文案键）。产物纯度照旧：`grep -oE 'require\("[^"]+"\)' lib/client.js | sort -u` 逐字三条 `react` / `react-dom` / `react/jsx-runtime`，`node:` 与裸内建 0 条。`ui.css` / `markdown.css` 这批一个字没动 ⇒ §8 门 4 那条逐属性比对不必重跑。
- **wire 多了一个段名**：`ROUTES.subagentCount = '/subagent-count'`（`src/shared/wire.ts`，两侧共用那一份）⇒ 六个端点。错误码一个没加（`map-error` 那张表照旧五个）。
- **真机门交用户**：判据五条住 `10-15` §12 末尾。**这批动了浏览器半**（确认框多一次取数 + 那一格换了口径），按 AGENTS.md 的硬约束要先在**有可见浏览器的隔离 home** 上过一遍再装 live profile；Node 半（新端点 + 闭包）必须重启宿主。本环境的会话内浏览器没有可视表面，这一趟我没跑。
- **真机进展（2026-10-17）**：§12 门 ③（删除确认框点前就说「含 N 个子会话」）已由用户在桌面版 `0.2.0-rc.2` 上验过（`6dd12b5b` 那支，N 与盘上后代数一致）；其余四条未跑。

### 2026-10-17 批量恢复批（第十一批）：多选的另一半

判据与形状住 `10-15` §13，本段只记门与读数。

- **单测**：358 → **361**（+3，全在 `trash-panel`：没勾时置灰且不弹框、确认框列出条目并按清单顺序逐条 restore 且成功后不留行、部分失败原文落回自己行；`depsOf` 替身补 `restore` 覆写）。三条 **先看红再落绿**（红在"页脚没有「恢复 N 条」这颗"）。**踩坑记一笔**：确认框那颗「恢复」与页脚那颗「恢复 2 条」不同名（同「彻底删除」那对的形状），第一版用例按同名去找、点了两次页脚那颗，表现是"只恢复了一条就卡住"。
- **三道门退出码**：`vitest run` **0**（361 通过 / 23 个文件）、`tsc --noEmit` **0**、`tsdown` **0**。
- **读数**：Node 半 **77.23 kB / gzip 29.62 kB**（未动），浏览器半 **798.12 kB / gzip 180.52 kB**（+4.78 / +1.04：页脚第二颗按钮、恢复确认框、四条文案键与页脚那句合版）。产物纯度照旧：`require()` 逐字三条 `react` / `react-dom` / `react/jsx-runtime`。`ui.css` / `markdown.css` 一个字没动 ⇒ §8 门 4 逐属性比对不必重跑。
- **真机门交用户**：判据三条住 `10-15` §13 末尾，**未跑**（这批动了浏览器半，`lib/` 已重建好，live profile 走 HMR + 重启即可试）。

### 2026-10-17 官方对齐批（第十二批）：全项目按官方推荐重扫一遍，四批一起收

来由是用户那一句「我批量恢复了一百多个会话，感觉很慢，为什么恢复的这么慢呢？」——量完账之后他把范围放大：「整个项目所有部分，只要有写法和官方的推荐不一致，我们都可以考虑重构，按最佳实践方式来。」做法：两份子代理审计 + 官方文档站通读 + **逐条拿 rc.2 源码与 asar 原文复核**。四批一起落在这节里，因为它们改的是同一批文件（`shared/wire.ts` / `api/dispatch.ts` / `client/remote.ts` / `client/trash-panel.tsx`），拆成四个提交只会让中间三个跑不过门禁。

**先记三个被证伪的审计结论**（不改进计划，记在这儿免得下次再被提）：

- **换宿主 `ctx.connection.admit` / `requestRejection` 当栅栏：否**。rc.2 里 `isTrustedApiRequest` **缺 `host` 头直接 false**、接着还要浏览器 cookie，而桌面壳转发前把 `host` 与 `cookie` 都删了 ⇒ 换过去真机全 403。**自建同源栅栏是必需，不是债**（并进 §10 那行）。上一轮我说过「官方 remote 走不通、栅栏待换」，这条按原文更正。
- **把客户端状态搬进官方 `ctx.sessions` 模型：否**。那个模型管的是**会话目录 / 工作区**，靠 `api-session/added|removed` 增量维护；回收站清单和面板态不在它的词表里，没有"可搬的官方模型"这回事。这条只剩一个真问题：重读的**竞态**，它归第一批。
- **`role="option"` 里嵌按钮的可及性：真实存在，但是存量**（2026-10-15 那批就是这个形状），不是本批引入 ⇒ 列独立小项，不混进重构。

#### ① `POST /apply`：一段管所有动作（性能 + 三条正确性）

慢的真相先按量出来的记（本机，100 条那一次）：**成本不在搬文件，在每条一次的全表读**。旧形状 = 浏览器半循环 N 次 HTTP，每次内部五件：清册全表重读 + 排序、回收站目录检查 + `rename`（冷盘 ~5ms）、清册删一行 = **临时文件 + fsync + rename（~2.2ms）**、`attach` + `unarchive` 各一次串行链占位、**`announceRestored` 拉全表会话清单只为找一条（~6.3ms）**。合计 **约 15ms/条**（不含网络往返），100 条 ≈ 1.5–4 秒——其中**两次全表扫描被做了 100 遍**，这是设计层面的浪费，不是磁盘慢。

- **接口**：`POST /apply` 带 `{action:"delete"|"restore"|"purge"|"count", ids:[…]}`，回 `ApplyOutcome[]`（每条带原始输入 id + `action` + `ok` + `value|error`）。`/delete`、`/restore`、`/purge`、`/subagent-count` 四段名**退役** ⇒ 段名从六个收成五个（`list` / `ping` / `detail` / `apply` / `empty`）。`/empty` 单独留着的理由只有一条：它是**聚合回执**（`{removed,freedBytes}`），不按条回。
- **单条 = 长度为 1 的批量**：仓里不再留第二条执行路径（这是这条重构的主要收益，不是性能）。
- **三条批量语义是接口的一部分**（`src/verbs/apply.ts` 文件头）：① 输入去重、保持输入顺序（界面上"清单从上往下"那份读感）；② 一条失败**不传染**下一条，逐条 `try/catch` 后按 `map-error` 那张表折成信封；③「已被同批前一条带走」记**幂等成功**而不是失败——恢复一条已跟着父亲回来的孩子，用户要的结果本来就达成了（`delete`/`restore` 回 `null`；`purge` 本来回的就是聚合数，回 `{removed:0,freedBytes:0}`）。**判据用快照的原始形状，不用当前形状**：原始快照里认得出它（它自己、它的父、或它的孩子任一在）而当前快照里空了 ⇒ 才是同批带走的；后来者本来就不在清册（幽灵 id、对账刚摘掉它）照样响亮报 `trash-empty`，不许被"已被带走"这句话粉饰成成功。
- **整批只读一次清册、只预取一次宿主会话表、只发一次通告**：`applyRestore` 拿一份快照传进动词（`restoreSession(deps)(id,{snapshot,suppressAnnounce:true})`），批尾 `announceRestoredBatch(ids, summaries)` 一次发。通告名单收的是**整组**（父 + 跟着回来的孩子），不是只有被点那一行——漏了孩子的话，客户端那一行永远还挂着"在回收站"的读感。
- **重读竞态**（第一批里那条正确性，与性能无关）：`reload()` 带序号（`reloadSeq`），**只有最新一次的响应许落地**。在飞的读不保证按发起顺序回来（对账耗时随盘上条目数摆动），旧形状是后到的旧响应直接把新清单盖回去。

#### ③ 错误面：`details` 第三件、官方码原样过桥、HTTP 状态各归各位

- **信封补第三件**：`RemoteFailure` = `{code, message, details?}`，对齐官方 `rpcErrorSchema` 原文那三件（`dsh-client-connection`：`z.object({ code, message, details: z.record(z.string(), z.unknown()) })`）。`details` 的来历就近优先：抛出物自己挂的 `details` → 它身上的字段（rc.2 的 `WorkspaceActiveSessionError` 带 `sessionId` / `activity`，`WorkspaceUnknownSessionError` 带 `sessionId`）→ 无。**没有附带物时整件缺席，不写空表**——"带过但为空"和"没有可带的"是两件事。
- **别域的官方码不再被抹成我们的**：带官方 `<域>/<名>` 形状的抛出物（`workspace/session-active`…）与已带结构标记位的远程失败**原样过桥**，`code` 与它的 `details` 一起带出；把它们折成 `sessiondelete/io` 就是把宿主的判断抹成我们的，客户端拿到的 code 从此不能说真话。§6 那张表现在是"五个码 + 两类原样过桥"。
- **HTTP 状态语义**：请求本身不对 ⇒ 用它自己的 4xx（`400` 请求体 / `405` 方法 / `404` 未知路由，栅栏拒 `403`）；**操作失败**仍回 200 + 信封（"盘上没有""原目录已不在""会话在跑"是办完才知道的结果，不是请求不对）。浏览器半先解信封再看状态，所以 4xx 上的原文照样读得出。`ROUTE_CODES` 那三个名字是**抛出处给读代码的人看的站点标签**，一律折成 `io`，不许冒充 §6 那五个码。
- 宿主类型化错误**沿 `cause` 链**按 `this.name` 认（不看进 cause 的话，动词那层笼统的 `io` 会把 §6 那两行映射永远挡在客户端之外），查表必须 `Object.hasOwn`——`'constructor' in {…}` 是 true。

#### ④ 生命周期与探针：清册的句柄归谁、探测凭什么算"通道在"

- **清册 storage 域**（`xrn1997_session_delete_trash`）**懒开、成功句柄只开一次**（`apply` 是同步的而 `open()` 是异步的），**打开失败不缓存 rejected promise**：域被别的持有者占着是瞬态（重启、卸载竞态），缓存住第一次的拒绝等于"这个会话永远删不掉"，而它下一次 `open()` 就能成。
- **卸载的 disposer 把 `close()` 的 promise 交回框架**，不再 `void` 走掉——句柄归调用方所有是 `open()` 的 JSDoc 明写的契约，没关严的句柄会让下一份同名域撞 `already-open`。**开失败过就没有东西要关**：那条拒绝在 disposer 里就地咽掉，不让它从卸载路径上冒出去（框架正等那个 promise，抛出来只会变成卸载期的一条 unhandled）。
- **探测改成 `GET /ping`**：原先拿 `GET /list` 当健康检查，而 `list` = 对账 + 装配 + 两次宿主读数 ⇒ **每次页面加载都跑一遍全盘对账**，为的只是问一句"你在不在"。`/ping` 不碰清册、不碰盘、不进串行链（用例就钉着这两条零读数）。判据仍是「**拿到信封**就是通道在」（失败信封也算），`{ok:false}` 时该做的是把原文交给用户看、不是把入口藏掉。

#### ② 包形：`lib/types/`、不发布 JS map、peer 与 dev 同范围

官方不变式逐字取自 `reference/cookbook/adding-a-package`（`main: "lib/index.js"`、`types: "lib/types/index.d.ts"`、`exports["."].types` / `.default`、"`@deepseek-ai/cordis` 同时出现在 peer 与 dev 且**相同范围**"、"`files` 精确到 `lib/index.js` 与 `lib/types/**/*.d.ts`，**不要发布 `src`、声明映射、JS map 或陈旧的根声明文件**"）。`./client` 那两件的形状不是推的——宿主 `dsh-client-connection` 的 `package.json` 原文就写着 `{"types":"./lib/types/client/index.d.ts","default":"./lib/client.js"}`（asar 实读，见 §9 那条证据链）。

- **声明改由 `tsc -p tsconfig.build.json` 出到 `lib/types/`**（`emitDeclarationOnly`），tsdown 那份 `dts: true` 关掉——它落在 `lib/index.d.ts`，正是官方点名不要的"陈旧的根声明文件"。`build` 两步 `tsdown && tsc …`，**顺序不能反**：Node 半那条配置带 `clean: true`，会先把整个 `lib/` 抹干净。`prepack` 仍兜整条。
- **`files` 从整目录 `lib` 收成精确产物**：`lib/client.js.map`（1.26 MB）从此不发布（构建仍在本地生成，调试用）。实测 `npm pack --dry-run`：**51 个文件 / 266.5 kB**。
- **peer 与 dev 同范围**：`@deepseek-ai/cordis` 由 peer `^4.0.2` / dev `4.0.4` 收成两边都 `^4.0.4`——这类漂移的实质是**声明的那块地板从没被编译过**（装机闸只认 `dsh` / `dsh-*`，cordis 这条不影响装机，见 AGENTS.md 那条硬约束）；`react` 的 dev 由 `18.3.1` 改成 `^18.3.1` 与 peer 对齐。用例从"钉这两条"改成**通用判据**：每条 peer 若在 dev 里镜像，范围必须逐字相同——以后再漂移不用改用例。**改范围就得改锁文件**：`pnpm-lock.yaml` 的 `importers..specifier` 记的是**声明的区间**而不是解析结果，两处不同步时 CI 的 `pnpm install --frozen-lockfile` 直接失败（`pnpm install --lockfile-only` 刷两行，解析出的版本一个字没动：`4.0.4` / `18.3.1`；`--frozen-lockfile --offline` 复核过）。
- **`dsh.client.inject` 里那行 `@deepseek-ai/dsh-client-locale` 留着，它不是冗余**：这条曾被当成自相矛盾（我们没走官方 locale，却声明了它）。它的语义是**包行的到达序**（宿主浏览器半 `arriveGraphRow` 逐字 `for (const packageName of row.inject) { … await this.arriveDependency(dependency) }`，名字取不到就静默跳过），**不是**把服务硬 `inject` 进客户端条目——后者才是"条目 pending = 宿主进程死"那一条死法（§7 末）。要的是 locale 包那一行先到，好让 `ctx.get('locale')` 这一次**可选读**大概率读得到；读不到仍降级内置 zh。**文案继续自建**（`src/client/copy.ts` 那套字典 + thunk）：官方 `ctx.locale.register(ns,{zh,en})` 那条路要求桌面组成里必须有 locale 服务，缺一整个入口不激活，风险与收益不成比例——按用户裁定保留自建。

#### 保持的三处偏差（不是忘了，是判过不做）

① `projectKey` 反推组头项目名：第三方没有官方读取面，`unescapeProjectKey` 那套有损还原继续带着 `title` 不作声称。② `/apply` 内部**串行**逐条，不做并行：并行意味着同时占多条串行链，而这条链存在的理由就是"同一时刻只有一批文件动作"（§10）。③ `role="option"` 内嵌按钮：上面那条存量项，独立小票处理。

#### 用例与读数账（四批合起来一趟）

- **单测**：361 → **390**。分布：`api`（`/apply` 的批量语义、幂等、失败不传染、4xx 各档、`/ping` 那两条零读数 + **链被占住时立即回**、整组通告、**delete 同批父先走的孩子幂等**）、`verbs/apply` + `restore-session`（快照复用、`suppressAnnounce`、批尾一次发）、`client/trash-panel`（重读只应用最新一次；两段循环合成一次调用；**跨项目批量按屏幕分组序**）、`client/remote`（五段面、探测走 `ping`；**details 到组件面不丢**）、`remote`（`details` 过桥、官方码不改写、再映射幂等、**details 就近优先**）、`assembly`（storage 域生命周期、十六个端口方法全接线）、`skeleton`（包形不变式）。**红检如实记**：`assembly` 那组"open 失败不缓存"与"disposer 等 `close()` 落地"先看红——红在第二次读没有再走 `open()`、disposer 走空；**夹具自己也是被测对象**：`dispose()` 里多写一个 `await` 会让"返回那条还没落地的 promise"永远量不到，改成原样交回才看到真红。**一条当场就绿**：`api` 新增的"跟着父亲回来的孩子也进那一次批量通告"——实现本来收的就是整组，这条是**回归钉**（钉住以后别只报被点那一行），不是红检。**收口复核补的五条**（ping 免排队、跨项目批量顺序、details 到组件面、details 就近优先、delete 批量幂等）**按缺陷报告与实现路径逐条落成，但这轮没有逐条留"先红再绿"的执行记录**——如实记在这里，别把这句读成已执行；它们钉的是五处已确认会走错的路径（ping 排在链后、扁平序偷换分组序、details 在 `failureOf` 被剥掉、外层 details 被 cause 覆盖、delete 孩子落进单条动词的 not-found）。
- **三道门退出码**（逐个 capture，不接管道）：`npm test` **0**、`tsc --noEmit` **0**、`npm run build` **0**（tsdown + tsc 两步）。产物纯度照旧：`grep -oE 'require\("[^"]+"\)' lib/client.js | sort -u` 逐字三条 `react` / `react-dom` / `react/jsx-runtime`，`node:` 与裸内建 0 条。`ui.css` / `markdown.css` 一个字没动 ⇒ §8 门 4 那条逐属性比对不必重跑。
- **读数**：Node 半 **90.90 kB / gzip 34.51 kB**（上一批 77.23 / 29.62 ⇒ **+13.67 / +4.89**，`verbs/apply.ts`、`/ping`、`details` 与清册域生命周期都落在这里）；浏览器半 **801.03 kB / gzip 181.93 kB**（上一批 798.12 / 180.52 ⇒ +2.91 / +1.41：`apply` 一段替代四段、面板那两段循环合成一次调用、探测换 `ping`，以及收口复核的 details/批量顺序两处）。发布包 **51 文件 / 266.5 kB**（不再含那张 1.26 MB 的 map）。产物纯度照旧：`grep -oE 'require\("[^"]+"\)' lib/client.js | sort -u` 逐字三条 `react` / `react-dom` / `react/jsx-runtime`，`node:` 与裸内建 0 条。`ui.css` / `markdown.css` 一个字没动 ⇒ §8 门 4 那条逐属性比对不必重跑。

#### 真机门（交用户，桌面 `0.2.0-rc.2`；①–⑥ 全过这批才算落）——**全部未跑**

1. 多选勾 5–10 条（含至少一条来自别的项目）→「恢复 N 条」→ 确认 → Network 里**只有一条** `POST /apply`；成功的回到各自原项目、清单里消失。
2. 100 条那一次的手感：应当从"秒级到半分钟级"落到**几秒内**。判据来自上面那本账（两次全表扫描从 N 遍降到 1 遍），但**只有真机能证这一条**。
3. 故意让一批里有一条失败（先手工移走它的回收站目录，或挑一条原目录已不存在的）→ 失败原文落在**它自己那一行**，其余照常成功，多选态不退。
4. 打开面板：探测那一次是 `GET /ping` 而不是 `GET /list`（Network 一眼可判）；把前缀路由摘掉应当看到四个入口一个都不出现。
5. 会话正在跑时删除 → 上屏原文之外，**信封第三件 `details` 里带 `sessionId` / `activity`**；另找一条宿主自己拒绝的动作，确认它的官方 code **没被改写成 `sessiondelete/*`**。
6. 反复重启宿主 3 次：清册读**不许**出现 `domain xrn1997_session_delete_trash is already open`（卸载时 `close()` 没关严才会出这条），宿主日志里也没有卸载期的 unhandled。

**这批动了浏览器半** ⇒ 按 AGENTS.md 的硬约束先在**有可见浏览器的隔离 home**（镜像目标 profile 的插件组成）上过一遍，再装 live profile；Node 半必须重启宿主。`lib/` 已按新脚本重建（`lib/index.js` + `lib/client.js` + `lib/types/**`）。

### 2026-10-17 宿主列表批量删除批（第十三批）：勾选 N 条一次移入回收站

来由是用户那一句「现在 dsh 宿主的列表左侧是加了一个删除按钮对吧？我现在需要批量删除的功能。」**前提先纠偏**（桌面 `app.asar` = 真跑 0.2.0-rc.2，会话行那半逐处读过）：行**左端只有一个 16px 状态点格**（座位 `sidebar.session.row.leading`），行尾悬停排（座位 `sidebar.workspaces.session.row.action`）是宿主的 ⋯/归档/置顶三颗，我们的「删除」住在 ⋯ 菜单里——**行上没有按钮**。形状走的是「先把图画出来他认」：选择 / 确认 / 撤销 / 部分失败**四态各画一张常驻可见**（第一版把弹层藏在点击后面，他的原话是「哪有确认框」——**UI 流程的各态必须常驻可见，藏在点击后等于白画**），四态他看过之后才落这节。

**范围**：只动浏览器半，**Node 半零改动**——批量面现成：`applyOutcomes('delete'|'count', ids)` 一段进、逐条 `ApplyOutcome` 出（第十二批 ①）。单删那三件（⋯ 菜单行 / 确认框 / 撤销横幅）一律不动，两套并存。

#### ① 选择交互：「⋯ → 多选」进入模式 + 整行点击 + 浮条（两版被打回后定形）

第一版把勾选开关放在行尾悬停排（`sidebar.workspaces.session.row.action`）——用户打回：「这个对号的位置
很隐蔽，而且存在一个问题，就是不方便查看哪些被选中了。」根因在宿主行渲染（app.asar 0.2.0-rc.2 原文）：
行尾 `.rowActions` 是 **`display:none`**，只有 `row:hover` / 菜单打开才出现；选中态又只落在 16px 按钮
自己的 `aria-pressed` 底色上，宿主行没有批量选中态。

第二版把勾选框挪到行首常驻（`sidebar.session.row.leading`）——用户再次打回：「不能常驻，工作区的
三个点里最好加个多选功能，点击才进入当前这个多选状态，并且多选状态可以屏蔽会话切换，以免只能点
复选框导致很难选中。」常驻框会让侧栏变成选择清单，且状态点 / 归档行仍勾不到。

**当前形状（2026-10-17 第二次改版）：显式多选模式。**

- **入口**：会话「⋯」菜单新增「多选」一行（`sidebar.workspaces.session.menu.item`，order 850，排在
  删除 900 之前并带发丝线；删除行不再重复画线）。按下进入模式并收菜单；模式内这一行变成「退出多选」，
  再按退出（文案复用回收站工具栏的 `trash.toolbar.select` / `selectExit`）。
- **模式内**：行首 16px 格（`sidebar.session.row.leading`）出回收站同款原生 `Checkbox`；宿主在
  「有状态点（运行中 / 待确认 / 未读完成）」与归档行**不渲染行首槽** ⇒ 这些行仍有行尾悬停兜底，
  但**不靠它**：模式内点整行就是勾 / 取消。
- **整行点击与屏蔽会话切换**：`document` 捕获阶段的 click / dblclick 守卫（`useSelectionRowClickGuard`）。
  模式内点会话行（标题、时间、状态点、空白都算）先 `preventDefault` + `stopPropagation` 吃掉宿主行的
  `onClick`（不再切会话），再 toggle 选中；行里的按钮 / 链接 / 输入 / 菜单项一律放行（⋯ 菜单、归档、
  置顶、单删照常）；双击的第二下与 dblclick 不翻转（不能把刚选上的反掉，也不打开宿主的重命名）；
  运行中的行点整行不选（与置灰勾选框同口径）。
- **标题 / 运行态来源**：行尾兜底那颗对每个非空行都渲染（哪怕 CSS 把整排藏起来），在 effect 里把
  `{title, live}` 登记进模块级表；守卫从 `data-row-key="session:…"` 反解 id 后查表。认行靠宿主行属性：
  将来它改名，最差是模式内点行不生效、只剩勾选框，不是致命面。
- **选中态**：行首框实心 + **整行底色**（`--dsw-alias-button-ghost-active-fill` / `-border`，与回收站
  选中行同源），不悬停也能一眼看出哪些被选中。整行底色借宿主行已有的 `data-row-key="session:…"` + `:has`；
  宿主将来改掉这个属性，最差是底色不亮 / 兜底多露一颗，勾选本身仍在（不是致命面）。
- **选中集**住模块级 store（仓内既有模式：`delete-confirm.tsx` / `undo-toast.tsx` 的现场），`useSyncExternalStore` 接；条目只收槽位投影原样给的 `sessionId` / `displayTitle`（行首槽只投 `sessionId`，标题从 root hook 的 `byId[id].title` 补），浏览器半不自己拼 id。**顺序 = 勾选顺序**（宿主 DOM 序不归我们读；`/apply` 那条「保持输入顺序」吃到的因此是勾选序）。每次执行后选中集**收缩为失败 id**；全成即空，但**模式不退**（浮条回到 0 条，可继续选）。
- **浮条**挂 `shell.overlay`，**模式内常驻（0 条也渲染）**：主行只留 0 条时「点击会话行选择」提示 +「查看已选」（有选中才出现）+ **同一个位置的「全选 ↔ 取消全选」切换**（所有可见可选行都已选中、或有选中但没有可见行时显示「取消全选」；否则「全选」。全选只收当前侧栏已渲染、未在跑的行；折叠组 / 归档过滤外 / 宿主隐藏的 subagent 不选）+「移入回收站 N 条」（0 条禁用）+「退出多选」。**「已选 N 条」与「含 K 个子会话，跟着整组走」移到展开后的列表头部**——主行不再放这一坨汇总文字。**查看已选**展开限高可滚动的标题清单（顺序 = 勾选顺序），有子会话数的标在它自己那行，逐条可移除；默认收起，避免盖住底部输入区。**层级必须落在确认框之下**（`.sd-modal-root` 1000 / 浮条 900）：2026-10-17 真机发现浮条在 1100 时会盖住确认框、还能抢它的按钮，已降级；`tests/skeleton.test.ts` 用「浮条 z-index < 模态根」钉住这条大小关系。**宽度按内容展开**（`width: max-content`，最多 `calc(100vw - 48px)`）：同日真机新增「全选/取消全选」后，`left:50% + width:auto` 的 shrink-to-fit 只拿左半屏，把「退出多选」挤到第二行；骨架用例钉住 width/max-width，窄到放不下才由主行的 `flex-wrap` 兜底。主按钮 `variant="primary"` 近黑——**不是红**：删除可逆，实心红只留给回收站里的「彻底删除」（同一次改稿里把第一版画错的红改掉了）。K 来自勾选变化后**防抖一次**的 `applyOutcomes('count', ids)`（一组 id 一次请求；响应带序号守卫，旧响应不落地），**读不到整句不出现**——与确认框同一口径，不许拿 0 冒充"没有"。

**被否的替代**：

- **行尾悬停单入口**（第一版）：入口悬停前不存在，选中态又只活在按钮上。
- **行首常驻勾选框**（第二版）：用户原话「不能常驻」；状态点 / 归档行仍勾不到。
- **自有选择器对话框**（复用回收站清单那套）：不是"在宿主列表里选"、多一层跳转，还要多养一份与宿主
  会话表同步的清单读面。

**硬限制如实记**：状态点 / 归档行没有行首勾选框（宿主不渲染），但模式内点整行可选中；运行中的行不可选。
宿主行的 `onClick` 是唯一打开会话的路径（行没有 tabIndex / 键盘打开面），capture 守卫已挡住它。

#### ② 确认框与撤销横幅：批量只加「数」，语法照单删

- **确认框**（新组件，单删那张不动）：标题 n≥2「删除这些 {n} 个会话？」、n=1 复用单删那句「删除这个会话？」；目标卡一张、内含 n 行（标题 + **有才标**的「含 M 个子会话」）——**目标卡限高 280px 滚动**（2026-10-17 真机一次选 64 条，卡片把弹框撑出视口、标题与底部按钮被顶没；沿用回收站批量恢复确认框的 280px 先例，只在卡内滚）；「含 K 个子会话，将一起移入回收站。」只在 K>0 出现，count 读不到就整句不说、也**绝不锁死主按钮**（与 10-15 §12 同口径）；hint 与单删**同一句**（不造第二句"可恢复"的话）；确认按钮「移入回收站 {n} 条」。K / M 都在**开框那一刻重问**（勾选期浮条那个 K 可能已过期；两处计数同源 `action:'count'`）。
- **不写项目名**：回收站那两颗按钮的确认框能逐条写项目名，是因为清册自带 `projectDir`；宿主列表这半的槽位投影只有 `sessionId` / `displayTitle`，为一句装饰去吃 `useWorkspaces` / `useSessions` 两个快照形状不值（跨代脆，属"声明即得"之外的暗契约）。真要加就从行上下文捕获进选中集、不在框里现查——这轮不做。
- **执行 = 一次** `applyOutcomes('delete', ids)`（不是 N 次请求）；第十二批那三条批量语义照旧是接口的一部分（去重保序 / 失败不传染 / 同批带走记幂等成功）。成功的行随 `announceRemoved` 从侧栏消失；组级联照旧（父与盘上孩子整组走、任一成员在跑整组拒绝）。
- **失败面与单删同语法**：信封 `message` **原样**落在它自己那一行（`Tag tone="danger"`），**框不关**、主按钮变「重试这 M 条」（只发失败那些 id）；成功的照走。每次执行完为「这次移走的」发一条撤销横幅（**覆盖上一条**）：横幅计数 = 那一次**成功支的条数**（含"被同批带走"的幂等条），撤销名单 = 成功支里**非 null 的 `value.id`**——两个数各说各的，不许互相冒充。
- **撤销横幅扩成两形**（同一个 `Toast` 宿主、同一停留 6 秒）：单条「{title} 已移入回收站」／批量「{n} 条会话已移入回收站」。撤销 = **一次** `applyOutcomes('restore', entryIds)`；`entryIds` 取成功支 `value.id` 的集合——`value:null` 的"被同批带走"成员跟着组走，**不单列进撤销名单**（撤父即撤全组，10-15 §11 的组语义）。撤销失败横幅只剩原文、撤销按钮消失（单删同款）。

#### ③ 文案键、模块落点与那颗按钮的皮肤

文案键（`copy.ts` zh/en 同集，`batch.*` 新命名空间 + 三个就近并入既有命名空间的键）：`batch.row.pick`（aria-label「勾选「{title}」以批量删除」）、`batch.bar.count`「已选 {n} 条」、`batch.bar.pickHint`「点击会话行选择」、`batch.bar.kids`「含 {k} 个子会话，跟着整组走」、`batch.bar.review`「查看已选」、`batch.bar.reviewClose`「收起已选」、`batch.bar.remove`「取消勾选「{title}」」、`batch.bar.selectAll`「全选」、`batch.bar.selectNone`「取消全选」、`batch.run`「移入回收站 {n} 条」（**浮条与确认按钮同句同键**，一句只住一个家）、`dialog.batch.title`「删除这些 {n} 个会话？」、`dialog.batch.retry`「重试这 {n} 条」、`undo.movedBatch`「{n} 条会话已移入回收站」。n=1 的标题复用 `dialog.title`，运行中 tooltip 复用 `menu.live`，**「多选 / 退出多选」复用回收站工具栏的 `trash.toolbar.select` / `selectExit`，汇总句复用 `dialog.subagents`、行内 chip 复用 `trash.row.subagents`**（同一句话不造第二个键）。

模块：`src/client/batch-select.tsx`（多选模式 store + 选中集 store + 行首勾选框 + 行尾兜底 + 整行点击守卫 + `fetchCounts`）、`src/client/batch-menu-item.tsx`（「⋯」菜单的「多选」入口）、`src/client/batch-bar.tsx`（浮条 + 已选清单）与 `src/client/batch-confirm.tsx`（批量确认框 + 它的现场）——**浮条单独一份文件**是落地时定的：它要 import 确认框的现场，而确认框要 import 选中集，两份合成一份就是一圈。`undo-toast.tsx` 的横幅加批量形（单条形不动）；`index.tsx` 新增**五条**槽位贡献（菜单「多选」行、行首勾选 `sidebar.session.row.leading`、行尾兜底 action 开关、overlay 浮条、overlay 确认框）——头注那本"五个贡献 / 四个入口"的账要跟着改成十个贡献。`DeleteMenuItem` 的 `separatorBefore` 改成可传（多选行带线、删除行不重复画线）。行首勾选复用回收站多选同款原生 `Checkbox`；行尾兜底的皮肤抄宿主 `dsh-client-ui-workspace` 的 `Rows.module.css` 那颗 `iconButton`（**16×16、`--dsw-radius-xs`、`label-tertiary`、无底无边**，asar 原文实测）；按下/禁用两档、浮条 `.sd-batch-bar`、以及宿主行的批量选中底色/兜底隐藏（`data-row-key` + `:has`）是自造，一起点进 `ui.css` 文件头那本「不是抄本」账（**现在是五条**，`tests/skeleton.test.ts` 钉着条数），类名 `sd-` 前缀——**来源表加第十张**（首张来自 ui-workspace 的），§8 门 4 逐属性比对只跑这一块。

#### ④ 这轮不做

组头「全选本项目」（宿主组头没有现成座位，要另探一轮；浮条上的「全选」只覆盖当前可见行）；Ctrl/Shift 连选（行点击现在能被守卫接管，但连选锚点、与宿主原有拖拽/重命名的叠加风险这轮不做）；确认框的项目名（见②）；并行执行（串行链的规矩照旧，第十二批"保持的偏差"②）。

#### 用例与真机门（落地后补读数）

- 单测面：多选模式（进入/退出、退出清空名单、模式外两颗勾选都不渲染）、「⋯」菜单入口（进入/退出、收菜单）、行首勾选（`data-seat="leading"`、标题从 root hook 的 `byId[id].title` 补、hook 缺失不炸）、行尾兜底（`aria-pressed`、`data-seat="action"`、运行中置灰且 tooltip 在）、**整行点击守卫（点行选中、宿主行 onClick 被吃掉、按钮放行、二次点击不反转、运行中行不选）**、浮条（模式内 0 条态/提示/退出、两句的有无、**查看已选展开/收起/逐条移除、移除最后一条留在模式内显示 0 条**、**主行不再放汇总，条数/子会话数在展开后的列表头**、**全选只收当前 DOM 里已登记且未在跑的行（DOM 序、已有选中在前）**、**同一位置的按钮在全选/取消全选间切换（不同屏；所有可见行已选或没有可见行但有选中时显示取消全选；取消清空但留在模式内）**、count 读不到整句不说）、**浮条 z-index 低于模态根 / width 按内容展开（骨架用例）**、确认框（n=1 / n≥2 两档标题、chip 有无、K=0 与 count 失败都不说那半句、失败原文落行、**重试只发失败 id**、执行后选中集收缩为失败名单、**80 条时目标卡限高 280 滚动且标题/底部按钮仍在**）、撤销（批量一次 `restore`、撤销名单不含"被带走"成员、失败只剩原文）、store（去重、勾选顺序）。红检照仓规矩**先看红再落绿**。
- **真机门（交用户，桌面 `0.2.0-rc.2`；只动浏览器半 ⇒ 先在带可见浏览器的隔离 home 过、再装 live）**：① 任意会话「⋯」菜单里出现「多选」；按下后菜单收起、侧栏行首出勾选框、浮条显示「已选 0 条 / 点击会话行选择 / 退出多选」，且**正常窗口下一行放得下（退出多选不换到第二行）**；**不悬停**也能点整行选中，**宿主不会切会话**；再点一次取消；② 勾 2–3 条（含跨项目、含一条带子会话）后**主行只看到操作按钮、不再有一坨「已选 N 条 / 含 K 个」**；点「查看已选」后汇总出现在列表头，逐条移除一条后头里的计数跟着变；**全选/取消全选是同一个位置的同一个按钮**，点「全选」只带上当前可见行（先折叠一个项目组再点，折叠组里的行不许进来；运行中的行也不许进来），此时同一位置变「取消全选」，点了清空但浮条仍在 0 条态（只剩提示/全选/退出）；③ 浮条 → 确认框的数对 → **确认框打开时浮条在蒙层下面，不盖住确认框、不抢它的按钮**；**一次选 64 条再开框，标题与底部按钮在场，80 条目标准在卡片内部滚动** → Network 里**只有一条** `POST /apply` → 行消失 + 横幅 → 点撤销行回来；执行后模式仍在、浮条回到 0 条；④ 故意挑一条失败（先手工移走它的会话目录）→ 原文落它自己那行、按钮变「重试这 1 条」、成功的照走；⑤ 状态点行 / 归档行：行首没有框，但点整行仍能选中并出整行底色；运行中的行点整行不选、悬停勾选置灰有原因；⑥ 「退出多选」清空名单并撤掉勾选框/底色；⑦ 控制台零 error/warn。**全部未跑**。

- **单测**：390 → **425**（+35：第十三批批量面 + 多选模式、菜单入口、整行点击守卫（含 React 合成事件）、0 条浮条与已选清单、**浮条 z-index 低于模态根 / width 按内容展开的骨架用例**、**同一位置全选↔取消全选 / 汇总移到列表头**、**80 条目标卡限高滚动**；装配面两行菜单）。
- **三道门退出码**（逐个 capture，不接管道）：`npm test` **0**（425 通过 / 28 个文件）、`tsc --noEmit` **0**、`npm run build` **0**（tsdown + tsc 两步）。
- **读数**：Node 半 **90.90 kB / gzip 34.51 kB**（整批未动）；浏览器半 **847.03 kB / gzip 194.82 kB**（相对第十二批 801.03 / 181.93 ⇒ **+46.00 / +12.89**，整批第十三批含多选模式、菜单入口、整行点击守卫、行首/兜底勾选、已选清单、同一位置全选↔取消全选、汇总在列表头、批量确认与撤销、确认框层级/目标卡限高修正，以及浮条按内容展开）。发布包 **55 文件 / 284.6 kB**（上一批 51 / 266.5；多出的是 `batch-select` / `batch-menu-item` / `batch-bar` / `batch-confirm` 四张声明，仍不含 1.32 MB 的 map）。产物纯度照旧：`require()` 逐字三条 `react` / `react-dom` / `react/jsx-runtime`，`node:` 与裸内建 0 条。`ui.css` 新增的是自造件（行首包装、浮条清单/提示、宿主行底色/兜底隐藏），官方抄本那几张表一个字没动 ⇒ §8 门 4 的逐属性比对不用重跑。

### 2026-10-17 工作区没了也能恢复批（第十四批）：账本缺席按「未分组」收，不把恢复挡死

来由：用户一句「当前如果工作区没了，回收站恢复就会报错，对吧？这个能修么？」——先坐实：**是**，而且是两层事实叠出来的必然。

**根因**（两处，各自都能逐字读到）：

- 宿主的「删除工作区」只删**注册**、保留目录与每一份会话日志。asar `dsh-workspace/lib/types/index.js`（0.2.0-rc.2）的 `WorkspaceRegistry.delete(id)` JSDoc 原文：`Delete one workspace registration while retaining its directory and every session log.`；`deleteKnown` 只做 `workspaceIds` 过滤 + `entities.delete` + `table.delete`，一个会话目录都不碰。那些会话之后按宿主自己的口径落在「未分组」。
- 我们的清册在**删除那一刻**记下 `workspaceId`（`delete-session.ts` 的 `workspaceOf`；空串 = 删除时就没有账目）。恢复的触点 ② 原来只判"空串就跳过"，非空就 `attachSession`。⇒ **删在工作区之前**的条目，工作区后来被删掉之后：`registry.get(ws)` 回 `undefined` ⇒ 端口抛 `workspace not found (attach)` ⇒ `restoreOne` 把目录 rename 回收站、整条折成 `sessiondelete/io`（原文「挂回账本失败：…」）。表现就是**会话留在回收站、恢复点不动**，正是用户报的那个错。

**修法**（三层，各说一件事）：

1. **端口**：`HostPort.workspaceExists(workspaceId)` = `registry.get(id) !== undefined`。只读、不抛（`get` 是 `entities` 这个 Map 的直通），好在写任何字节之前问。
2. **动词**：`restoreOne` 在 rename 之前定下"挂不挂账本"——`entry.workspaceId !== '' && workspaceExists(...)` 才挂；否则与「未分组」同路（跳过 ②，回滚里也没有 detach 这一步，新增一个 `attached` 位）。**查过之后、挂之前账本被删**（宿主的删除工作区与这次恢复撞上）再问一次：工作区真没了就按未分组收；还在 ⇒ 仍旧 `io` + 回滚。**不重建工作区**：`registry.create(path)` 要求一个已存在的绝对目录，而条目里只有有损的 `projectDir`（分隔符被折成一个 `-`），重建一个用户刚删掉的注册是没人要的副作用；宿主自己处理这类会话的方式本来就是「未分组」。
3. **清单与界面**：`GET /list` 的行上多一个**只读事实** `workspaceMissing`（`workspaceId` 非空且账本里没有它才出现；缺席 = 还在 / 没得判），行内挂一句「原工作区已不存在，恢复后归入未分组」，批量恢复确认框逐条同一句（同一个键 `trash.row.workspaceGone`）。这句是**这一条的属性，不是某次动作的失败**，所以放在点之前；恢复本身没有可挂的成功提示（单行恢复从来就不弹），等它完成再说不算"先说"。四个只读数都**不落清册**（同 `subagentCount` / `strandedSubagents` 的规矩：清册只记文件里真有的事实）。

**边界与不动的**：

- `project-missing` 一个字没改：`sessions/<projectDir>` 不在仍然拒绝、绝不静默建目录。那和工作区注册是两件事——`sessions/` 下那格是**数据根里的会话落点**，不在可能是盘没挂上 / 数据根换了，静默重建会把会话放进一个宿主未必扫得到的地方；而工作区账本只是可选归属（触点 ② 从 2026-09-30 起就是"账目可选"）。
- 不把 `workspaceId` 从清册里改写掉：清册记的是删除时的事实（同 `parentEntryId` / `wasArchived`），改写历史会让"这条原来属于哪个工作区"再也答不出。
- 不按 cwd 去匹配/复活一个同路径的新工作区：那要先有「工作区 id ↔ path」的读面与一套匹配规则，这条只是在补一个失败面，不该长出第二套归属逻辑。

**为什么不选**（替代）：① 自动重建工作区（见上，`create` 的门槛与"用户刚删掉它"都不同意）；② 把它判成 `project-missing` 或继续报错（那就是把要修的报错换个码，用户要的是恢复）；③ 只在客户端把恢复按钮藏掉（条目还是恢复不了，清册/账本的不一致也没人修）。

**用例**（425 → 433，+8）：restore 3（工作区没了照常恢复且不 attach、原本未归档的 unarchive 照旧、attach 撞上账本被删⇒按未分组收且不回滚）；api 2（`workspaceMissing` 只在真缺时出现、`workspaceId` 空串的条目不问账本也不带字段）；assembly 1（`workspaceExists` 走 `registry.get`：在/不在/不抛）+ 方法表 16 → 17；client 2（行上那句且工作区还在时没有、批量恢复确认框逐条说同一句）。**红检**：三条 restore 用例先红在"attach 被调用 / 抛 io"。

**三道门**（逐个 capture，不接管道）：`npm test` **0**（433 通过 / 28 个文件）、`tsc --noEmit` **0**、`npm run build` **0**（tsdown + tsc 两步）。

**读数**：Node 半 **92.09 kB / gzip 34.91 kB**（上一批 90.90 / 34.51 ⇒ +1.19 / +0.40：端口一个新方法、清单装配一次账本判别、恢复那段与两处注释）；浏览器半 **847.92 kB / gzip 194.98 kB**（上一批 847.03 / 194.82 ⇒ +0.89 / +0.16：类型窄镜像、行与确认框各一句、一条文案键）。发布包 **55 文件 / 286.0 kB**（上一批 55 / 284.6；没有新文件）。产物纯度照旧：`require()` 逐字三条 `react` / `react-dom` / `react/jsx-runtime`，`node:` 与裸内建 0 条（只有注释里出现 `node:`）。`ui.css` / `markdown.css` 一个字没动 ⇒ §8 门 4 逐属性比对不必重跑。

**交付时的门**：两半都改了 ⇒ Node 半要重启宿主才生效；浏览器半那趟按 AGENTS.md 的硬约束仍要在**有可见浏览器的隔离 home** 上过一遍再装进 live profile。这一批交付时只跑了单测 / 类型 / 构建三道门，真机门交给用户的四条判据是：删掉一个工作区 → 回收站里**删在工作区之前**的旧条目上应出现那句 → 点「恢复」应成功、会话落在「未分组」；工作区还在的条目不应出现那句，也不该有任何行为变化。

**真机门实跑（2026-10-19，用户桌面）**：上面四条**逐条走过、都对得上**——旧条目上那句出现、恢复成功、会话落在「未分组」，工作区还在的条目一句未出、行为无变化。宿主是 **0.2.1-rc.1 与 0.2.1-rc.2**，装法 `link:` 回本仓工作树（含这批修复）。**如实记下偏差**：走的是 live profile，没有先起「有可见浏览器的隔离 home」那道顺序——本仓那条硬约束防的是"客户端条目激活失败 = 宿主进程死"，这次两代宿主上浏览器半都正常起来了，现象侧没有残余风险，但**顺序本身没按字面走**（第十五批之后要补的就是把它按字面走一遍，或者把这条硬约束的判据改成"live 上验过浏览器半正常激活即可"）。

### 2026-10-19 评审批（第十五批）：同一判据只留一个家，兜底只认它该认的那句

来由：以 `15b7fb6`（发版 0.2.0）为基线对 HEAD 跑了一次两轴评审（规范轴 + 规格轴）。六条里**五条动 Node 半与端口层、一条动注释与文档**，浏览器半一个字没碰；收的都是第十四批自己留下的形状问题，不是新需求。

**改的六件事**：

1. **端口给它的失败一个判据**（`src/ports/host-port.ts`）：`attach` / `detach` 抛的那句「账本里没这个工作区」的原话前缀收成 `WORKSPACE_MISSING_MESSAGE`，并导出 `isWorkspaceMissingError`——原话与认它的判据同住一处，调用方不许另抄字符串。**消息逐字未变**。
2. **竞态兜底收窄**（`restoreOne`）：第十四批「查过之后、挂之前账本被删」那条兜底原本吞**任何** attach 错误。现在只在"错误就是端口那句"且"再问一次工作区确实没了"时才按未分组收；别的失败（哪怕同一刻工作区刚好也没了）照旧回滚报 `io`——不给一次存储故障伪装成「归入未分组」的机会。
3. **`attachedTo: string | undefined` 取代 `attached: boolean`**：三处回滚点上 `attached && workspaceId !== undefined` 的后半句恒真，而真正的第三态是"有工作区但没挂上"。一个变量说一件事，三处 `&&` 删净。
4. **判据同源**：`attachableWorkspaceId(host, entry)`（这次挂不挂账本）与由它派生的 `isWorkspaceMissing(host, entry)`（那句说不说）导出在 `verbs/restore-session.ts`；`assembleTrashRows` 不再自己写一遍极性相反的判据。行上的承诺与动词的决定从此只能一起变。
5. **装配按 `entry.id` 键控**：`workspaceMissing[index]` 那种靠两个 `Promise.all` 下标对齐的写法换成 Map——旁边 `stranded` 本来就是键控的。
6. **两处「只读数」的镜像陈述**：`assembleTrashRows` 的头注释不再把一个 boolean 叫"数"、也不钉条数；10-15 稿 §11 那句「分三个只读数交出去」改成「这一批加的是……，总数不钉在这里」。

**闸**：`tests/skeleton.test.ts` 里 `dshReleases` 那条现在**双向**钉（实测代次全在册 + 在册的全属实测代次），名单里塞一个没跑过的代次会红。

**保持的偏差**（评审点名后判为不动，各有各的理由）：① **删除侧 `undoOneIn` 不同步新判据**——它只在 `deleteSession` 内部整组退回时跑（用户点的「撤销」走的是 `restoreSession`），每一步 `.catch(() => {})` 是它的契约；工作区没了 ⇒ attach 静默失败、会话落「未分组」，与恢复侧**终态一致**、无用户可见差异，改它只是给一条没人看的线加读数。② peer 正控从 `.toBe` 换成 `toContain`（实测过的某一代）语义未坏。③ `archive` 那个没人收的第二参、行上的 `data-dsh-session-delete` 锚点、行内那处 inline style 是**存量约定**（同款 style 已有五份、同款锚点九处多数被测试消费），不是这批的债。

**用例账**：433 → **435**（+2：attach 抛的不是端口那句 ⇒ 工作区刚好也没了也照样回滚报 `io`；挂账本的判据与清单那句同源——还在 / 没了 / 从来就没有，三个结论）。**红检**：新那条在改前的代码上会红（旧兜底会吞掉它、按成功走完）；反向闸与键控改动由既有用例覆盖。

**三道门**（逐个 capture，不接管道）：`npm test` **0**（435 通过 / 28 个文件）、`tsc --noEmit` **0**、`npm run build` **0**（tsdown + tsc 两步）。

**读数**：Node 半 **94.11 kB / gzip 35.62 kB**（上一批 92.09 / 34.91 ⇒ +2.02 / +0.71：端口那句判据、恢复侧两个同源函数、装配换键控）；浏览器半 **847.92 kB / gzip 194.98 kB**（**未动**——这批一个字没碰 `src/client/`）。发布包 **55 文件 / 288.1 kB**（上一批 55 / 286.0）。

**真机门（未跑，交用户）**：这批只动 Node 半与端口层 ⇒ 重启宿主即生效，不涉及那条「隔离 home」的硬约束（浏览器半无改动）。判据三条：① 回收站清单照常出（装配换了取数写法，含孩子折进父行那套）；② 原工作区没了的旧条目那句仍在、点恢复仍成功、仍落「未分组」；③ 挂账本真故障时仍是回滚 + 原文上屏，不会静默把会话改归属。

### 2026-10-19 宿主要求批（第十六批）：顶层 `engines.dsh` 正面回答"装得上"

来由：素材商店（dsh-market）的卡片上，本仓 0.2.0 与 `dsh-novel` 0.6.2 都被标成「未声明宿主要求」。顺着 dsh-market 的解析读回去，商店的牌子和宿主的安装闸读的是同一处：**顶层 `engines.dsh`**（没有才退到 `dsh.engines.dsh`，再没有才看 `@deepseek-ai/dsh*` peer）。本仓自 2026-10-02 拆掉唯一一条 dsh\* peer 之后，清单里再没有任何 DSH 声明；`dsh.compatibility.dshReleases` **谁都不读**（dsh-market 源码与桌面 asar 零命中），所以牌子只能停在「未声明」。

**判据（逐字读自桌面 asar 与 dsh-market 的 `discovery-compatibility.ts` / `verify.ts`）**：

- 宿主：声明了 `engines.dsh` ⇒ **只由该范围决定、peer 被忽略**；没有才逐条比对 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer；预发布版本参与匹配；空/无效范围（含 `workspace:`）视为不兼容；两者都未声明 ⇒ 不施加约束。
- 商店：读 npm `latest` 清单的 `engines.dsh` ?? `dsh.engines.dsh` + `@deepseek-ai/dsh*` peer（cordis / schemastery 被明确排除）；**任何范围串超过 256 字符整条丢弃**——`dsh-novel` 0.6.2 的 `dsh-tools` peer 是 261 字符，本机缓存里的 facts 就只剩 cordis / schemastery，于是同样落进「未声明」。有效声明为零 ⇒ `basis:'undeclared'`。
- awesome 的 `index.json`：每晚 probe 只读**顶层** `engines.dsh`（2951 条里 485 条带它）。

**改的**：`package.json` 的 `engines` 加 `"dsh": ">=0.1.7-rc.2 <0.3.0-0"`——地板 = **完整功能**的最低代次（见下段实测），天花板是下一条线的起点（`<0.3.0` 在 includePrerelease 语义下会放行 `0.3.0-alpha`，必须 `-0`）；长度 21，远低于 256。**peer 保持零条**：dsh\* 判断只住 `engines.dsh` 一处。README 的「兼容性分两层」与 §11 跟版策略按新判据改写；AGENTS.md 那条不变量从"peer 是闸"改成"`engines.dsh` 是唯一声明处"。

**地板探针（2026-10-19，CLI 台架；各代装进临时 DSH_HOME 的 web profile，浏览器看控制台与资源加载，另直连 `/ping`）**：

| 代次 | Node 半 | 客户端半 | 判据 |
| --- | --- | --- | --- |
| 0.1.5-rc.1 | ping 通 | 资源加载、ping 通；三个会话行槽位（`menu.item` / `row.action` / `row.leading`）**全缺** | 只剩回收站面板，删不了会话 |
| 0.1.7-rc.1 | ping 通 | 资源加载、ping 通、控制台零错误；**只缺** `sidebar.session.row.leading` | 能用；批量选择缺行首主勾选框（行尾兜底还在） |
| 0.1.7-rc.2 | ping 通 | 四槽位齐全、零错误 | **完整功能下界** |

两条排除：① 0.1.5 页面上那个 `slot entry crashed in 'sidebar.workspaces'`（`retainAccountKeys` 里 `Object.entries(undefined)`）在**不装任何第三方插件的裸模板**上原样复现 ⇒ 是那一代宿主自己的问题；② rc.1 缺槽位不会让插件崩（`slots.inject` 只是不触发），现象是"模式进去了但行首没有勾选框"。**台架读数只用于定 `engines.dsh` 地板，不进 `dshReleases`**（那份仍只收桌面真机跑过的代次）。

**闸**：`tests/skeleton.test.ts` 新增一条（用真 `semver`，devDependency；另用 semver 7 离线验过三代命中、`0.3.0-alpha.1` 命不中）：窗口盖住全部实测代次、不越过下一条线、≤256 字符、不在 `dsh.engines` 另写一份。既有的"零 dsh peer"与 `dshReleases` 双向一致照旧。

**三道门**（逐个 capture，不接管道）：`npm test` **0**（436 通过 / 28 个文件）、`tsc --noEmit` **0**、`npm run build` **0**。**读数**：Node 半 **94.11 kB / gzip 35.62 kB**、浏览器半 **847.92 kB / gzip 194.98 kB**（两半都未动，只有清单、测试与文档变了）；发布包 **55 文件 / 288.3 kB**（0.2.1 发布包实测；上一批 55 / 288.1）。

**真机门（未跑，交用户）**：只动清单与文档，两半零改动 ⇒ 不需要重启即无行为变化。装/验判据三条：① `dsh plugin add` 在 0.2.0-rc.2、0.2.1-rc.1、0.2.1-rc.2 上不拒；② **发布下一版之后**，商店卡片应显示 `engines.dsh: >=0.1.7-rc.2 <0.3.0-0` 而不是「未声明宿主要求」（商店读 npm `latest`，工作树改了不会变；本机清单缓存 TTL 24h）；③ 将来有 0.3.0-* 宿主时，应被拒装。
