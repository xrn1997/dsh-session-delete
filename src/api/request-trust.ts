/**
 * 请求栅栏：判一条打到 `/dsh-session-delete-api` 的请求归不归本插件办。
 *
 * 两件事分开：**归属**（Host / Origin / Referer 是不是本次部署自己的）与**身份**（远程客户端是不是
 * 宿主的已认证 Web 客户端）。绑定策略归宿主 webserver 配置——它只接受具体接口 IP 字面量、拒绝
 * wildcard——所以「谁能到达」不是本插件能替它决定的事；栅栏本身只防 browser confused deputy，
 * 身份留给宿主（见 ②）。口径与宿主 `/api` 的 `isTrustedApiRequest`（asar
 * `dsh-client-connection/lib/index.js`）对齐，差别只有一条：本模块多查 Referer，因为
 * `GET /attachment` 是二进制段（见末段）。
 *
 * 两条放行支，外加一条缺席规则：
 * ① 头栅栏全过 ∧ 源地址回环 ∧ Host 属于本次部署（回环名 / 监听 bind 字面量）——本机工具与转发落在
 *    回环的桌面壳；
 * ② 宿主 `connection` 服务的 `requestRejection` 放行——远程浏览器。它自带宿主的 Host 白名单
 *    （含部署声明的 `trustedHosts`）与「已认证 live peer」，身份就是那次 `dsh web` 打印的 URL 换来的
 *    签名 cookie，不在本插件里复刻；
 * ③ 身份层缺席（`src/ports/connection-port.ts` 报 `absent`，宿主无 `connection` 服务或成员改名）
 *    ⇒ 远程一律拒（fail-closed：退回「只有本机」，LAN 上表现为 403 而不是静默放行）。
 *
 * **DNS rebinding 由 Host 归属判据挡**：`Origin === Host` 只证两者同名，不证这个名字属于本部署；
 * 回环 socket 也不构成豁免（重绑到 `127.0.0.1` 的攻击正是回环源地址）。对浏览器来说 Host 是重绑伪造
 * 不了的那个头——它按连接目标填，而 `Origin` 是页面自己的名字——所以归属判定先于任何本机 / 远程
 * 分支，别在它前面加 fast-path。
 *
 * 末段：`GET /attachment` 的响应不是 opaque 的「读不出内容」——页面若已知某个 `sha256:…` 内容哈希，
 * 就能把它当 `<img src>` 跨源渲染出来。那条请求不带 Origin，靠 Referer 判同源挡；宿主 `/api` 没有
 * 二进制段，所以它的栅栏不需要这一条。
 */
import type { IncomingMessage } from 'node:http'
import type { ConnectionPort } from '../ports/connection-port.js'

/** 桌面壳那条路（asar `/lib/main.js` 的 `forwardWebRequest`）：渲染进程从 `dsh-app://app/` 加载，
 *  转发前把 `host` / `origin` / `cookie` / `sec-fetch-site` 删掉、换上一枚宿主自己的 cookie，
 *  `Referer` 保留。判据按 `protocol` + `host` 比，**不能比 `URL.origin`**（`dsh-app:` 不是 WHATWG
 *  special scheme，`new URL('dsh-app://app/').origin` 是字符串 `"null"`）。 */
const DESKTOP_APP_SCHEME = 'dsh-app:'
const DESKTOP_APP_HOST = 'app'

/** 回环 socket 的三种写法（IPv4 / IPv6 / IPv4-mapped IPv6）。 */
const LOOPBACK_SOCKETS = ['127.0.0.1', '::1', '::ffff:127.0.0.1']

export type RequestTrustVerdict = 'allowed' | 'untrusted' | 'unauthenticated'

export interface RequestTrustFacts {
  /** 监听器绑定的那个具体接口 IP 字面量；老代次没有这个 getter 时为 `undefined`（bind 支退化，仍 fail-closed）。 */
  readonly bindHost: string | undefined
  /** 宿主的 Web 身份面；端口每次请求惰性解析服务，缺席由它报 `absent`。 */
  readonly connection: ConnectionPort
}

function isDesktopShellUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === DESKTOP_APP_SCHEME && url.host === DESKTOP_APP_HOST
  } catch {
    return false
  }
}

/** 裸 authority（`host` / `host:port`）按给定 scheme 解析；解析不了回 `undefined`。 */
function parseAuthority(authority: string, scheme = 'http:'): URL | undefined {
  try {
    return new URL(`${scheme}//${authority}`)
  } catch {
    return undefined
  }
}

/** 与宿主 `isLoopbackHostname` 同口径：`localhost`、`[::1]`、任意 127/8。 */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Host 是不是本部署的 bind 字面量：忽略端口与 `%zone`（zone 是接口选择器，不是地址文本）。 */
function isBindAddress(hostUrl: URL, bindHost: string | undefined): boolean {
  if (bindHost === undefined) return false
  const zoneAt = bindHost.indexOf('%')
  const address = zoneAt === -1 ? bindHost : bindHost.slice(0, zoneAt)
  const bindUrl = parseAuthority(address.includes(':') ? `[${address}]` : address)
  return bindUrl !== undefined && bindUrl.hostname === hostUrl.hostname
}

/** 携带 authority 的头（Origin / Referer）是否与 Host 同 authority：按这个头自己的 scheme 归一
 *  默认端口（`http://x:80` 与 Host `x` 是同一个 authority）。 */
function isSameAuthority(value: string, hostHeader: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  const scheme = url.protocol === 'https:' ? 'https:' : url.protocol === 'http:' ? 'http:' : undefined
  if (scheme === undefined) return false
  const hostUrl = parseAuthority(hostHeader, scheme)
  return hostUrl !== undefined && url.host === hostUrl.host
}

/** 头栅栏：`sec-fetch-site` / Origin / Referer 三条，任何客户端都要过。 */
function passesHeaderFence(headers: IncomingMessage['headers'], host: string): boolean {
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (origin !== undefined && !isDesktopShellUrl(origin) && !isSameAuthority(origin, host)) return false
  const referer = headers.referer
  if (referer !== undefined && !isDesktopShellUrl(referer) && !isSameAuthority(referer, host)) return false
  return true
}

/**
 * 这条请求归不归本插件办。`untrusted` = 归属不对（跨源 / 重绑 / 头不成形）；`unauthenticated` =
 * 归属对但远程客户端没带宿主身份（原文会提示用 `dsh web` 打印的 URL 打开）。
 *
 * 远程支的两个失败裁决由端口翻译宿主的区分（401 = 缺身份、403 = 归属不对）。身份层缺席（端口报
 * `absent`）一律按归属不对处理：那时没有可换的身份，不能让原文提示用户去补一个不存在的东西。
 */
export function judgeRequest(req: IncomingMessage, facts: RequestTrustFacts): RequestTrustVerdict {
  const host = req.headers.host
  if (host === undefined || !passesHeaderFence(req.headers, host)) return 'untrusted'
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return 'untrusted'
  const ours = isLoopbackHostname(hostUrl.hostname) || isBindAddress(hostUrl, facts.bindHost)
  if (ours && LOOPBACK_SOCKETS.includes(req.socket.remoteAddress ?? '')) return 'allowed'
  const verdict = facts.connection.verdictFor(req)
  if (verdict.kind === 'allowed') return 'allowed'
  return verdict.kind === 'unauthenticated' ? 'unauthenticated' : 'untrusted'
}
