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
 *  ② **信封就是浏览器半消费的那个形状**：`{ok:true,value}` / `{ok:false,error:{code,message}}`。
 *     `error.code` 走 `src/remote/map-error.ts` 的**同一张表**（设计稿 §6 的五个码），原文进
 *     `error.message`——浏览器半的 `unwrapRemoteResult` / `failureOf` 因此一行都不用改。
 *  ③ **HTTP 状态不是第二套语义**：信封在场时状态一律 200（含 `ok:false`）——我们与浏览器半之间的
 *     契约是信封本身，判断成败只看 `ok`（同宿主网关"每次 unary 调用 resolve 成 RemoteResult、
 *     不为载体问题 reject"的那条规矩）。唯一的例外是同源栅栏：拒的是**请求**而不是操作，回 403。
 *  ④ **同源栅栏**：本机回环上一条能删会话的写口不能被任意网页用 simple request CSRF 打——没有栅栏时
 *     `content-type: text/plain` 的跨源 POST 不触发预检、直接生效。放行的形状见 {@link isTrustedRequest}：
 *     同源（浏览器直接打开宿主那行 URL）、桌面壳自己的页面（`dsh-app://app`，真机那条路，见
 *     {@link isDesktopShellUrl}）、或两者皆缺席（curl / 本机工具）。本机既有插件
 *     （`dsh-novel` 的 `api/wire.ts`）只认前两条里的"同源"，本文件多的是桌面壳那一条——**它必须有**：
 *     桌面版的请求被壳摘掉了 `Origin`，漏掉它等于真机上四个入口一个都不出现（而直连 http 的过门
 *     读数看不出来）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { toRemoteFailure } from '../remote/map-error.js'
import { PARAMS, ROUTES, SESSION_DELETE_API_PREFIX } from '../shared/wire.js'
import { deleteSession, type DeleteDeps } from '../verbs/delete-session.js'
import { purgeTrash } from '../verbs/purge-trash.js'
import { restoreSession } from '../verbs/restore-session.js'

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

/** 失败信封：码与原文都来自 `toRemoteFailure`（本插件唯一的错误映射表），值就是线上形状本身。 */
function writeFailure(res: ServerResponse, error: unknown, status = 200): void {
  writeJson(res, status, { ok: false, error: toRemoteFailure(error) })
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

/** 流式读 body 并解析成 JSON 对象：空体回 `null`，超限 / 非法 JSON / 不是对象一律抛（→ 失败信封）。 */
async function readJsonBody(req: IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buf.length
    if (size > JSON_BODY_MAX_BYTES) throw new Error(`请求体超过 ${JSON_BODY_MAX_BYTES} 字节上限`)
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('请求体需为 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

/** 必填的非空字符串字段（缺、空串、类型不对都是**同一句话**：说清是哪个字段）。 */
function requireString(body: JsonBody, field: string): string {
  const value = body?.[field]
  if (typeof value !== 'string' || value === '') throw new Error(`请求体需带非空字符串字段 ${field}`)
  return value
}

/** `purge` 的 `entryId` 可选（缺席 = 清空），但在场就必须是像样的值——不把 `42` 当成"没带"。 */
function optionalString(body: JsonBody, field: string): string | undefined {
  const value = body?.[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '') throw new Error(`字段 ${field} 若在场必须是非空字符串`)
  return value
}

function requireMethod(method: string, want: string, route: string): void {
  if (method !== want) throw new Error(`方法不允许：${method}（${SESSION_DELETE_API_PREFIX}${route} 需 ${want}）`)
}

/** 路由表：段名 → 一个把「方法 + 请求体」变成返回值的处理器。动词在每次调用时才取。 */
async function dispatch(method: string, rest: string, req: IncomingMessage, deps: DeleteDeps): Promise<unknown> {
  if (rest === ROUTES.list) {
    requireMethod(method, 'GET', ROUTES.list)
    return await deps.manifest.list()
  }
  if (rest === ROUTES.delete) {
    requireMethod(method, 'POST', ROUTES.delete)
    return await deleteSession(deps)(requireString(await readJsonBody(req), PARAMS.sessionId))
  }
  if (rest === ROUTES.restore) {
    requireMethod(method, 'POST', ROUTES.restore)
    return await restoreSession(deps)(requireString(await readJsonBody(req), PARAMS.entryId))
  }
  if (rest === ROUTES.purge) {
    requireMethod(method, 'POST', ROUTES.purge)
    return await purgeTrash(deps)(optionalString(await readJsonBody(req), PARAMS.entryId))
  }
  throw new Error(`未知路由：${method} ${rest === '' ? SESSION_DELETE_API_PREFIX : rest}`)
}

/** 宿主 `webServer.register({kind:'prefix', path: SESSION_DELETE_API_PREFIX, handler})` 的那个 handler。 */
export function createApiHandler(deps: DeleteDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async function handle(req, res): Promise<void> {
    if (!isTrustedRequest(req)) {
      writeFailure(res, new Error('非受信来源'), 403)
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      if (!url.pathname.startsWith(SESSION_DELETE_API_PREFIX)) {
        throw new Error(`未知路由：${url.pathname}`)
      }
      writeOk(res, await dispatch(req.method ?? 'GET', url.pathname.slice(SESSION_DELETE_API_PREFIX.length), req, deps))
    } catch (error) {
      writeFailure(res, error)
    }
  }
}
