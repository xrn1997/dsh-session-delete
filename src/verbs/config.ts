/**
 * `/config` 的读/写动词：三只可调项的当前值与写回。
 *
 * 读是免费快照（`apply` 归一后的那一份），写才碰宿主：
 * - 先按 `src/config.ts` 的 `normalizeConfig` 校验（未知键 / 非整数 / 越界回 400，不拿半套值写盘）；
 * - 再走宿主 `configEditor.edit(entry, change)`：完整 raw config 落进 profile 的 patch 层，
 *   由编辑器串行化、校验并让这一行重启（字段不是 volatile，重启是它给的语义）。
 * - `configEditor` / `entry` 缺席（老宿主、嵌套上下文）回 `io` 并在原文里说清替代路径——
 *   不静默假装保存成功。
 *
 * `entry` 由组合根从 `ctx.fiber.entry` 取（见 `src/index.ts`）；本文件不碰 ctx。
 */
import { normalizeConfig, type SessionDeleteConfig } from '../config.js'
import type { ConfigEditorLike } from '../deps.js'
import { routeError, verbError } from '../errors.js'

/** `/config` 的写支需要的三件；读支只要 `config`。 */
export interface ConfigRouteDeps {
  readonly config: SessionDeleteConfig
  readonly configEditor?: ConfigEditorLike
  readonly entry?: unknown
}

/** `/config` 的请求体：`null` 或 `{}` 是读；只要带一个键就当写（未知键由 {@link normalizeConfig} 400 拒掉）。
 *  路由表按同一句话定纯度，所以别在别处再写一遍这个判据。 */
export function configPatchOf(body: Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (body === null || Object.keys(body).length === 0) return undefined
  return body
}

/** 空体 = 读当前值；带字段 = 写。请求体已经由适配器解析成对象或 null。 */
export function readOrSaveConfig(
  deps: ConfigRouteDeps,
  body: Record<string, unknown> | null,
): SessionDeleteConfig | Promise<SessionDeleteConfig> {
  const patch = configPatchOf(body)
  if (patch === undefined) return deps.config
  return saveConfig(deps, patch)
}

async function saveConfig(deps: ConfigRouteDeps, patch: Record<string, unknown>): Promise<SessionDeleteConfig> {
  let next: SessionDeleteConfig
  try {
    // 写支可以只带一个字段：先叠在当前归一值上再校验，漏掉的字段保持现状，不回落默认值。
    next = normalizeConfig({ ...deps.config, ...patch })
  } catch (error) {
    // 请求体不对用 4xx：不把一次坏输入伪装成 200 的操作失败。
    throw routeError('bad-request', 400, error instanceof Error ? error.message : String(error))
  }
  const editor = deps.configEditor
  if (editor === undefined || deps.entry === undefined) {
    throw verbError('io', '这一代宿主不能保存配置；请直接改 profile 的 cordis.patch.yml')
  }
  try {
    await editor.edit(deps.entry, (current) => ({ ...current, ...next }))
  } catch (error) {
    throw verbError(
      'io',
      `配置没有保存：${error instanceof Error ? error.message : String(error)}`,
      error,
    )
  }
  // 编辑器的 `edit` 已经接受候选；这里交回同一份归一值给界面（重启后 `apply` 会读到同样的值）。
  return next
}
