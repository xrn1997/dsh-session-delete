/** 可调项（Config，ADR-0037）：三只旋钮 + 本地 Standard Schema。
 *  不用宿主 schema 库：值 import 会破「跨插件一律 import type」；字段表单由插件设置页按 ADR-0043 提供。
 *  这里只做默认值、归一与 schema，不持有运行期现场；读方从自己的 deps 读。 */

import { CONFIG_LIMITS, type SessionDeleteConfigWire } from './shared/wire.js'

/** 三只可调项，字段名是线上契约（`SessionDeleteConfigWire` 的别名）；接受范围住 `CONFIG_LIMITS`。
 *  表单与归一必须同一格，不然会「表单说能存、激活时报越界」。 */
export type SessionDeleteConfig = Readonly<SessionDeleteConfigWire>

export const DEFAULT_CONFIG: SessionDeleteConfig = Object.freeze({
  orphanPreviewLimit: 200,
  maxAttachmentBytes: 20 * 1024 * 1024,
  maxJsonRefBytes: 10 * 1024 * 1024,
})

function intField(
  input: Record<string, unknown>,
  key: keyof SessionDeleteConfig,
  range: { readonly min: number; readonly max: number },
): number {
  const value = input[key]
  if (value === undefined) return DEFAULT_CONFIG[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < range.min || value > range.max) {
    throw new Error(`配置项 ${key} 需为 ${range.min}..${range.max} 的整数`)
  }
  return value
}

/** 把 patch 里的 `config` 归一成完整配置：缺省取默认值，未知键 / 非整数 / 越界都抛。
 *  抛错让插件激活失败（响亮），而不是悄悄用半套配置跑。 */
export function normalizeConfig(value: unknown): SessionDeleteConfig {
  if (value === undefined || value === null) return DEFAULT_CONFIG
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('配置需为对象')
  const input = value as Record<string, unknown>
  const known = new Set<string>(Object.keys(CONFIG_LIMITS))
  for (const key of Object.keys(input)) {
    if (!known.has(key)) throw new Error(`未知配置项：${key}`)
  }
  return {
    orphanPreviewLimit: intField(input, 'orphanPreviewLimit', CONFIG_LIMITS.orphanPreviewLimit),
    maxAttachmentBytes: intField(input, 'maxAttachmentBytes', CONFIG_LIMITS.maxAttachmentBytes),
    maxJsonRefBytes: intField(input, 'maxJsonRefBytes', CONFIG_LIMITS.maxJsonRefBytes),
  }
}

/** 插件 Config：`~standard.validate` 交回归一后的配置；宿主在激活前校验，`apply` 再归一一次。 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-session-delete',
    validate(value: unknown) {
      try {
        return { value: normalizeConfig(value) }
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
      }
    },
  },
} as const
