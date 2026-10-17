/**
 * 批量删除的确认框（第十三批②）——挂在 `shell.overlay` 上的宿主，加它读的那个模块级现场。
 *
 * 为什么又开一个文件而不是把 `delete-confirm.tsx` 撑大：单删那张框是**已交付的面**（设计稿 §7 状态 ②，
 * 用例钉着），批量形与它只有三件不同——标题随条数、目标卡逐条列、执行是一次批量 `apply`。共用一个壳
 * 意味着单删的 `busy` / 失败面要跟着学批量形，那是拿已交付的行为去换省一个文件。卡片样式（`TARGET_CARD`）
 * 与 hint、子会话那两句**复用**单删的，一句不造第二个键。
 *
 * 现场是模块级的（同 `delete-confirm.tsx` / `undo-toast.tsx`）：请求从浮条那颗按钮发来，确认框住在
 * `shell.overlay` 上——它必须活在行开关那棵子树之外（槽位行随宿主重排而卸载，见 `delete-confirm.tsx` 头注）。
 */
import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'
import { TARGET_CARD } from './delete-confirm.js'
import { fetchCounts, getPicks, shrinkPicksToFailures, type PickItem } from './batch-select.js'
import { zhTranslate, type Translate } from './copy.js'
import { callRemote, type SessionDeleteRemote } from './remote.js'
import { invalidateTrash } from './trash-store.js'
import { Button } from './ui/Button.js'
import { Modal } from './ui/Modal.js'
import { Tag } from './ui/Tag.js'
import { publishUndoBatchNotice } from './undo-toast.js'

export interface BatchDeleteRequest {
  /** 每次发布递增：换一批就重挂载，busy / 失败面不带着上一批的记忆。 */
  seq: number
  items: readonly PickItem[]
}

let request: BatchDeleteRequest | null = null
let nextSeq = 0
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const listener of listeners) listener()
}

/** 浮条那颗按钮调用：请求确认这一批（缺省 = 当前选中集）。空名单不发框。 */
export function requestDeleteBatch(items: readonly PickItem[] = getPicks()): void {
  if (items.length === 0) return
  request = { seq: (nextSeq += 1), items: [...items] }
  emit()
}

export function clearDeleteBatchRequest(): void {
  if (request === null) return
  request = null
  emit()
}

/** 重试轮之后把现场收缩到失败名单（框里只剩还没办成的那几条）。 */
function shrinkRequestToFailures(failedSessionIds: readonly string[]): void {
  if (request === null) return
  const keep = new Set(failedSessionIds)
  request = { ...request, items: request.items.filter((item) => keep.has(item.sessionId)) }
  emit()
}

function getBatchRequest(): BatchDeleteRequest | null {
  return request
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 供浮条与装配面订阅。 */
export function useDeleteBatchRequest(): BatchDeleteRequest | null {
  return useSyncExternalStore(subscribe, getBatchRequest, getBatchRequest)
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
 * 目标卡要能装几十条：2026-10-17 真机一次选 64 条，卡片把弹框撑出视口，标题和底部按钮都被顶没了。
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
  const [busy, setBusy] = useState(false)
  /** 逐条失败原文：`sessionId → 信封的 message`。失败**不关框**（与单删同款）。 */
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map())
  /** 开框那一刻现问的子会话计数；`null` = 有一条读不到 ⇒ 那两半句整句不说（不许拿 0 冒充"没有"）。 */
  const [counts, setCounts] = useState<Map<string, number> | null>(null)

  const ids = current.items.map((item) => item.sessionId)
  const failedIds = [...failures.keys()]
  /** 首轮发全部；重试轮只发失败的那些（成功的已经不在名单里了）。 */
  const pendingIds = failedIds.length > 0 ? failedIds : ids
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
    setBusy(true)
    setFailures(new Map())
    const outcome = await callRemote(() => deps.applyOutcomes('delete', pendingIds))
    setBusy(false)
    if (!outcome.ok) {
      // 整次调用没办成：一条都没落地 ⇒ 原文摆到每一行，别让框看起来"删成功了"（与回收站那两处同法）
      setFailures(new Map(pendingIds.map((id) => [id, outcome.failure.message])))
      return
    }
    const byId = new Map<string, (typeof outcome.value)[number]>()
    for (const item of outcome.value) if (!byId.has(item.id)) byId.set(item.id, item)
    const moved: string[] = []
    const failed = new Map<string, string>()
    let okCount = 0
    for (const id of pendingIds) {
      const item = byId.get(id)
      // 一条没回是**通道的错**，不是"没做成"，更不是"已被带走"（与 `remote.ts` 的 `applyOne` 同判据）
      if (item === undefined) {
        failed.set(id, `批量通道没回这一条的结果：delete ${id}`)
        continue
      }
      if (!item.ok) {
        failed.set(id, item.error.message)
        continue
      }
      okCount += 1
      // `value === null` 是"已被同批前一条带走"的幂等条：跟着组走，不单列进撤销名单
      if (item.action === 'delete' && item.value !== null) moved.push(item.value.id)
    }
    if (okCount > 0) publishUndoBatchNotice({ entryIds: moved, n: okCount })
    // 回收站多了几条：让正开着的清单面板重读
    invalidateTrash()
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
      onClose={clearDeleteBatchRequest}
      title={
        current.items.length === 1 ? t('dialog.title') : t('dialog.batch.title', { n: current.items.length })
      }
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="outline" onClick={clearDeleteBatchRequest}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void run()}>
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
