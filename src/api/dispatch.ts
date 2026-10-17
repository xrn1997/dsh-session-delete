/**
 * `/dsh-session-delete-api` 前缀路由的**内部分发**（薄线的 Node 半）。
 *
 * 为什么是这一条路（裁决，不是偏好）：浏览器侧 `remote.<namespace>` 只能由**生成的 Typert 远程
 * 描述符贡献**经 `ctx.remote.$mount(...)` 挂上，而盒内那份装配清单是**写死的 25 条官方包**、
 * 全宿主没有任何"按包发现再挂载"的动态机制 ⇒ 第三方要那个命名空间，
 * 只能自挂自（要生成物 + `zod` + 改包布局），代价与收益完全不成比例。改用宿主**自己的 web server**
 * 开一条插件专属前缀路由：真相/账本/判据全在宿主那边，这一层只搬运。
 *
 * 四条口径：
 *  ① **不依赖 Cordis**：`createApiHandler(deps)` 是纯构造器，返回一个 `(req, res) => Promise<void>`
 *     ——所以它能用真 `node:http` server 直接单测（`tests/api.test.ts`），与宿主怎么挂它无关。
 *  ② **信封就是浏览器半消费的那个形状**：`{ok:true,value}` / `{ok:false,error:{code,message,details?}}`。
 *     `error.code` 走 `src/remote/map-error.ts` 的**同一张表**（设计稿 §6 的五个码），原文进
 *     `error.message`，结构化附带物进可选的 `error.details`——浏览器半的 `unwrapRemoteResult` /
 *     `failureOf` 因此一行都不用改。
 *  ③ **HTTP 状态不是第二套语义**：**操作失败**时状态一律 200（含 `ok:false`）——我们与浏览器半之间的
 *     契约是信封本身，判断成败只看 `ok`（同宿主网关"每次 unary 调用 resolve 成 RemoteResult、
 *     不为载体问题 reject"的那条规矩）。**请求本身不对**才用 4xx（400 请求体 / 405 方法 / 404
 *     未知路由），同源栅栏拒的是**请求**而不是操作，回 403；浏览器半先解信封再看状态。
 *  ④ **同源栅栏**：本机回环上一条能删会话的写口不能被任意网页用 simple request CSRF 打——没有栅栏时
 *     `content-type: text/plain` 的跨源 POST 不触发预检、直接生效。放行的形状见 {@link isTrustedRequest}：
 *     同源（浏览器直接打开宿主那行 URL）、桌面壳自己的页面（`dsh-app://app`，真机那条路，见
 *     {@link isDesktopShellUrl}）、或两者皆缺席（curl / 本机工具）。本机既有插件
 *     （`dsh-novel` 的 `api/wire.ts`）只认前两条里的"同源"，本文件多的是桌面壳那一条——**它必须有**：
 *     桌面版的请求被壳摘掉了 `Origin`，漏掉它等于真机上四个入口一个都不出现（而直连 http 的过门
 *     读数看不出来）。
 *  ⑤ **`list` 是"对账 + 读"，且它与写动作按到达序串行**（{@link createApiHandler} 里那条进程内链）：
 *     对账（`reconcileTrash`）与删除/恢复/彻底删除都是"读清单 + 动文件 + 写清单"的多步，交错跑会互相踩
 *     ——删除刚把目录搬进回收站、行还没写上时，对账抢先把这行按目录"重建"出来，再被真实行覆盖成降级
 *     元数据。串行的代价只是排队（单进程单用户，毫秒级）；纯读（`detail`、`ping`、`apply/count`）
 *     不占这条链。
 *  ⑥ **一段 `POST /apply` 管所有写动作**（2026-10-17 批量重构）：旧形状是「一条一段、一次一发」，
 *     批量只能由调用方循环拼出来——100 条 = 100 次往返 ×（一次全量清册读 + 每条一次宿主会话表）。
 *     现在一组 id 一次进、逐条 `ApplyOutcome` 出；单条就是 N=1，仓里不留第二条执行路径。
 *     清空是聚合回执（不按条回），所以单独一段 `POST /empty`。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { toRemoteFailure } from '../remote/map-error.js'
import type { TrashEntry } from '../trash/entry.js'
import { PARAMS, ROUTES, SESSION_DELETE_API_PREFIX, type ApplyAction } from '../shared/wire.js'
import { readTrashDetail } from '../trash/detail.js'
import { reconcileTrash } from '../trash/reconcile.js'
import { applyActions } from '../verbs/apply.js'
import { purgeTrash } from '../verbs/purge-trash.js'
import { routeError } from '../verbs/errors.js'
import type { DeleteDeps } from '../verbs/delete-session.js'

/** 请求体字节上限：这条通道只收几个 id，1MiB 是"够用且不给自己开一条内存放大器"的量级。 */
const JSON_BODY_MAX_BYTES = 1024 * 1024

/** 回环地址的三种写法（IPv4 / IPv6 / IPv4-mapped IPv6）。 */
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1']

/**
 * 桌面壳那条路（asar `/lib/main.js` 的 `forwardWebRequest`）：渲染进程从 `dsh-app://app/` 加载，
 * 页面里对**非静态路径**的请求（`/`、`/index.html`、`/assets/*`、`/plugins/…` 之外的一切——包括
 * 我们这条前缀路由）都由 `protocol.handle("dsh-app")` 转给宿主自己的 web server；转发前它把
 * `host` / `origin` / `cookie` / `sec-fetch-site` 四个头**删掉**、换上一枚宿主自己的 cookie，路径与
 * 查询串原样带走（逐字：`for (const name of ["host","origin","cookie","sec-fetch-site"]) headers.delete(name)`）。
 * ⇒ 桌面版打到我们这条路由上的请求是**没有 `Origin`** 的，`Referer` 则保留（同源请求照常带，
 * 页面就住在 `dsh-app://app/`）。壳自己在上游只放行 `origin ∈ {null, "dsh-app://app"}`。
 */
const DESKTOP_APP_SCHEME = 'dsh-app:'
const DESKTOP_APP_HOST = 'app'

/**
 * 「这是桌面壳自己的页面吗」。**必须按 `protocol` + `host` 判，不能比 `URL.origin`**：`dsh-app:`
 * 不是 WHATWG 的 special scheme，`new URL('dsh-app://app/').origin` 是字符串 `"null"`（Node 实测），
 * 拿它跟字面量比永远为假 ⇒ 栅栏会把真机上的每一次请求都挡成 403，四个入口一个都不出现。
 *
 * 这个判据为什么不可能被外人伪造：`Origin` 与 `Referer` 都是 forbidden header，网页改不了，
 * 只能是浏览器/壳自己带上；而 `dsh-app://app` 只可能是桌面壳自己的页面。
 */
function isDesktopShellUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === DESKTOP_APP_SCHEME && url.host === DESKTOP_APP_HOST
  } catch {
    return false
  }
}

type JsonBody = Record<string, unknown> | null

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function writeOk(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

/** 失败信封：码与原文都来自 `toRemoteFailure`（本插件唯一的错误映射表）。
 *  **状态语义（2026-10-17 错误面对齐）**：**请求本身不对**不再伪装成 200——请求体不对 400、方法不对 405、
 *  未知路由 404、栅栏拒 403（它们不是"一次办成的操作"，是"这条请求不归我办/你没资格办"）。
 *  **操作失败**仍回 200 + 信封（口径 ③ 不变：盘上没有、原目录已不在、会话在跑……都是办完了才知道的结果）。
 *  浏览器半先解信封再看状态，所以 4xx 上带的信封照样读得出原文；`code` 一律折成 `sessiondelete/io`，
 *  那三个路由标签（`bad-request` / `bad-method` / `not-found-route`）是**抛出处给读代码的人看的站点名**，
 *  不许冒充 §6 的五个动词码上客户端。 */
function writeFailure(res: ServerResponse, error: unknown, status?: number): void {
  const carried = (error as { httpStatus?: unknown })?.httpStatus
  writeJson(res, status ?? (typeof carried === 'number' ? carried : 200), { ok: false, error: toRemoteFailure(error) })
}

/**
 * 同源栅栏（见文件头 ④）。看 `origin` 而不只看 `referer` 的理由：恶意页
 * `<meta name="referrer" content="no-referrer">` 能让 Referer 缺席，但浏览器对跨源请求**总是**发 Origin。
 *
 * 放行的三种形状，各自都是"浏览器/壳自动带上、网页改不了"的那种：
 * ① `Origin` 与 `Host` 同源（浏览器直接打开宿主那行 URL）；② `Origin` 是桌面壳的 `dsh-app://app`
 * （壳自己在上游也只放行这个 origin）；③ `Referer` 是桌面壳的 `dsh-app://app`（**真机那条路**：
 * 壳把 `Origin` 删掉了、只留下 Referer，见 {@link isDesktopShellUrl}）。两者都缺席 = 本机工具 /
 * curl（注释即此承诺）。**恶意网页拿不到 ②③ 里的任何一个**：那两个头都是 forbidden header、
 * 页面伪造不了；而**写口（POST）在任何跨源形态下都必带 Origin** ⇒ 两个头全缺席就等于本机工具。
 * 唯一的缝是跨源 `no-cors` 的 **GET**（Referer 被 `no-referrer` 掐掉、Origin 也不带）——它只够得到
 * 只读的 `list`，而 no-cors 的回包是 opaque、页面读不出内容 ⇒ 不构成泄露。
 */
function isTrustedRequest(req: IncomingMessage): boolean {
  if (!LOOPBACK.includes(req.socket.remoteAddress ?? '')) return false
  const host = req.headers.host
  const origin = req.headers.origin
  if (origin !== undefined && !isDesktopShellUrl(origin)) {
    try { if (new URL(origin).host !== host) return false } catch { return false }
  }
  const referer = req.headers.referer
  if (referer === undefined) return true
  if (isDesktopShellUrl(referer)) return true
  try { return new URL(referer).host === host } catch { return false }
}

/** 流式读 body 并解析成 JSON 对象：空体回 `null`，超限 / 非法 JSON / 不是对象一律抛（→ 400 + 失败信封）。
 *  **请求本身不对**（400）与**那次操作读不到东西**（200 + 信封）是两件事：前者是调用方没组好请求，
 *  后者是盘上没有；把前者也写成 200，代理与日志里就再也分不出这两类。 */
async function readJsonBody(req: IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buf.length
    if (size > JSON_BODY_MAX_BYTES) throw routeError('bad-request', 400, `请求体超过 ${JSON_BODY_MAX_BYTES} 字节上限`)
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw routeError('bad-request', 400, '请求体需为 JSON 对象')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw routeError('bad-request', 400, `请求体不是合法 JSON：${error.message}`)
    }
    throw error
  }
}

/** 必填的非空字符串字段（缺、空串、类型不对都是**同一句话**：说清是哪个字段）。 */
function requireString(body: JsonBody, field: string): string {
  const value = body?.[field]
  if (typeof value !== 'string' || value === '') {
    throw routeError('bad-request', 400, `请求体需带非空字符串字段 ${field}`)
  }
  return value
}

/** `/apply` 的动作：认不得的一律点名拒掉，不折成"空批量"糊弄过去。 */
const APPLY_ACTIONS: readonly ApplyAction[] = ['delete', 'restore', 'purge', 'count']
function requireAction(body: JsonBody): ApplyAction {
  const value = body?.[PARAMS.action]
  if (typeof value !== 'string' || !(APPLY_ACTIONS as readonly string[]).includes(value)) {
    throw routeError('bad-request', 400, `批量动作不认识：需是 ${APPLY_ACTIONS.join(' / ')} 之一`)
  }
  return value as ApplyAction
}

/** `/apply` 的 id 组：必须是非空字符串数组（空数组不是"什么都不做"，是调用方自己没组好）。 */
function requireIdArray(body: JsonBody): string[] {
  const value = body?.[PARAMS.ids]
  if (!Array.isArray(value) || value.length === 0 || value.some(id => typeof id !== 'string' || id === '')) {
    throw routeError('bad-request', 400, `请求体需带 ${PARAMS.ids}：非空字符串组成的非空数组`)
  }
  return value as string[]
}

function requireMethod(method: string, want: string, route: string): void {
  if (method !== want) throw routeError('bad-method', 405, `方法不允许：${method}（${SESSION_DELETE_API_PREFIX}${route} 需 ${want}）`)
}

/** 清单交回浏览器的那一行：清册那一行 + 组视图的只读数。 */
export interface TrashRow extends TrashEntry {
  /** 跟着这条父会话一起进回收站的孩子数（来源：清册里 `parentEntryId` 指向它的行）。 */
  readonly subagentCount?: number
  /** 那些孩子的字节合计（页脚的合计要算得上它们，不能只加父自己那一格）。 */
  readonly subagentBytes?: number
  /** **盘上还留着、没被带走**的孩子数（来源：宿主 `sessionQuery`）。级联落地前删掉的那些存量才非零；
   *  与 `subagentCount` 是两件事，界面上必须各说各的（不许用一个冒充另一个）。 */
  readonly strandedSubagents?: number
  /** 删除时记下的工作区**已经不在账本里**（宿主的「删除工作区」只删注册、保留日志）。恢复会照常
   *  回盘、归入「未分组」——界面上点之前就得知道，别等它从清单里消失才发现换了地方。
   *  缺席 = 工作区还在 / 没有工作区可判（与上面三个只读数同一条"不拿缺席冒充否"的规矩）。 */
  readonly workspaceMissing?: boolean
}

/**
 * 把清册的全部行装配成「一行 = 一组」：孩子折进父那一行、不单独列（宿主的客户端本来就藏孩子，
 * 我们若单列就会冒出一堆点不到的行）；父行不在时孩子自己站出来占一行，否则它既看不见也清不掉。
 * 四个只读数只加在这次回信上，**不落清册**——清册该记的是
 * 文件里真有的事实，而"还剩几个孩子""工作区还在不在"是随盘上随时变的一个数。取数失败照抛（响亮失败，不端一份
 * 少了这栏的清单当没事发生）。
 */
async function assembleTrashRows(deps: DeleteDeps, rows: readonly TrashEntry[]): Promise<TrashRow[]> {
  // 「折进谁」与「谁露面」由**同一条判据**算出：**接得住孩子的只有根行**（自己不记 `parentEntryId`
  // 的那一行）。折进一条同样有父的行 = 把它挂在一个已经藏起来的组上，那一行既自己占一格、又被算进
  // 别人那一格的字节里，页脚合计就会数两遍。
  const byId = new Map(rows.map(row => [row.id, row]))
  const foldedInto = new Map<string, string>()
  const kidsByParent = new Map<string, TrashEntry[]>()
  for (const row of rows) {
    if (row.parentEntryId === undefined) continue
    const parent = byId.get(row.parentEntryId)
    if (parent === undefined || parent.parentEntryId !== undefined) continue
    foldedInto.set(row.id, parent.id)
    const siblings = kidsByParent.get(parent.id)
    if (siblings === undefined) kidsByParent.set(parent.id, [row])
    else siblings.push(row)
  }

  const visible = rows.filter(row => !foldedInto.has(row.id))
  // 两个取数面各管各的：`subagentCounts` 是宿主 `sessionQuery` 的批量口（一处调用），
  // `workspaceExists` 是账本 Map 的逐行只读判别（空串是「未分组」，没有工作区可问）。
  const [stranded, workspaceMissing] = await Promise.all([
    deps.host.subagentCounts(visible.map(row => row.sessionId)),
    Promise.all(visible.map(async row =>
      row.workspaceId === '' ? false : !(await deps.host.workspaceExists(row.workspaceId)))),
  ])
  return visible.map((row, index) => {
    const kids = kidsByParent.get(row.id)
    const left = stranded[row.sessionId]
    const missing = workspaceMissing[index] === true
    if (kids === undefined && left === undefined && !missing) return row
    return {
      ...row,
      ...(kids === undefined ? {} : {
        subagentCount: kids.length,
        subagentBytes: kids.reduce((total, kid) => total + kid.sizeBytes, 0),
      }),
      ...(left === undefined ? {} : { strandedSubagents: left }),
      ...(missing ? { workspaceMissing: true } : {}),
    }
  })
}

/** 路由表：段名 → 一个把「方法 + 预读好的请求体」变成返回值的处理器。动词在每次调用时才取。
 *  `body` 由 {@link purityOf} 读一次交下来——同一条请求的流不能被消费两遍。 */
async function dispatch(method: string, rest: string, body: JsonBody, deps: DeleteDeps): Promise<unknown> {
  if (rest === ROUTES.list) {
    requireMethod(method, 'GET', ROUTES.list)
    // 「读清单」=「对账 + 读」：清单以 `session-trash/` 里的目录为准修回一致（口径见 `reconcile.ts`）
    const rows = await reconcileTrash(deps)
    return assembleTrashRows(deps, rows)
  }
  if (rest === ROUTES.ping) {
    requireMethod(method, 'GET', ROUTES.ping)
    // 客户端探测专用的最便宜一问：不碰清册、不碰盘、不进链。它的**信封**就是答案（"路由在、
    // 依赖接上了、映射生效了"），不是清单里此刻有几条——那是 `/list` 的事，拿它当健康检查
    // 等于每次页面加载都跑一遍对账（2026-10-17 第四批改掉的就是这个）。
    return 'pong'
  }
  if (rest === ROUTES.apply) {
    requireMethod(method, 'POST', ROUTES.apply)
    // 一组 id 上的同一个动作（2026-10-17 批量重构）：单条就是长度为 1 的批量，逐条回结果。
    return await applyActions(deps, requireAction(body), requireIdArray(body))
  }
  if (rest === ROUTES.empty) {
    requireMethod(method, 'POST', ROUTES.empty)
    // 清空回收站：聚合回执，不按条回——这是它与 `/apply` 唯一的区别，也是它单独一段的理由。
    return await purgeTrash(deps)()
  }
  if (rest === ROUTES.detail) {
    requireMethod(method, 'POST', ROUTES.detail)
    // 读单条详情也走 POST：`requireString`、同源栅栏、错误映射这一整套都挂在 POST 支上，
    // 改成 GET query 只是把同一道栅栏再写一遍（裁决见 2026-10-15 设计稿 §3）
    return await readTrashDetail(deps)(requireString(body, PARAMS.entryId))
  }
  throw routeError('not-found-route', 404, `未知路由：${method} ${rest === '' ? SESSION_DELETE_API_PREFIX : rest}`)
}

/** 纯读的支路：`ping`、`detail` 与 `apply` 里的 `count`——一次探测、一次大正文读或一个只读数不该把
 *  写按钮堵在身后。body 在这里**只读一次**（读完交给下游复用，流不能消费两遍），所以判断必须发生在
 *  `dispatch` 之前。 */
interface Purity { readonly pure: boolean; readonly body: JsonBody }

async function purityOf(req: IncomingMessage, rest: string): Promise<Purity> {
  if (rest === ROUTES.ping) return { pure: true, body: null }
  if (rest === ROUTES.detail) return { pure: true, body: await readJsonBody(req) }
  if (rest !== ROUTES.apply) return { pure: false, body: null }
  const body = await readJsonBody(req)
  // `count` 不碰清册也不动文件（它问的是**还在盘上**的会话），和详情一样走豁免；
  // 其余三个动作都动清单，必须排在链上。
  return { pure: body?.[PARAMS.action] === 'count', body }
}
export function createApiHandler(deps: DeleteDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  /**
   * 到达序串行链（文件头 ⑤）：`list`（含对账）与三个写动词一个跑完再放下一个。`tail` 由构造保证
   * **永不 reject**（每个任务自己的失败留在交回给那次请求的那个 promise 上），所以一次失败不会卡死链。
   */
  let tail: Promise<void> = Promise.resolve()
  const throughChain = <T>(task: () => Promise<T>): Promise<T> => {
    const started = tail.then(task)
    tail = started.then(() => undefined, () => undefined)
    return started
  }
  return async function handle(req, res): Promise<void> {
    if (!isTrustedRequest(req)) {
      writeFailure(res, new Error('非受信来源'), 403)
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      if (!url.pathname.startsWith(SESSION_DELETE_API_PREFIX)) {
        throw routeError('not-found-route', 404, `未知路由：${url.pathname}`)
      }
      const rest = url.pathname.slice(SESSION_DELETE_API_PREFIX.length)
      // body 在这里读一次（`apply` 的纯读判断与分发共用这一份；其余段读到的是 `null`，各支自己不看它）
      const { pure, body } = await purityOf(req, rest)
      const task = (): Promise<unknown> => dispatch(req.method ?? 'GET', rest, body, deps)
      // `ping`、详情、以及 `apply` 里那个 `count` 不排队：别让一次探测、大正文读或只读数
      // 把删除按钮堵在身后。其余（`list` 对账、三个写动作）一律按到达序上链。
      writeOk(res, await (pure ? task() : throughChain(task)))
    } catch (error) {
      writeFailure(res, error)
    }
  }
}
