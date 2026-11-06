/**
 * 可调项（Config，ADR-0037）：三只旋钮 + 本地 Standard Schema。
 *
 * 为什么不用 `@deepseek-ai/schemastery` 写 schema：那是宿主包，值 import 会破本仓「跨插件一律
 * `import type`」的硬约束；Cordis 的 Config 接受 Standard Schema（`@standard-schema/spec`），
 * 手写这一小段即可，不需要把宿主 schema 库搬进插件。代价是宿主只为 native Schemastery schema 投影
 * 字段表单，这枚手写的 Standard Schema 不在其列——字段表单由插件设置页的「可调项」卡提供
 * （ADR-0043），profile 的 `cordis.patch.yml` 仍是默认值与覆盖的家。
 *
 * 这里只做**默认值、归一与 schema**，不持有运行期现场：`apply` 归一一次，结果作为
 * `CoreDeps.config` 注入；读方从自己的 deps 读，不 import 模块级单例。
 * 客户端 6 秒撤销时长不在这里：它是浏览器半的产品决定，不跨半传。
 */

import { CONFIG_LIMITS, type SessionDeleteConfigWire } from './shared/wire.js'

/** 三只可调项。字段名是线上契约（`shared/wire.ts` 的 `SessionDeleteConfigWire`），这里只是别名；
 *  Node 半读到的是归一后的只读快照，所以 `readonly` 保留。默认值、归一与 Standard Schema 住本文件，
 *  接受范围住在 `shared/wire.ts` 的 `CONFIG_LIMITS`：表单与归一必须是同一格，不然会「表单说能存、
 *  激活时报越界」。 */
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

/**
 * 把 patch 里的 `config` 归一成完整配置：缺省取默认值，未知键 / 非整数 / 越界都抛。
 * 抛错会让插件激活失败（响亮），而不是悄悄用半套配置跑。
 */
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

/**
 * 插件 Config：Cordis 接受 Standard Schema，`~standard.validate` 交回归一后的配置。
 * 宿主在激活前校验；`apply` 再归一一次（同一份事实，不会漂）。
 */
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
