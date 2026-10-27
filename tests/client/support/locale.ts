/** 用真实的 `EN` 字典绑一个英文 `t`：注册替身只负责把 `register` 收到的那份 en 交回来。 */
import { vi } from 'vitest'
import { createTranslate, type Translate } from '../../../src/client/copy.js'
import type { ClientContextLike } from '../../../src/client/context.js'

export function englishTranslate(): Translate {
  let dict: Record<string, string> = {}
  const service = {
    register: (_ns: string, value: { en: Record<string, string> }) => {
      dict = value.en
      return () => {}
    },
    bind: () => (key: string, params?: Record<string, string | number>) => {
      const template = dict[key] ?? key
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        params !== undefined && name in params ? String(params[name]) : match,
      )
    },
  }
  const ctx: ClientContextLike = {
    slots: { inject: vi.fn(), register: vi.fn() },
    get: () => service,
    effect: (execute: () => unknown) => execute(),
  }
  return createTranslate(ctx)
}
