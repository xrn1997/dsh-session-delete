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

**做**（三个动作）：删除（移入回收站）／恢复／彻底删除。

**不做**（要加先问）：批量操作、正文检索、收藏、闲置自动清理、跨机同步、附件的引用计数回收、agent 工具面、独立的回收站页面、自动过期。

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

| 触点 | 删除时 | 恢复时 |
|---|---|---|
| ① 会话目录 | `rename` 进回收站 | `rename` 回原项目目录 |
| ② 工作区账本 `tables.workspaces[<ws>].sessionIds` | `ctx.workspaceRegistry.get(workspaceId).detachSession(sessionId)`；**账目是可选的**——宿主的"删除工作区"会留下没有账目的会话（它们显示在「未分组」下），那种会话照样能删：跳过这一步，清单里工作区记空串 | `ctx.workspaceRegistry.get(workspaceId).attachSession(sessionId)`；清单里是空串就跳过 |
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

- **live 会话**：磁盘上没有任何存活标记（实测 446 个会话目录里只有那一个 `.jsonl.zstd`），liveness 只在内存 ⇒ 必须查注册表；**首版一律拒绝**（`sessiondelete/live`），不替用户终止正在跑的活。活跃判据用**宿主官方的那一条**，不自创第二套：`ctx.waterfall("workspace/session-activity", { sessionId }, () => Promise.resolve([]))`，**空数组 = 无活动**，非空即判 live——宿主自己的 `archiveSession` 准入读的就是同一条 waterfall（见 §9），所以我们的拒绝与它的归档准入同源。第三方插件 ctx 上这条可用（隔离宿主实测：`typeof ctx.waterfall -> function`，未知 id 拿到 `array length 0`）。
- **附件不连带**：`~/.dsh/attachments/v1/objects` 是**全局内容寻址**，与会话不是父子关系 ⇒ 删除不连带、恢复不涉及；被删会话独享的附件会留成垃圾，**不做回收**（要做得先有引用计数，属另一件事）。
- **回收站不自动过期**：不设天数上限（魔法数字）；界面显示条数与占用，清空是显式动作。
- **数据根只镜像后两级**：`resolveDshHome(configured, env)` 的优先级是「显式配置 > `$DSH_HOME`（空白视为未设）> `~/.dsh`」，本插件只实现后两级。**这不是偷懒**：平台的同款 helper `dshHomePath()` 逐字是 `join(resolveDshHome(), …)`、同样不传 `configured`；`ctx.profileContext` 按 launcher 原文只装 profile 位置 / 启动 bundle 名 / 调用覆盖 / 遥测开关，不含数据根；宿主自己的服务是各自声明 `Config.dshHome`、由装配方填的 ⇒ **第三方没有"问出显式配置"的口**。表现：那种 profile 下文件探测落空 ⇒ 删除/恢复以 `not-found` 拒绝、零副作用（sessions 与回收站同源、永远同卷，**不会**跨卷 rename）。
- **恢复默认走 `attachSession`（id 前插，即排在账本首位）**。"原位恢复"要记下账本序号并用 `insertSessionBefore`，列为待定项（§11）。
- **不做"删一半"的状态**：任一步失败即回滚已做的步骤，并把原始错误带上（见 §6）。

## 6. 错误形状

动词与端口一律 `throw verbError('<因>', message, cause?)`（`src/verbs/errors.ts`），由**唯一一张映射表** `src/remote/map-error.ts` 折成插件专属域 `sessiondelete/<因>`——它同时认宿主两条类型化错误（按 `this.name`）。两半之间的载具是宿主 web server 上的插件前缀路由（§10 通道那条），**线上就是失败信封里的 `error.code` 与 `error.message` 两件**：所以浏览器半按 `code` 字符串判别（不看 instanceof，JSON 里也没有实例），`message` 是上屏的原文。**域名取插件专属的 `sessiondelete`，避免与宿主官方域重名**：

| 码 | 触发 |
|---|---|
| `sessiondelete/live` | 会话正在运行 |
| `sessiondelete/not-found` | 会话目录不存在，或宿主的持久化里没有它（推不出项目目录）。**没工作区账目不算 not-found**——未分组的会话照样可删 |
| `sessiondelete/trash-empty` | 要恢复/彻底删除的条目不在清单里 |
| `sessiondelete/project-missing` | 恢复时目标项目目录不存在（不静默建目录） |
| `sessiondelete/io` | 文件操作失败；原文进 `message`（原始 cause 只住在宿主进程里，出不了进程边界） |
| `WorkspaceUnknownSessionError` → `sessiondelete/not-found` | 宿主"会话未知"的类型化错误（`archiveSession` 的已知性检查）——我们的码是**映射**来的，不是自己判的 |
| `WorkspaceActiveSessionError` → `sessiondelete/live` | 宿主"仍有活动在跑"的类型化错误（`archiveSession` 的活跃准入）——同样是映射，不是自己判的；我们与宿主读的是同一条 waterfall（§5） |

路由层自检（未知路径 / 方法不对 / 请求体不对）也走**同一张表**，落到 `sessiondelete/io` + 一句说清哪儿不对的 `message`——不给这条薄线另开一套错误词。

本地失败（同进程内调用）不进这张映射表。

## 7. 界面

五个状态（**本节就是界面规格**——本仓不另存像素稿，结构与层级以这段为准，皮肤只由官方 token 决定）：① 会话条目「…」菜单里的红色「删除」② 确认框（主按钮是官方 `variant="primary"`——宿主浅色下它是近黑 `bluish-1000`、深色下近白 `bluish-50`，**从来不是蓝**："蓝"是当年手绘稿的占位配色留下的错觉，2026-10-01 真机浅色截图后改正；正文明说可恢复）③ 删除后即时撤销提示（停留 6 秒；宿主 Toast 默认 3 秒） ④ 回收站清单：**按项目分组的卡片列表**，每条两行（标题 / 「删除于 … · 大小」，绝对时间在 `title`），动作收在右侧——恢复是描边、彻底删除是安静的红，**整页唯一一块实心红是页脚的「清空回收站…」**；条数与合计占用住头部，页脚那句必须看得见（不套省略号）⑤ 彻底删除的红色二次确认（单条与清空**共用同一个**确认组件，主按钮都用页脚那款实心红；上面那句「整页唯一一块实心红」说的是面板本体，浮层是另一层）。

- **入口**：菜单项挂 `sidebar.workspaces.session.menu.item`；回收站入口是**一对座位**——`sidebar.panellist` 的一行图标（行本体归宿主：按钮 / 名字 / `aria-current` 选中态 / 折叠 tooltip，我们只交一个 glyph）+ `main` **同字 key** 的中央面板（清单本体）。**两条必须同批注册**：`ctx.layout.selectPanel(id)` 对没在 `main` 里注册的 id 直接抛。为什么不挂底栏，见 §10。
- **空态与面板自身的状态机**：回收站那一行始终在（面板行的常驻性归宿主）。**不做计数角标**（glyph 座位只有 16/18px，角标只能压到邻行）；条数与合计占用住面板头部，头部另有一个「刷新」按钮（面板自己重读一次，不依赖失效通告台）。面板本体四态：**读数中**（「正在读回收站…」）／**空**（「回收站是空的」，且底部**不出现**「清空回收站…」）／**读数失败**（宿主原文上屏 +「重试」按钮，绝不吞）／**有条目**（分组卡片列表）。
- **组头的项目名**从宿主 `projectKey` 反推：`--…--` 裹边与 `~XXXX` 十六进制转义还原成原字符（还原函数 `unescapeProjectKey` 住在两半共用的 `src/shared/wire.ts`，与 Node 侧的编码镜像配对），**完整原串**交给组头的 `title`（分隔符那一层是有损的、拆不回真实路径，故不作声称）。
- **运行中**：菜单里「删除」置灰并提示"会话正在运行，先停止再删除"。
- **未接通态（取数通道缺席）**：客户端半在注册任何入口之前先**探测一次**取数通道（同源 `GET <前缀>/list`，见 §10）；探测不过 ⇒ **一个槽位贡献都不注册**（连同那一对面板座位）——菜单行也一样：通道不在时点它只会开一个必然失败的确认框，半吊子 UI 比没有 UI 更糟。"不可用"以**入口不出现**表达，不新造禁用态 UI；宿主页面上看不出本插件的存在，但**不会因为本插件而死**。反过来，探测**过了**（哪怕这次 `list` 回的是失败信封）就照常注册：那次往返已经证明路由在、依赖接上了、错误映射也生效了，失败该做的是把原文交给用户看。
- 配色/圆角/图标全部走官方 `dsh-client-ui-primitives` 的 token 与官方图标集（**字号是宿主同类面读数的字面量 px**，见 `trash-panel.tsx` 头注）；界面不另存像素稿，结构与层级住在本节。

## 8. 验证门（顺序即优先级）

1. **幽灵行实验（红检在前，实现第一步）——已结（2026-09-30；隔离数据根上的数据层取证）**。做法：在 `DSH_HOME=<临时目录>` 的隔离宿主里造一个真落盘的冷会话（`sessions/<projectKey>/<id>/session.v4.jsonl.zstd`）→ 经官方冷读路径给它落一行投影缓存 → 经**我们的** `sessiondelete/delete` 删掉它。三处读数：① **官方会话列表读面全部不再返回它**——`session.list`（`sessionController.list`，UI 侧栏那条）、`sessionQuery.listSessions()`、`registry.listStoredHeaders()`、`sessionPersistence.list()`、`registry.list()` 的 `sessionIds` 五处都是「删前有、删后无」；**重启后已复核 4 处**（`registry.listStoredHeaders()` / `registry.list()` 的 `sessionIds` / `session.list` / `sessionQuery.listSessions()`），这 4 处重启后仍然无（启动期从磁盘 header 重建索引也造不出幽灵行）；第五处 `sessionPersistence.list()` 的重启读数只记在报告对照表里、**无逐字原文**，未单独取证；② **缓存行原样留在原地**：`storages/session_projcache/sessions/<id>.json` 删前删后同一个文件、字节数未变、`identity` 与 `title` 行未变——删除动词一个字节都没碰它；③ **归档集成员按预期变化**：`registry.archivedSessionIds` 走 `[] → [id]（我们手动归档）→ []`——**该读数取于 ③ 还是「摘归档表」的版本**；同日 UI 层复核后 ③ 已改为「**确保**归档」（§4 触点③），所以现在的删除会让 id **留在**归档集里。**结论：缓存行不必碰（§4 ④ 保持"不碰"，归属写死）**——残留行是**不可达的孤儿**：投影缓存服务没有枚举面（方法面只有 `recordFor / cachedSnapshot / cachedPredecessorTitle / viewRecord / hydratePrepared / write / coldSnapshot`…，一行只能靠「会话 header 做身份见证」读到），而删除之后没有任何读面再交出这个 header。**不碰的代价**：每个被删会话留下一个孤儿 JSON（本实验 4141 B）且**没有回收者**；恢复侧照旧不碰（冷读会用 identity 过滤，同名 id 但 `createdAt`/`cwd`/`isSeeded` 不同的新会话不会串味）。**UI 层的核验点**：侧栏与"已归档"页有没有像素级残影、客户端有没有自持列表绕过服务端读面。**UI 层已核（2026-09-30 真机 + 客户端派生代码）**：① "已归档"页确为「会话列表 ∩ 归档集」——客户端 `groupByWorkspace` 按 `sessionVisible` 过滤，`archivedFilter === "only"` 时判据就是 `archived.has(id)`；② **本门那句"删除后没有任何读面再返回它"只对冷会话成立**：真机上一条**活体**会话（本机运行期打开过）被删后，文件已进回收站、账本已摘，侧栏却仍留着一行、落在「未分组」下——因为 `listSessions()` 是"持久化 ∪ 内存活体"的并集，而摘掉活体没有官方口（§4 末）。修法即触点 ③ 改为"确保归档"，已落码。**这条经验同时说明**：数据层红检（本门）与 UI 层验收是两个面，**冷/活**是它们的边界条件。
2. **全链路**：临时会话 删 → 回收站有条目 → 恢复 → 能在侧栏打开且内容不变 → 彻底删除 → 文件消失。
3. **边界红检**：正在跑的会话被拒（`sessiondelete/live`）；归档过的会话删后恢复仍处归档态；恢复时项目目录不匹配被拒；清单条目在而目录被人为移走时不静默跳过；**删后分组面不得再出现该会话（活体会话亦然）**。**已跑（2026-09-30）**：前四条都在**隔离 `DSH_HOME` 上的活宿主**（desktop 0.2.0-rc.2，镜像 desktop 组成的临时 profile）上经 §10 那条前缀路由逐条取证，读数与判据一致。live 那一条的**活跃状态**由宿主官方 admission seam（`workspace/session-activity`）报出——隔离 home 里没有凭据、跑不起真 agent turn，所以状态是喂进去的，但判据是宿主的；同一条会话也被宿主自己的 `archiveSession` 以 `WorkspaceActiveSessionError` 拒绝，两侧同源。**同批复核了 §6 的 `not-found` 判据（活宿主）**：`readSessionHeader` 对未知会话抛的原文仍是 `cannot validate session '<id>': session persistence holds no such session`（`src/ports/host-port.ts` 的判据串命中），`POST /delete` 未知 id 得 `sessiondelete/not-found`。**这条判据的脆弱面（未修，跟版必重跑）**：单测夹具（`tests/assembly.test.ts`）复读同一句字面量 ⇒ 宿主改文案不会让任何用例转红，只有活宿主复核能发现。**第五条（删后分组面）是 2026-09-30 真机验收时才暴露的**：当时触点 ③ 是"摘归档表"，活体会话因此掉进「未分组」；③ 改成"确保归档"后由它保证，**真机复测待做**（单测侧钉在 `tests/delete-session.test.ts` 的调用序上）。**第六条（未分组可删可恢复）同一天暴露**：侧栏「未分组」下的会话（宿主的"删除工作区"留下的、没有账目的那种）点删除报 `sessiondelete/not-found`——原实现把"账本里有它"当硬前提；已改成"账目可选"（触点 ② 那行），单测钉在 `tests/delete-session.test.ts` / `tests/restore-session.test.ts`。
4. **真机验收**：在 desktop 0.2.0-rc.2 上按日常习惯删一个真会话，手感"顺手"。**已跑两轮（2026-09-30）**：第一轮暴露"删完仍留在「未分组」"（= 触点 ③⑤ 那条边界）；第二轮 删除 / 恢复 / 彻底删除 三条都走通，手感"顺手"，同时暴露并修掉**未分组会话删不掉**与**回收站面板不刷新**（面板只在挂载时取一次数，删除发生在侧栏菜单那边，没有共同父组件 ⇒ 加了一个模块级失效通告台）。**浏览器半这轮改动只做到"激活与渲染"这一层**：隔离活宿主上侧栏出「回收站」行、面板开得起来显示正确空态、零控制台报错、宿主存活；"点删除→面板当场刷新"的**交互**因该环境内置浏览器无可见视口（指针/hover 被拒、宿主会话行菜单 hover 才渲染）没驱动成，改由 RTL 端到端用例（`tests/client/index.test.tsx` 的"删除成功后回收站面板立刻刷新"）覆盖。**下一次动浏览器半时，交互那一层仍要按 AGENTS.md 的硬约束在有可见浏览器的隔离 home 上补一次**。**入口迁位这一批已在隔离活宿主上跑过（2026-09-30）**：镜像 desktop 组成的隔离 profile（`dsh-base` + `dsh-web-app` + 小说 + 本插件，两个插件都走 `plugin add link:`）上起 web 宿主，浏览器侧读数四条——① 侧栏面板列表出现 `aria-label="回收站"` 的行，类名是宿主自己的 `_2H3hWW_panelRow`（rail 态 36×36，label 来自**我们的注册元数据**）；② 点击后该行 `aria-current="page"`；③ 中央列渲染出 `data-dsh-session-delete="trash-panel"`（隔离 home 里没有回收站 ⇒ 空态「回收站是空的」，说明探测过、四端点通）；④ 控制台零 error/warn（没有 `web boot: N entry did not activate`）。**带真会话的完整手感（删 → 恢复 → 彻底删）仍归真机验收，未跑**。**2026-10-01 卡片改版这一批的验收状态**：结构、时间分桶、危险动作层级三档都在单测与一张 token 精确的静态替身上量过（1500px / 520px 两档：正文列宽 760、卡片 57px 等高、按钮 28px、无横向溢出；行内 danger 计算底色 `rgba(0,0,0,0)`、批量那块 `rgb(242,90,90)`），但**卡片分支当时还没在真宿主上渲染过一次**——那四条活宿主读数走的是空态，而 `relativeTime` 与组头的 folder glyph 只在有条目时才被调用；这套单测对「真产物少一个具名导出」又是**免疫**的（`vitest.config.ts` 把整包 alias 到替身，缺席落在渲染期而不是加载期，见替身头注 ⑦）。**同日补齐（2026-10-01 真机·浅色，用户截图）**：回收站 3 条 / 2 组，组头（`D-develop-GitHub-dsh-session-delete`、`D-develop-GitHub-dsh-novel`）、`relativeTime` 分桶（"刚刚删除 · 22KB"、"删除于 7分钟前 · 350KB"）、两档危险动作（行内安静红 + 页脚唯一一块实心红）全部出得来。**同一张图还证明了「删完面板当场刷新」**——撤销提示「打招呼确认在线状态 已移入回收站」仍在屏上，而那一行已经进了清单（失效通告那条路径此前只由 RTL 用例覆盖，设计稿 §8 门 4 上一段那句"交互那一层没驱动成"就此结掉）。浅色下卡片确实只剩 `border-l4` 一根描边（`bg-base` 与 `bg-layer-2` 浅色同为 `bluish-00`），分组靠组头 + 间距站住，读得下来；**深色下的新版未看**（同一批 token，风险低）。这张图**不覆盖**控制台读数与键盘路径。**归档往返同批复核（2026-10-01，用户真机）**：未归档的删除→恢复后仍是未归档，归档过的删除→恢复后仍在归档态——门 3 那条边界在日常习惯的用法下重认一次（我一度把侧栏两条灰行疑成"取消归档没生效"，实测不是：那是宿主的常态呈现）。

门的判据要能被机器判；跑门取**退出码**而不是管道里的话（`cmd > log 2>&1; echo $?`）。

## 9. 实现前先验的前提（已实测，2026-09-30）

探法：探针跑在**隔离数据根**上——`DSH_HOME=<临时目录> dsh --profile t1probe --from-default-profile web --patch <探针 patch> --no-open --port 0`（宿主 = desktop 0.2.0-rc.2 自带 CLI；探针是一份纯 ESM `probe.mjs`，用 `--patch` 的 `insert` 挂进 profile，跑完即删、不入库）。

- **平台模块表（外壳冻结基线）：成立**。它是外壳 bundle 里 `staticModules` 的实参，**9 个键**：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。我们组件要用的四样里，**React 家族 / primitives / slots 在表内**；**`@deepseek-ai/dsh-client-connection` 不在表内**——它在 asar 里是一条**动态包 row**（自己的 `package.json` 声明 `dsh.client.platform === "web"` 并导出 `./client`），浏览器半对这张冻结表只做**精确键匹配**，未命中的 `dsh.client.external` 请求才会落到 `graphRows.get(<包名>)`（它自己的 row，`<pkg>/client` 与裸包名等价）⇒ 我们的 client bundle 要用 connection，就必须在 `dsh.client.external` 里**逐字**声明它。（**已证的是：「不在 9 键表内」**；「它是动态包 row / 必须走 external 精确请求」由下面 ②③ 两条原文坐实，不再是推断。）证据（全部只读 `app.asar`，取数命令见本条目末）：① 静态表：`dsh-web-frontend/dist/assets/vendor-CCJJTK99.js` 里 `function rM(){return{react:Ef,"react/jsx-runtime":If,"react-dom":Rf,"react-dom/client":Df,"@deepseek-ai/cordis":sf,"@deepseek-ai/dsh-client-store":lh,"@deepseek-ai/dsh-client-ui-slots":hh,"@deepseek-ai/dsh-client-ui-primitives":sE,"@deepseek-ai/dsh-client-ui-dockkit":XS}}`，以及 `this.modules=o.create({boot:n.__DSH_BOOT__,staticModules:rM(),…})`。② connection 的声明与 bundle：`dsh/node_modules/@deepseek-ai/dsh-client-connection/package.json` 原文含 `"exports": { "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" } }` 与 `"dsh": { "client": { "inject": [], "platform": "web", "immediately": true } }`；同包 `lib/client.js` 在 asar 内实存（59411 B）。③ 解析路径（`dsh-client-modules` 两半的原文）：Node 半 `lib/index.js` 只把 `decl.platform === "web"` 的包变成 client row —— `if (decl === void 0 || decl.platform !== "web") { this.pkgMeta.set(sourceKey, null); return null; }`，紧接着缺 `./client` 导出即抛 `client-modules: <pkg> declares dsh.client but exports no "./client" bundle`；同文件 `orderByModuleGraph` 的 JSDoc 是 "An `external` specifier is either the package row it names (`<pkg>/client` aliases the bare package) or a static-table name that adds no graph edge."，实现即 `rowsById.get(name) ?? rowsById.get(stripClientSuffix(name))`。浏览器半 `lib/client.js` 的冻结表就是 `this.seed = new Map(Object.entries(options.staticModules))`（= 上面 9 键），到达循环是 `for (const request of row.external) { const id = stripClientSuffix(request); if (this.seed.has(request) || this.loadCache.has(id)) continue; const dependency = this.graphRows.get(id); if (dependency !== void 0) await this.arriveDependency(row.id, dependency, next, visited); }`；seed 与 row 都没有该名字时抛 `client-modules: require("<spec>") missed the module table — not a platform seed word, not a materialized module, and no registered package factory`。**坑**：把 `app.asar` 里所有 `"@deepseek-ai/*"` 字符串拉出来会得到 312 个包名（含 Node 半），那不是这张表，整串抄进 `PLATFORM_MODULES` 是错的。
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
| 两半之间走**宿主自己的 web server** 上的插件专属前缀路由（`/dsh-session-delete-api`，Node 半四个端点 `GET /list` + `POST /delete|restore|purge`，浏览器半同源 fetch） | ① 官方 typert remote（原方案）；② **不**开通道（只留 Node 半） | ① 原方案的两处硬事实：生成器只认官方仓形（`<root>/packages/<pkg>/` + 源码装饰器 + `src/client.ts` 命名），且浏览器侧没有任何动态发现 ⇒ 第三方只能自挂自（生成物 + `zod` + 搬包布局 + 改客户端逻辑），代价与收益完全不成比例。② 通道跟着**能力归属**走：本插件没有后端、做的全是编排宿主既有能力，所以**借宿主自己的 HTTP 面**而不是另起一个服务；路由层只搬运，真相/账本/判据全留在宿主那边。**信封刻意与官方 unary 面同形**（`{ok:true,value}` / `{ok:false,error:{code,message}}`），错误码仍是 §6 那五个——所以组件面与既有用例一行都不用改。前缀**必须插件专属**：宿主对重复的 `(kind, path)` 直接抛错，撞了整棵插件树 boot 失败；写口另加**同源栅栏**（回环 ∧ Origin/Referer 与 Host 同源；curl 形态放行），免得任意网页用 simple request 打这条本机写口——栅栏挂在**整条前缀路由**上（读口 `list` 也一并拦，客户端探测走的就是它）。**桌面壳那条路单独放行，且必须有**：壳的 `forwardWebRequest` 转发前删掉 `host`/`origin`/`cookie`/`sec-fetch-site` ⇒ 真机请求没有 `Origin`、只有 `Referer: dsh-app://app/`，判据要按 `protocol` + `host` 比（`dsh-app:` 非 special scheme，`URL.origin` 恒为 `"null"`）——漏了它，真机上四个入口一个都不出现，而 headless 直连 http 的过门读数看不出来。 |
| Node 半 `inject` 加 `webServer`（`dsh-host-webserver` 的服务名，逐字读实） | 服务名只写进变量、读时再试探 | 前缀路由是**能力本身**不是可选装饰：服务不在就该响亮失败（插件 pending 一眼可见，好过四个入口静默失踪）。"通道在不在"是**浏览器那半边**的事，由它自己探测（见 §7），两侧各答自己那一问。 |
| 不做自动过期 | 30 天后自动清 | 魔法数字；回收站增长很慢（本机 85 个会话合计 15M） |
| 不做附件回收 | 引用计数 GC | 需要新索引，属另一件事 |
| 首版不做 agent 工具面 | 挂插件专属前缀的工具让 AI 也能删 | YAGNI，要加是一句话的事 |
| live 会话一律拒绝 | 先停下会话再删 | 不替用户终止正在进行的活 |
| 客户端那一行**等宿主确实不再列它**才消失（动词返回 → 如实通告） | **乐观移除**：点下删除就立刻把行摘掉，不等落盘（旧界面稿 ④ 的「交互规则」里写过这条，2026-10-01 随稿删除时记到这里） | 提前摘行要在失败时说假话：搬文件/摘账本任一步失败都要回滚，而用户已经看见"没了"；通告那条路本来就负责表达"宿主不再列它"，两件事不该由一个动画代劳 |

## 11. 待定

- **跟版策略**：建议只声明并验证当前 desktop 发行版（0.2.0-rc.2），跟每个 rc 是另一条路（社区归档插件走的就是那条，代价是逐 rc 跟）。未裁定。
- **原位恢复**要不要（需记账本序号 + `insertSessionBefore`）。
- 实现顺序由 writing-plans 产出。
