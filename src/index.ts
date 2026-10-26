import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { createApiHandler } from './api/dispatch.js'
import { createFsPort } from './ports/fs-port.js'
import { createHostPort } from './ports/host-port.js'
import { resolveHome } from './ports/home.js'
import { createTrashLedger } from './trash/ledger.js'
import { createHostStorageManifest } from './trash/storage-manifest.js'
import type { DeleteDeps } from './deps.js'
import { createMemberPresence } from './verbs/member-presence.js'
import { SESSION_DELETE_API_PREFIX } from './shared/wire.js'

export const name = '@xrn1997/dsh-session-delete'

/**
 * 插件依赖：**只写字符串数组**（隔离数据根上实测：写成 `{ required, optional }` 会让插件停在
 * `pending (waiting for services: required, optional)`）。
 *
 * 三项都是在隔离数据根上实测注入成功、且本插件真正用到的宿主服务。**不进 inject 的**：
 * - `remote`：那是**浏览器半**的服务（asar `dsh-api-gateway/lib/client.js`：`super(ctx, "remote")`），
 *   Node 半挂的是 `ctx.typertGateway`。把它写进 Node 半的 inject 会让插件永远 pending（同 `slots` 那次的形状）。
 * - `sessions` / `sessionProjectionCache`：两者都按 `ctx.get(...)` **可选读**——`sessions` 只给 `evictLive`
 *   用（活跃判据走 waterfall，见 src/ports/host-port.ts；服务缺席回 `unknown`），`sessionProjectionCache` 是标题的尽力读面。
 *   inject 一个可能没挂的服务 = 整个插件 pending。
 *   它取不到时 `titleOf` 返回空串，正是契约允许的降级。
 * - `agents`：只给 handle 捕获用（`ctx.get('agents')`；缺席时 `ctx.inject(['agents'])` 等服务就绪再装）。
 *   它同样可能晚于本插件激活，写进插件 inject 只会让整个插件 pending。
 *
 * `webServer` 是**浏览器半取数通道的承载者**（那条薄线）：插件用它注册 `/dsh-session-delete-api`
 * 前缀路由，浏览器半同源 fetch 那六个段名。它是宿主 web 组成里的硬依赖（`dsh-host-webserver` 的
 * `super(ctx, "webServer")`），服务名与 `register({kind:'prefix', path, handler})` 的形状按
 * `dsh-host-webserver/lib/index.js` 与 `README.md` 原文读实，不是猜的。
 *
 * 清册的三层各有各的家：raw 绑定 `src/trash/storage-manifest.ts`、读面（对账 + 读）`src/trash/ledger.ts`、
 * 数据根 `src/ports/home.ts`。这里只把它们接起来，任何一层都不在组合根里长判据。
 */
export const inject = ['workspaceRegistry', 'storageDomain', 'webServer']

/* ------------------------------------------------------------------ *
 * 装配
 * ------------------------------------------------------------------ */

/** 宿主 web server 的窄镜像（只声明用到的那一个成员 + 一次强转；不装宿主类型包）。 */
interface WebServerLike {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/**
 * 装配顺序：**清单 → 端口 → 在场能力 → 动词依赖 → 前缀路由**（`DeleteDeps` 把这些依赖面合成一颗）。
 *
 * 路由用 `ctx.effect` 挂、disposer 归装载它的那根 fiber：插件卸载即摘路由（`register` 返回的
 * disposer 是官方契约）。**同一进程里只注册一次**这件事由宿主把住：重复的 `(kind, path)`
 * 在 `register` 里直接抛（`webserver: duplicate prefix route "…"`），响亮失败而不是悄悄覆盖。
 */
export function apply(ctx: Context): void {
  const fs = createFsPort()
  const home = resolveHome()
  const rawManifest = createHostStorageManifest(ctx)
  const host = createHostPort(ctx)
  const deps: DeleteDeps = {
    fs,
    host,
    ledger: createTrashLedger(rawManifest, fs, home),
    home,
    presence: createMemberPresence(host),
    now: () => Date.now(),
  }
  const webServer = (ctx as unknown as { webServer: WebServerLike }).webServer
  ctx.effect(() => {
    const dispose = webServer.register({
      kind: 'prefix',
      path: SESSION_DELETE_API_PREFIX,
      handler: createApiHandler(deps),
    })
    return () => { dispose() }
  }, 'session-delete: /dsh-session-delete-api routes')
}
