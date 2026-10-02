/**
 * 两个纯格式化函数（**逐条抄自** `@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2` 的
 * `lib/index.js`；出处与改写规则见 `ui.css` 头注）。
 *
 * 它们是**纯函数、零 React、零 token**，所以「抄进来」在这里没有任何版本耦合的代价——真正随宿主换代
 * 会变的是组件与样式，不是这两段算术。抄而不是自己写，为的是**输出逐字相同**：本仓的用例与真机读数
 * 都钉在 `312B` / `4.2KB` / `1.5MB` 与「刚刚 / N分钟 / N小时 / N天 / N个月 / N年」这几个分桶上，
 * 自己重写一遍就等于换了一套措辞。
 */
/** 时间分桶的单位词（官方 `relativeTime` 的返回联合，逐字相同）。 */
export type RelativeTimeUnit = 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'

/** 紧凑的字节数文本（`312B`、`4.2KB`、`1.5MB`、`2.4GB`）：整单位，选中单位小于十时带一位小数。 */
export function fileSizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)}KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)}MB`
  const gb = mb / 1024
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)}GB`
}

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** 时间分桶（`now` / 分钟 / 小时 / 天 / 月 / 年）；措辞由调用面自己组（见 `trash-panel.tsx`）。 */
export function relativeTime(at: number, now: number): { unit: RelativeTimeUnit; n: number } {
  const diff = Math.max(0, now - at)
  if (diff < MINUTE_MS) return { unit: 'now', n: 0 }
  if (diff < HOUR_MS) return { unit: 'minutes', n: Math.floor(diff / MINUTE_MS) }
  if (diff < DAY_MS) return { unit: 'hours', n: Math.floor(diff / HOUR_MS) }
  if (diff < 30 * DAY_MS) return { unit: 'days', n: Math.floor(diff / DAY_MS) }
  if (diff < 365 * DAY_MS) return { unit: 'months', n: Math.floor(diff / (30 * DAY_MS)) }
  return { unit: 'years', n: Math.floor(diff / (365 * DAY_MS)) }
}
