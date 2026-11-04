import type { Context } from '@deepseek-ai/cordis'
import { createDispatcher } from './api/dispatch.js'
import { registerConnectionRoutes, type ConnectionFetchServiceLike } from './api/connection-route.js'
import { Config, normalizeConfig } from './config.js'
import { createAttachmentsPort } from './ports/attachments-port.js'
import { createFsPort } from './ports/fs-port.js'
import { createHostPort } from './ports/host-port.js'
import { resolveHome } from './ports/home.js'
import { createTrashLedger } from './trash/ledger.js'
import { createHostStorageManifest } from './trash/storage-manifest.js'
import type { DeleteDeps } from './deps.js'
import { createMemberPresence } from './verbs/member-presence.js'

export const name = '@xrn1997/dsh-session-delete'

/** 可调项的 Config（Standard Schema）；为什么不用宿主 schema 库见 ADR-0037。 */
export { Config }

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
 * `connection` 是浏览器半取数通道的唯一承载者：九段注册到 `connection.fetch.register` 的
 * `/api/dsh-session-delete-api/*`，Host/Origin/浏览器认证由宿主 `/api` bridge 完成（ADR-0033）。
 * 支持面是 web UI 与桌面端，二者的标准组合都装 `client-connection`；服务缺席时插件停在 pending
 * ——可见的激活失败，而不是静默地没有入口。`webServer` 不再直接使用：exact route 仍由宿主的
 * `connection` 挂在其 `/api` 前缀上，插件不需要自己碰物理服务器。
 *
 * 清册的三层各有各的家：raw 绑定 `src/trash/storage-manifest.ts`、读面（对账 + 读）`src/trash/ledger.ts`、
 * 数据根 `src/ports/home.ts`。这里只把它们接起来，任何一层都不在组合根里长判据。
 */
export const inject = ['workspaceRegistry', 'storageDomain', 'connection']

/* ------------------------------------------------------------------ *
 * 装配
 * ------------------------------------------------------------------ */

/**
 * 装配顺序：**配置归一 → 清单 → 端口 → 在场能力 → 动词依赖 → 分发器 → exact Fetch 路由**
 * （`DeleteDeps` 把这些依赖面合成一颗；`config` 是归一后的只读快照）。
 *
 * 路由用 `ctx.effect` 挂、disposer 归装载它的那根 fiber：插件卸载即摘路由（`register` 返回的
 * disposer 是官方契约）。**同一进程里只注册一次**这件事由宿主把住：重复的 `(path, method)`
 * 在 `connection.fetch.register` 里直接抛，响亮失败而不是悄悄覆盖。
 */
export function apply(ctx: Context, rawConfig?: unknown): void {
  // 归一放在装配第一步：坏配置在碰宿主之前就响亮失败，不拿半套配置启动。
  const config = normalizeConfig(rawConfig)
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
    config,
    attachments: createAttachmentsPort(ctx),
    now: () => Date.now(),
  }
  const connection = ctx.get('connection') as ConnectionFetchServiceLike | undefined
  // `inject` 保证 apply 只在 connection 就绪后跑；这里仍判一次，把"服务被摘走"变成响亮错误，
  // 而不是静默注册零条路由（插件看起来在、所有动作 404）。
  if (connection === undefined) throw new Error('session-delete: connection 服务缺席')
  const dispatch = createDispatcher(deps)
  ctx.effect(() => {
    const dispose = registerConnectionRoutes(connection, dispatch)
    return () => dispose()
  }, 'session-delete: /api exact Fetch routes')
}
