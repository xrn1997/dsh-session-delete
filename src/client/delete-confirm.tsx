/**
 * 「删除」确认框，挂在 shell.overlay 上；菜单行只负责发请求。
 *
 * 宿主菜单行随菜单关闭而卸载，确认框若住在行内会被连坐卸载，因此把请求与确认拆开：
 * 菜单行把 {sessionId,title} 写进模块级 store，DeleteConfirmHost 在 overlay 读取并提交。
 * 这样提交、失败原文、重试与撤销提示都在菜单子树之外，开合菜单不影响它们。
 */
import { useEffect, useState } from 'react'
import { useBusyGate } from './busy-gate.js'
import { useIdleClose } from './confirm-close.js'
import { zhTranslate, type Translate } from './copy.js'
import { applyOne, callRemote, type DeleteConfirmDeps } from './remote.js'
import { createStore } from './store.js'
import { Button } from './ui/Button.js'
import { Modal } from './ui/Modal.js'
import { Tag } from './ui/Tag.js'
import { deleteSessionFromMenu } from './write-seats.js'

/**
 * 被操作对象那张卡。`Modal`（`ui/Modal.tsx`，照官方抄的）的 `.sd-modal-body` 不设字号也不给层级 ⇒ 裸摆一行会话标题会和下面那句
 * 提示**同字同色**，读不出"这才是要被删的东西"。配方与「彻底删除」框里那张摘要卡同一套（宿主设置面
 * 的卡片 token：`bg-layer-2` + `border-l4` + `radius-lg`），两个对话框因此同形。
 * 浅色下 `bg-layer-2` 与对话框自身同色，分隔全靠那根描边——宿主自己的卡片在浅色下也是这样。
 */
export const TARGET_CARD = {
  padding: '10px 12px',
  background: 'var(--dsw-alias-bg-layer-2)',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 'var(--dsw-radius-lg)',
} as const

/** 菜单行写进现场的一条删除请求（槽位投影原样带过来，浏览器半不自己拼 id）。 */
export interface DeleteRequest {
  /** 每次发布递增：换一个会话就重挂载确认框，busy / failure 不带着上一条请求的记忆。 */
  seq: number
  /** 要删的会话 id——原样透给 `sessiondelete/delete`。 */
  sessionId: string
  /** 删除那一刻的会话名（槽位投影的 `displayTitle`）：只用于确认框文案与撤销提示。 */
  title: string
}

const requestStore = createStore<DeleteRequest | null>(null)

/** 菜单行调用：请求删除这个会话（确认框由 overlay 上的宿主渲染）。 */
export function requestDelete(input: { sessionId: string; title: string }): void {
  requestStore.publish((seq) => ({ seq, sessionId: input.sessionId, title: input.title }))
}

/** 收起确认框（用户点「取消」/「关闭」、或删除成功后收工）。 */
function clearDeleteRequest(): void {
  requestStore.set(null)
}

/** 供宿主组件订阅。 */
export function useDeleteRequest(): DeleteRequest | null {
  return requestStore.use()
}

/** 测试专用：现场与 seq 归零，用例之间互不串味。 */
export function resetDeleteRequest(): void {
  requestStore.reset()
}

/**
 * 常驻的确认框宿主。挂 `shell.overlay`（框架级浮层；槽位说明原文 "a toast stack or a status
 * pill all belong here"）：没有待确认的删除时什么都不渲染。
 */
export function DeleteConfirmHost({ deps, t = zhTranslate }: { deps: DeleteConfirmDeps; t?: Translate }) {
  const current = useDeleteRequest()
  if (current === null) return null
  // `key` 跟着 seq 走：新的一条请求是一个全新的对话框（官方 `Toast` 的 `key={seq}` 同一口径）。
  return <ConfirmDialog key={current.seq} request={current} deps={deps} t={t} />
}

/**
 * 确认框本体。视图与文案与 docs/ui-spec.md 一致（`Modal` + `variant="primary"` 主按钮「移入回收站」；
 * 那个 primary 在宿主浅色下是近黑、深色下近白，**从来不是蓝**）。
 * 失败面**不吞**：原文以 `Tag tone="danger"` 摆进对话框，且**确认失败后不关框**，
 * 用户可以再点一次（不是一次失败就永久锁死）。
 */
function ConfirmDialog({
  request: current,
  deps,
  t,
}: {
  request: DeleteRequest
  deps: DeleteConfirmDeps
  t: Translate
}) {
  /** 这一趟的闸：写入座位把 apply → 收尾 → 重读整趟包在里面，`busy` 期间主按钮按住。 */
  const gate = useBusyGate()
  const { close, closeDisabled } = useIdleClose(gate.busy, clearDeleteRequest)
  const [failure, setFailure] = useState<string | null>(null)
  /**
   * 这条会话在盘上带着多少个后代。删除是按组走的（组语义见 `src/trash/groups.ts`），而宿主的客户端本来就把孩子那几行
   * 整排藏了 ⇒ 不说就没人知道点下去侧栏会少一片（issue #3）。那一刻它还没进回收站，清单里没有它，
   * 所以只能现问一次。
   */
  const [subagents, setSubagents] = useState(0)

  useEffect(() => {
    let alive = true
    void (async () => {
      const outcome = await callRemote(() => applyOne(deps, 'count', current.sessionId).then((item) => item.value))
      // 读不到就**不说那半句**（0 也是"没说"）：它是加法，一次取数失败不许锁死删除按钮，
      // 也不许把"读不出"写成"它没有子会话"那种假话。
      if (alive) setSubagents(outcome.ok ? outcome.value : 0)
    })()
    return () => { alive = false }
  }, [deps, current.sessionId])

  const confirm = async (): Promise<void> => {
    setFailure(null)
    const failure = await deleteSessionFromMenu(
      deps,
      { sessionId: current.sessionId, title: current.title },
      gate,
    )
    if (failure !== null) {
      setFailure(failure)
      return
    }
    clearDeleteRequest()
  }

  return (
    <Modal
      open
      onClose={close}
      title={t('dialog.title')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="outline" disabled={closeDisabled} onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={gate.busy} onClick={() => void confirm()}>
            {t('dialog.confirm')}
          </Button>
        </>
      }
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
    </Modal>
  )
}
