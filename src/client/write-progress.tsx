/**
 * 写入进度行（`docs/ui-spec.md` §2 忙碌面的进度行）：认领到的 k/N · 步骤 · 已用秒数，认领不上只说排队中。
 * `null` 脸什么都不渲染——按钮上的 `busyLabel` 已兜底忙碌感。秒数在本组件内每秒自己刷新，不靠父组件重渲染。
 *
 * 那句行文由四段拼成（口径裁定）：动作句、计数、步骤、秒数各住一枚文案键，k/N 与步骤逐拍变、秒数逐秒变——
 * 整句一个键会让任一段变化都重写整句模板，也让「已用秒数」没法单独活着。语序与「 · 」分隔在两种语言下同形。
 */
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import type { CopyKey, Translate } from './copy.js'
import type { WriteProgressAction, WriteProgressStep } from '../shared/wire.js'
import type { WriteProgressFace } from './use-write-progress.js'

/** wire 的动作码 → 文案键（`orphan-clean` 在文案面叫 `orphanClean`，键名差异只住这一张表）。 */
const ACTION_KEY: Record<WriteProgressAction, CopyKey> = {
  delete: 'progress.action.delete',
  restore: 'progress.action.restore',
  purge: 'progress.action.purge',
  unarchive: 'progress.action.unarchive',
  'orphan-clean': 'progress.action.orphanClean',
  empty: 'progress.action.empty',
}

/** 步骤码 → 文案键（码表住 `shared/wire.ts` 的 `WRITE_PROGRESS_STEPS`，穷尽性由这张表的类型盯住）。 */
const STEP_KEY: Record<WriteProgressStep, CopyKey> = {
  checking: 'progress.step.checking',
  measuring: 'progress.step.measuring',
  moving: 'progress.step.moving',
  ledger: 'progress.step.ledger',
  deleting: 'progress.step.deleting',
  attachments: 'progress.step.attachments',
  finishing: 'progress.step.finishing',
}

/**
 * 进度行的皮：自成一行、小一号字。**字色不指定**——撤销横幅的表面是固定的深色（`ui.css` 的抄本口径），
 * 套主题字色会在深底上掉对比度；跟容器走，两处都读得清。
 */
const LINE: CSSProperties = {
  display: 'block',
  marginBlockStart: 6,
  fontSize: 12,
  lineHeight: '17px',
}

/** 已用秒数那一段：服务端起点与本机在飞起点取较保守的一边，避免远端时钟偏差制造巨值或冻住。
 *  **不进无障碍树**：它每秒都变，留在 `role="status"` 里会让读屏用户每秒重播整行；k/N 与步骤才是要播报的事实。 */
function Elapsed({ startedAt, localStartedAt, t }: { startedAt: number; localStartedAt: number; t: Translate }): ReactElement {
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => {
      tick((n) => n + 1)
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [])
  const now = Date.now()
  const serverElapsed = now - startedAt
  const localElapsed = now - localStartedAt
  const elapsed = serverElapsed < 0 ? localElapsed : Math.min(serverElapsed, localElapsed)
  return <span aria-hidden="true">{t('progress.elapsed', { s: Math.max(0, Math.floor(elapsed / 1000)) })}</span>
}

/** 进度行本体：`role="status"` 就是 `docs/ui-spec.md` §2 那条 `aria-live`（遥测小读的翻转不该抢焦点）。
 *  `announce=false` 用于已经处在另一个 live region（撤销横幅的 `role=alert`）里的场景：整行只做视觉，
 *  否则每个 tick 都会以 assertive 打断读屏用户。 */
export function WriteProgressLine({
  face,
  t,
  announce = true,
}: {
  face: WriteProgressFace | null
  t: Translate
  announce?: boolean
}): ReactElement | null {
  if (face === null) return null
  const lineProps = announce
    ? { role: 'status' as const }
    : { 'aria-hidden': true as const }
  if (face.kind === 'queued') {
    return <span {...lineProps} style={LINE}>{t('progress.queued')}</span>
  }
  return (
    <span {...lineProps} style={LINE}>
      {`${t(ACTION_KEY[face.action])} ${t('progress.count', { done: face.done, total: face.total })} · ${t(STEP_KEY[face.step])} · `}
      <Elapsed startedAt={face.startedAt} localStartedAt={face.localStartedAt} t={t} />
    </span>
  )
}
