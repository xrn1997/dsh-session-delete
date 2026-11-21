/**
 * `/config` 的读/写动词：三只可调项的当前值与写回。读是免费快照；写先经 `normalizeConfig` 校验（坏输入 400，不写半套值），
 * 再走宿主 `configEditor.edit`（编辑器串行化、校验并让这一行重启）；编辑器 / entry 缺席回 `io` 并说清替代路径，不假装保存成功。
 * `entry` 由组合根从 `ctx.fiber.entry` 取；本文件不碰 ctx。
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
