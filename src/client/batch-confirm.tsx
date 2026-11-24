/**
 * 批量删除确认框：挂在 `shell.overlay` 上的宿主，加它读的请求现场（场景实例里的一份）。
 * 页脚与关框规则共壳（`confirm-dialog.tsx`，ADR-0052），业务面各是各的；请求现场必须活在行开关那棵
 * 子树之外（槽位行随宿主重排而卸载）。框不认识任何一方的选中集：执行后由发请求那一面交收缩钩子。
 */
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { useBusyGate } from './busy-gate.js'
import { fetchCounts } from './batch-select.js'
import { ConfirmDialog } from './confirm-dialog.js'
import { TARGET_CARD } from './delete-confirm.js'
import { zhTranslate, type Translate } from './copy.js'
import type { OneShotDeps } from './remote.js'
import { getDefaultClientScene, useClientScene } from './scene.js'
import type { PickItem } from './batch-selection-store.js'
import { createStore } from './store.js'
import { Tag } from './ui/Tag.js'
import { useWriteProgress } from './use-write-progress.js'
import { deleteSessionsFromBatch } from './write-seats.js'
import { WriteProgressLine } from './write-progress.js'

export interface BatchDeleteRequest {
  /** 每次发布递增：换一批就重挂载，busy / 失败面不带着上一批的记忆。 */
  seq: number
  items: readonly PickItem[]
  /** 落地后收缩**发请求那一面**的选中集；被闸挡回的那一趟不调它——这一趟没跑，不许照着它动任何选中集。 */
  shrinkSelection?: (failedSessionIds: readonly string[]) => void
}

export interface BatchConfirmScene {
  /** 请求确认这一批。空名单不发框；`shrinkSelection` 缺席 = 这一面没有要收缩的选中集。 */
  request(items: readonly PickItem[], shrinkSelection?: (failedSessionIds: readonly string[]) => void): void
  /** 收起确认框。**带 expected 比较**：一次批量在飞时用户可能已发布了**下一批**请求（框按 seq 重挂载），
   *  旧实例晚到的成功只许收自己那一批，不许把后来发布的那批一起清掉。 */
  clear(expected?: BatchDeleteRequest): void
  /** 重试轮之后把现场收缩到失败名单。**带 expected 比较**：旧实例晚到的部分失败不许收缩后来发布的那一批。 */
  shrinkToFailures(expected: BatchDeleteRequest, failedSessionIds: readonly string[]): void
  use(): BatchDeleteRequest | null
  reset(): void
}

export function createBatchConfirmScene(): BatchConfirmScene {
  const requestStore = createStore<BatchDeleteRequest | null>(null)
  return {
    request(items, shrinkSelection): void {
      if (items.length === 0) return
      requestStore.publish((seq) => ({
        seq,
        items: [...items],
        ...(shrinkSelection === undefined ? {} : { shrinkSelection }),
      }))
    },
    clear(expected?: BatchDeleteRequest): void {
      requestStore.update((current) => (expected === undefined || current === expected ? null : current))
    },
    shrinkToFailures(expected: BatchDeleteRequest, failedSessionIds: readonly string[]): void {
      requestStore.update((current) => {
        if (current !== expected) return current
        const keep = new Set(failedSessionIds)
        return { ...current, items: current.items.filter((item) => keep.has(item.sessionId)) }
      })
    },
    use(): BatchDeleteRequest | null {
      return requestStore.use()
    },
    reset(): void {
      requestStore.reset()
    },
  }
}

export function requestDeleteBatch(
  items: readonly PickItem[],
  shrinkSelection?: (failedSessionIds: readonly string[]) => void,
): void {
  getDefaultClientScene().batchConfirm.request(items, shrinkSelection)
}

export function clearDeleteBatchRequest(expected?: BatchDeleteRequest): void {
  getDefaultClientScene().batchConfirm.clear(expected)
}

/** 供浮条与装配面订阅（生产走 Provider 的那一份；测试无 Provider 回退默认场景）。 */
export function useDeleteBatchRequest(): BatchDeleteRequest | null {
  return useClientScene().batchConfirm.use()
}

export function BatchConfirmHost({
  deps,
  t = zhTranslate,
}: {
  deps: OneShotDeps
  t?: Translate
}): ReactElement | null {
  const current = useDeleteBatchRequest()
  if (current === null) return null
  return <BatchConfirmDialog key={current.seq} request={current} deps={deps} t={t} />
}

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

const TARGET_META = { fontSize: 12, lineHeight: '18px', color: 'var(--sd-label-tertiary)' } as const

/**
 * 目标卡要能装几十条：卡片内部滚，头与动作行留在框里（沿用回收站批量恢复的 280px 先例）。
 * **必须渲染期构造，不能是模块顶层常量**：`delete-confirm → scene → batch-confirm` 是一条模块环，
 * 顶层展开 `TARGET_CARD` 会拿到未初始化值（原生 ESM 为 TDZ），卡片会静默丢配方。判据 `tests/client/scene-cycle.test.tsx`。
 */
function batchTargetCard(): CSSProperties {
  return { ...TARGET_CARD, maxHeight: 280, overflow: 'auto' }
}

function BatchConfirmDialog({
  request: current,
  deps,
  t,
}: {
  request: BatchDeleteRequest
  deps: OneShotDeps
  t: Translate
}) {
  /** 这一趟的闸：写入座位把 apply → 收尾 → 重读整趟包在里面，`busy` 期间主按钮按住。 */
  const gate = useBusyGate()
  /** 逐条失败原文：`sessionId → 信封的 message`。失败**不关框**（与单删同款）。 */
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map())
  /** 开框那一刻现问的子会话计数；`null` = 有一条读不到 ⇒ 那两半句整句不说（不许拿 0 冒充"没有"）。 */
  const [counts, setCounts] = useState<Map<string, number> | null>(null)

  const ids = current.items.map((item) => item.sessionId)
  // 写身份认领（ADR-0069 决定 4）：这一批的 k/N 才上屏，另一趟在写就只说排队中。
  const face = useWriteProgress(deps, { action: 'delete', ids }, gate.busy)
  const failedIds = [...failures.keys()]
  const totalKids = counts === null
    ? 0
    : current.items.reduce((sum, item) => sum + (counts.get(item.sessionId) ?? 0), 0)

  useEffect(() => {
    let alive = true
    void fetchCounts(deps, current.items.map((item) => item.sessionId)).then((result) => {
      if (alive) setCounts(result)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 「开框一次问一遍计数」是刻意的：`current.items` 跟着 `seq`，把它放进依赖会在重试收缩名单时再问一遍。
  }, [deps, current.seq])

  const scene = useClientScene()

  const run = async (): Promise<void> => {
    // 首轮发全部、重试轮只发失败的那些（现场已收缩）；逐条失败落点交给座位，这里只留勾选收缩与收框。
    const result = await deleteSessionsFromBatch(
      deps,
      current.items.map((item) => item.sessionId),
      gate,
      {
        clear: () => { setFailures(new Map()) },
        set: (failures) => { setFailures(failures) },
      },
    )
    // 被闸挡回的那一趟什么都没跑：不改勾选、不收框，也不追加失败——界面后果全归在飞的那一趟。
    if (result.kind === 'blocked') return
    const failed = result.value
    current.shrinkSelection?.([...failed.keys()])
    if (failed.size === 0) {
      scene.batchConfirm.clear(current)
      return
    }
    scene.batchConfirm.shrinkToFailures(current, [...failed.keys()])
  }

  return (
    <ConfirmDialog
      title={current.items.length === 1 ? t('dialog.title') : t('dialog.batch.title', { n: current.items.length })}
      closeLabel={t('common.close')}
      cancelLabel={t('common.cancel')}
      confirmLabel={failedIds.length > 0
        ? t('dialog.batch.retry', { n: failedIds.length })
        : t('batch.run', { n: ids.length })}
      busy={gate.busy}
      busyLabel={t('progress.action.delete')}
      onCancel={() => { scene.batchConfirm.clear(current) }}
      onConfirm={() => void run()}
    >
      <div data-dsh-session-delete="batch-target-card" style={batchTargetCard()}>
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
      <WriteProgressLine face={face} t={t} />
    </ConfirmDialog>
  )
}
