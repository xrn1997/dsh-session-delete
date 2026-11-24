/**
 * 「删除」确认框，挂在 shell.overlay 上。宿主菜单行随菜单关闭而卸载，确认框若住在行内会被连坐，
 * 因此菜单行只把 {sessionId,title} 写进场景实例里的请求现场，DeleteConfirmHost 在 overlay 读取并提交。
 */
import { useEffect, useState } from 'react'
import { useBusyGate } from './busy-gate.js'
import { ConfirmDialog } from './confirm-dialog.js'
import { zhTranslate, type Translate } from './copy.js'
import { applyOne, type OneShotDeps } from './remote.js'
import { getDefaultClientScene, useClientScene } from './scene.js'
import { createStore } from './store.js'
import { Tag } from './ui/Tag.js'
import { useWriteProgress } from './use-write-progress.js'
import { deleteSessionFromMenu } from './write-seats.js'
import { WriteProgressLine } from './write-progress.js'

/**
 * 被操作对象那张卡。`Modal` 的 `.sd-modal-body` 不设字号也不给层级 ⇒ 裸摆一行标题会和下面那句提示
 * **同字同色**，读不出"这才是要被删的东西"。配方与「彻底删除」框里那张摘要卡同一套（宿主设置面的
 * 卡片 token），两个对话框因此同形。
 */
export const TARGET_CARD = {
  padding: '10px 12px',
  background: 'var(--dsw-alias-bg-layer-2)',
  border: '0.5px solid var(--sd-border-l4)',
  borderRadius: 'var(--sd-radius-lg)',
} as const

/** 菜单行写进现场的一条删除请求（槽位投影原样带过来，浏览器半不自己拼 id）。 */
export interface DeleteRequest {
  /** 每次发布递增：换一个会话就重挂载确认框，busy / failure 不带着上一条请求的记忆。 */
  seq: number
  /** 原样透给删除写入（段名与动作住 `shared/wire.ts`，浏览器半不自己拼 id）。 */
  sessionId: string
  /** 删除那一刻的会话名（槽位投影的 `displayTitle`）：只用于确认框文案与撤销提示。 */
  title: string
}

/** 一台「删除」确认框请求现场：发布 / 按 expected 收框 / 订阅 / 收场。 */
export interface DeleteRequestScene {
  /** 菜单行调用：请求删除这个会话（确认框由 overlay 上的宿主渲染）。 */
  request(input: { sessionId: string; title: string }): void
  /** 收起确认框（用户点「取消」/「关闭」、或删除成功后收工）。
   *  **必带 expected 比较**：一次删除在飞时用户可能已经发布了**下一条**请求（框按 seq 重挂载）。
   *  旧实例晚到的成功只许收自己那一条，不许把后来发布的请求一起清掉（那会让新框凭空消失）。
   *  复位走 `reset`，收框一律交 `current`。 */
  clear(expected: DeleteRequest): void
  /** 供宿主组件订阅。 */
  use(): DeleteRequest | null
  /** 场景收场：现场与 seq 归零。 */
  reset(): void
}

export function createDeleteRequestScene(): DeleteRequestScene {
  const requestStore = createStore<DeleteRequest | null>(null)
  return {
    request(input): void {
      requestStore.publish((seq) => ({ seq, sessionId: input.sessionId, title: input.title }))
    },
    clear(expected: DeleteRequest): void {
      requestStore.update((current) => (current === expected ? null : current))
    },
    use(): DeleteRequest | null {
      return requestStore.use()
    },
    reset(): void {
      requestStore.reset()
    },
  }
}

/* ── 兼容自由函数：委托默认场景的实例 ────────────────────────── */

/** 菜单行调用：请求删除这个会话（默认场景）。 */
export function requestDelete(input: { sessionId: string; title: string }): void {
  getDefaultClientScene().deleteRequest.request(input)
}

/** 供宿主组件订阅（生产走 Provider；测试无 Provider 回退默认场景）。 */
export function useDeleteRequest(): DeleteRequest | null {
  return useClientScene().deleteRequest.use()
}

/** 常驻的确认框宿主。挂 `shell.overlay`（框架级浮层）：没有待确认的删除时什么都不渲染。 */
export function DeleteConfirmHost({ deps, t = zhTranslate }: { deps: OneShotDeps; t?: Translate }) {
  const current = useDeleteRequest()
  if (current === null) return null
  // `key` 跟着 seq 走：新的一条请求是一个全新的对话框（官方 `Toast` 的 `key={seq}` 同一口径）。
  return <DeleteConfirmDialog key={current.seq} request={current} deps={deps} t={t} />
}

/**
 * 确认框本体（视图与文案与 docs/ui-spec.md 一致）。失败面**不吞**：原文以 `Tag tone="danger"` 摆进
 * 对话框，且**确认失败后不关框**，用户可以再点一次。
 */
function DeleteConfirmDialog({
  request: current,
  deps,
  t,
}: {
  request: DeleteRequest
  deps: OneShotDeps
  t: Translate
}) {
  /** 这一趟的闸：写入座位把 apply → 收尾 → 重读整趟包在里面，`busy` 期间主按钮按住。 */
  const gate = useBusyGate()
  // 写身份认领（ADR-0069 决定 4）：单删也逐步推进（k/N 就是 0/1 → 1/1），认领不上只说排队中。
  const face = useWriteProgress(deps, { action: 'delete', ids: [current.sessionId] }, gate.busy)
  const [failure, setFailure] = useState<string | null>(null)
  /**
   * 这条会话在盘上带多少个后代。删除按组走（组语义见 `src/trash/groups.ts`），而宿主客户端本来就把孩子那几行
   * 整排藏了 ⇒ 不说没人知道点下去侧栏会少一片（issue #3）；那一刻它还没进回收站，只能现问一次。
   */
  const [subagents, setSubagents] = useState(0)

  useEffect(() => {
    let alive = true
    void (async () => {
      const outcome = await applyOne(deps, 'count', current.sessionId)
      // 读不到就**不说那半句**（0 也是"没说"）：一次取数失败不许锁死删除按钮，也不许把"读不出"写成"没有子会话"。
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `alive` 由 effect 的清理闭包写成 false，TS 看不见闭包写入；删了会让卸载后的取数写回已销毁的框。
      if (alive) setSubagents(outcome.ok ? outcome.value.value : 0)
    })()
    return () => { alive = false }
  }, [deps, current.sessionId])

  const scene = useClientScene()

  const confirm = async (): Promise<void> => {
    // 逐条失败落点交给座位：apply 前清旧原文、跑完按 id 铺回；这里只保留两个呈现分支——挡回不动框，失败不关框。
    const run = await deleteSessionFromMenu(
      deps,
      {
        sessionId: current.sessionId,
        title: current.title,
        failureSink: {
          clear: () => { setFailure(null) },
          set: (failures) => { setFailure(failures.get(current.sessionId) ?? null) },
        },
      },
      gate,
    )
    // `blocked` 是闸把这一趟挡回来了（连点的第二下）：这一趟没跑 ⇒ 框不收、不追加失败；界面后果全归在飞那一趟
    // （收了就会把那一趟的失败原文丢在已经卸载的框上）。
    if (run.kind === 'blocked') return
    // 失败原文已由座位的落点铺好；这一支只回答「框关不关」。
    if (run.value !== null) return
    // 只收**自己这条**请求：在飞期间可能已经发布了新的删除请求（新框），旧成功不许连坐清掉它。
    scene.deleteRequest.clear(current)
  }

  return (
    <ConfirmDialog
      title={t('dialog.title')}
      closeLabel={t('common.close')}
      cancelLabel={t('common.cancel')}
      confirmLabel={t('dialog.confirm')}
      busy={gate.busy}
      busyLabel={t('progress.action.delete')}
      onCancel={() => { scene.deleteRequest.clear(current) }}
      onConfirm={() => void confirm()}
    >
      <div style={TARGET_CARD}>
        <div
          data-dsh-session-delete="target"
          style={{
            fontSize: 14,
            fontWeight: 500,
            lineHeight: '20px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {current.title === '' ? t('common.untitled') : current.title}
        </div>
      </div>
      {subagents === 0 ? null : <p>{t('dialog.subagents', { n: subagents })}</p>}
      <p>{t('dialog.hint')}</p>
      {failure === null ? null : <Tag tone="danger">{failure}</Tag>}
      <WriteProgressLine face={face} t={t} />
    </ConfirmDialog>
  )
}
