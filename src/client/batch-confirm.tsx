/**
 * 批量删除的确认框——挂在 `shell.overlay` 上的宿主，加它读的那个模块级现场。
 *
 * 为什么又开一个文件而不是把 `delete-confirm.tsx` 撑大：单删那张框是**已交付的面**（docs/ui-spec.md 状态 ②，
 * 用例钉着），批量形与它只有三件不同——标题随条数、目标卡逐条列、执行是一次批量 `apply`。共用一个壳
 * 意味着单删的 `busy` / 失败面要跟着学批量形，那是拿已交付的行为去换省一个文件。卡片样式（`TARGET_CARD`）
 * 与 hint、子会话那两句**复用**单删的，一句不造第二个键。
 *
 * 现场是模块级的（同 `delete-confirm.tsx` / `undo-notices.ts`）：请求从浮条那颗按钮发来，确认框住在
 * `shell.overlay` 上——它必须活在行开关那棵子树之外（槽位行随宿主重排而卸载，见 `delete-confirm.tsx` 头注）。
 */
import { useEffect, useState, type ReactElement } from 'react'
import { useBusyGate } from './busy-gate.js'
import { useIdleClose } from './confirm-close.js'
import { fetchCounts } from './batch-select.js'
import { TARGET_CARD } from './delete-confirm.js'
import { zhTranslate, type Translate } from './copy.js'
import type { SessionDeleteRemote } from './remote.js'
import { getPicks, shrinkPicksToFailures, type PickItem } from './batch-selection-store.js'
import { createStore } from './store.js'
import { Button } from './ui/Button.js'
import { Modal } from './ui/Modal.js'
import { Tag } from './ui/Tag.js'
import { deleteSessionsFromBatch } from './write-seats.js'

export interface BatchDeleteRequest {
  /** 每次发布递增：换一批就重挂载，busy / 失败面不带着上一批的记忆。 */
  seq: number
  items: readonly PickItem[]
}

const requestStore = createStore<BatchDeleteRequest | null>(null)

/** 浮条那颗按钮调用：请求确认这一批（缺省 = 当前选中集）。空名单不发框。 */
export function requestDeleteBatch(items: readonly PickItem[] = getPicks()): void {
  if (items.length === 0) return
  requestStore.publish((seq) => ({ seq, items: [...items] }))
}

export function clearDeleteBatchRequest(): void {
  requestStore.set(null)
}

/** 重试轮之后把现场收缩到失败名单（框里只剩还没办成的那几条）。 */
function shrinkRequestToFailures(failedSessionIds: readonly string[]): void {
  requestStore.update((current) => {
    if (current === null) return current
    const keep = new Set(failedSessionIds)
    return { ...current, items: current.items.filter((item) => keep.has(item.sessionId)) }
  })
}

/** 供浮条与装配面订阅。 */
export function useDeleteBatchRequest(): BatchDeleteRequest | null {
  return requestStore.use()
}

/** 测试专用：现场与 seq 归零，用例之间互不串味。 */
export function resetBatchConfirm(): void {
  requestStore.reset()
}

export type BatchConfirmDeps = Pick<SessionDeleteRemote, 'applyOutcomes'>

/** 常驻的批量确认框宿主。没有待确认的批量删除时什么都不渲染。 */
export function BatchConfirmHost({
  deps,
  t = zhTranslate,
}: {
  deps: BatchConfirmDeps
  t?: Translate
}): ReactElement | null {
  const current = useDeleteBatchRequest()
  if (current === null) return null
  return <BatchConfirmDialog key={current.seq} request={current} deps={deps} t={t} />
}

/** 目标卡里那一行：标题（可及名走 ellipsis，与单删那张同）+ 有才标的子会话数。 */
const TARGET_LINE = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '3px 0',
} as const

const TARGET_TITLE = {
  fontSize: 14,
  fontWeight: 500,
  lineHeight: '20px',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const

const TARGET_META = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' } as const

/**
 * 目标卡要能装几十条：选中很多条时卡片不能把弹框撑出视口，标题与底部按钮必须保持可见。
 * 沿用回收站批量恢复确认框的 280px 先例——**只在卡片内部滚**，头与动作行留在框里。
 */
const BATCH_TARGET_CARD = {
  ...TARGET_CARD,
  maxHeight: 280,
  overflow: 'auto',
} as const

function BatchConfirmDialog({
  request: current,
  deps,
  t,
}: {
  request: BatchDeleteRequest
  deps: BatchConfirmDeps
  t: Translate
}) {
  /** 这一趟的闸：写入座位把 apply → 收尾 → 重读整趟包在里面，`busy` 期间主按钮按住。 */
  const gate = useBusyGate()
  const { close, closeDisabled } = useIdleClose(gate.busy, clearDeleteBatchRequest)
  /** 逐条失败原文：`sessionId → 信封的 message`。失败**不关框**（与单删同款）。 */
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map())
  /** 开框那一刻现问的子会话计数；`null` = 有一条读不到 ⇒ 那两半句整句不说（不许拿 0 冒充"没有"）。 */
  const [counts, setCounts] = useState<Map<string, number> | null>(null)

  const ids = current.items.map((item) => item.sessionId)
  const failedIds = [...failures.keys()]
  const totalKids = counts === null ? 0 : [...counts.values()].reduce((sum, n) => sum + n, 0)

  useEffect(() => {
    let alive = true
    void fetchCounts(deps, current.items.map((item) => item.sessionId)).then((result) => {
      if (alive) setCounts(result)
    })
    return () => {
      alive = false
    }
    // 计数只在**开框那一次**问；重试轮现场收缩成新对象，也不再问第二遍（`seq` 不变 ⇒ 不重挂载）
  }, [deps, current.seq])

  const run = async (): Promise<void> => {
    setFailures(new Map())
    // 首轮发全部；重试轮只发失败的那些——上一轮已把请求现场收缩到失败名单，`current.items` 就是那一批。
    const failed = await deleteSessionsFromBatch(deps, current.items.map((item) => item.sessionId), gate)
    shrinkPicksToFailures([...failed.keys()])
    if (failed.size === 0) {
      clearDeleteBatchRequest()
      return
    }
    setFailures(failed)
    shrinkRequestToFailures([...failed.keys()])
  }

  return (
    <Modal
      open
      onClose={close}
      title={
        current.items.length === 1 ? t('dialog.title') : t('dialog.batch.title', { n: current.items.length })
      }
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="outline" disabled={closeDisabled} onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={gate.busy} onClick={() => void run()}>
            {failedIds.length > 0
              ? t('dialog.batch.retry', { n: failedIds.length })
              : t('batch.run', { n: ids.length })}
          </Button>
        </>
      }
    >
      <div data-dsh-session-delete="batch-target-card" style={BATCH_TARGET_CARD}>
        {current.items.map((item) => {
          const kids = counts === null ? 0 : (counts.get(item.sessionId) ?? 0)
          const failure = failures.get(item.sessionId)
          return (
            <div key={item.sessionId} data-dsh-session-delete="batch-target">
              <div style={TARGET_LINE}>
                <span style={TARGET_TITLE}>
                  {item.title === '' ? t('common.untitled') : item.title}
                </span>
                {kids > 0 ? (
                  <span style={TARGET_META}>{t('trash.row.subagents', { n: kids })}</span>
                ) : null}
              </div>
              {failure === undefined ? null : <Tag tone="danger">{failure}</Tag>}
            </div>
          )
        })}
      </div>
      {totalKids === 0 ? null : <p>{t('dialog.subagents', { n: totalKids })}</p>}
      <p>{t('dialog.hint')}</p>
    </Modal>
  )
}
