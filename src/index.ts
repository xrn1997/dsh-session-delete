/** 只用于类型面：`@deepseek-ai/cordis` 留在 devDependencies，不是 peer、也不在运行期加载。 */
import type { Context } from '@deepseek-ai/cordis'
import { createDispatcher } from './api/dispatch.js'
import { registerConnectionRoutes, type ConnectionFetchServiceLike } from './api/connection-route.js'
import { Config, normalizeConfig } from './config.js'
import type { ConfigEditorLike, DeleteDeps } from './deps.js'
import { createAttachmentsPort } from './ports/attachments-port.js'
import { createFsPort } from './ports/fs-port.js'
import { createHostPort } from './ports/host-port.js'
import { resolveHome } from './ports/home.js'
import { createTrashLedger } from './trash/ledger.js'
import { createHostStorageManifest } from './trash/storage-manifest.js'
import { createMemberPresence } from './verbs/member-presence.js'

export const name = '@xrn1997/dsh-session-delete'

/** 可调项的 Config（Standard Schema）；为什么不用宿主 schema 库见 ADR-0037。 */
export { Config }

/**
 * 插件依赖：**只写字符串数组**（写成 `{ required, optional }` 会让插件停在 pending）。
 * 三项都是实测注入成功、且真正用到的宿主服务。**不进 inject 的**：`remote` 是浏览器半的服务
 * （asar `dsh-api-gateway/lib/client.js` 的 `super(ctx, "remote")`），Node 半挂的是 `ctx.typertGateway`；
 * `sessions` / `sessionProjectionCache` / `sessionPersistence` 按 `ctx.get(...)` 可选读
 * （inject 一个可能没挂的服务 = 整个插件 pending）；`agents` 同样可能迟到，缺席时用 `ctx.inject` 等。
 * `connection` 是取数通道的唯一承载者，缺席时插件停在 pending——可见的激活失败，而不是没有入口。
 */
export const inject = ['workspaceRegistry', 'storageDomain', 'connection']

/* ------------------------------------------------------------------ *
 * 装配
 * ------------------------------------------------------------------ */

/** 装配顺序：配置归一 → 清单 → 端口 → 在场能力 → 动词依赖 → 分发器 → exact Fetch 路由。
 *  路由用 `ctx.effect` 挂、disposer 归 fiber；重复 `(path, method)` 由宿主的 register 直接抛。 */
export function apply(ctx: Context, rawConfig?: unknown): void {
  // 归一放在装配第一步：坏配置在碰宿主之前就响亮失败，不拿半套配置启动。
  const config = normalizeConfig(rawConfig)
  const fs = createFsPort()
  const home = resolveHome()
  const rawManifest = createHostStorageManifest(ctx)
  const host = createHostPort(ctx)
  // `/config` 的写支：`configEditor` 可选读——不是标准组合必有；缺席时写支回 io，不让插件 pending。
  const configEditor = ctx.get('configEditor') as ConfigEditorLike | undefined
  // 要的是 Loader entry：`ctx.fiber.entry` 由 Loader 挂上，Cordis 类型里没有，按窄形状取一次。
  const entry = (ctx as { readonly fiber?: { readonly entry?: unknown } }).fiber?.entry
  const deps: DeleteDeps = {
    fs,
    host,
    ledger: createTrashLedger(rawManifest, fs, home),
    home,
    presence: createMemberPresence(host),
    config,
    attachments: createAttachmentsPort(ctx),
    now: () => Date.now(),
    ...(configEditor === undefined ? {} : { configEditor }),
    ...(entry === undefined ? {} : { entry }),
  }
  const connection = ctx.get('connection') as ConnectionFetchServiceLike | undefined
  // `inject` 已保证就绪；再判一次把「服务被摘走」变成响亮错误，而不是静默注册零条路由。
  if (connection === undefined) throw new Error('session-delete: connection 服务缺席')
  const dispatch = createDispatcher(deps)
  ctx.effect(() => {
    const dispose = registerConnectionRoutes(connection, dispatch)
    return () => dispose()
  }, 'session-delete: /api exact Fetch routes')
}
