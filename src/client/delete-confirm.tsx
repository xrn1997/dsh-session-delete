/**
 * 「删除」的确认框——**挂在 `shell.overlay` 上的宿主组件**，加它读的那个模块级现场。
 *
 * 为什么确认框不能住在菜单行里（这是本文件存在的唯一理由）：**宿主的菜单行随菜单一起卸载**。
 * 真产物 `Menu` 的渲染是
 * `const list = open && jsxs(MenuSurface, { … children: [items.map(renderEntry), children] })`
 * （asar @22074291 逐字；`children` 就是本插件那一行所在的槽位投影）——`open === false` 时
 * **槽位行根本不渲染**，行连同它的整棵子树卸载。而按官方契约，按下这一行先 `setMenuOpen(false)`
 * 收起菜单正是正解（官方 README 的第三方行示例逐字 `onSelect={() => { setMenuOpen(false); … }}`，
 * 宿主自己的 pin / rename / fork / archive 四行同样这么做）。两条一起成立 ⇒ 确认框若住在行里，
 * 它会在菜单收起的那一帧被**连坐卸载**（`createPortal` 只改 DOM 归属，**不改 React 生命周期**），
 * 真机上「移入回收站」永远点不到。
 *
 * 所以按宿主自己的配方把"请求"与"确认"拆开（同一条路：宿主对会话行的撤销提示就是这么做的，
 * `ctx.slots.inject("shell.overlay", … id: "workspace.row-toast" …, RowActionToast)`）：
 *
 * - **菜单行只发请求**：`DeleteMenuItem` 把 `{ sessionId, title }` 写进本文件的模块级现场；
 * - **确认框由本文件的宿主渲染与提交**：`DeleteConfirmHost` 挂在 `shell.overlay` 上，从现场读请求，
 *   自己持有 busy / failure。于是「提交删除 → 失败原文上屏 → 再点一次重试 → 成功后发撤销提示」
 *   整条链路都在菜单子树之外，菜单关不关都不影响它。
 *
 * 现场是**模块级**的（本仓既有的客户端模式：视图内路由与跨卸载的现场都住在模块级 store，
 * 见 `undo-toast.tsx`），状态源用 React 自带的 `useSyncExternalStore`——不为此引新的状态库。
 */
import { useState, useSyncExternalStore } from 'react'
import { zhTranslate, type Translate } from './copy.js'
import { callRemote, type DeleteConfirmDeps } from './remote.js'
import { invalidateTrash } from './trash-store.js'
import { Button } from './ui/Button.js'
import { Modal } from './ui/Modal.js'
import { Tag } from './ui/Tag.js'
import { publishUndoNotice } from './undo-toast.js'

/**
 * 被操作对象那张卡。`Modal`（`ui/Modal.tsx`，照官方抄的）的 `.sd-modal-body` 不设字号也不给层级 ⇒ 裸摆一行会话标题会和下面那句
 * 提示**同字同色**，读不出"这才是要被删的东西"。配方与「彻底删除」框里那张摘要卡同一套（宿主设置面
 * 的卡片 token：`bg-layer-2` + `border-l4` + `radius-lg`），两个对话框因此同形。
 * 浅色下 `bg-layer-2` 与对话框自身同色，分隔全靠那根描边——宿主自己的卡片在浅色下也是这样。
 */
const TARGET_CARD = {
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

let request: DeleteRequest | null = null
let nextSeq = 0
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const listener of listeners) listener()
}

/** 菜单行调用：请求删除这个会话（确认框由 overlay 上的宿主渲染）。 */
export function requestDelete(input: { sessionId: string; title: string }): void {
  request = { seq: (nextSeq += 1), sessionId: input.sessionId, title: input.title }
  emit()
}

/** 收起确认框（用户点「取消」/「关闭」、或删除成功后收工）。 */
export function clearDeleteRequest(): void {
  if (request === null) return
  request = null
  emit()
}

function getDeleteRequest(): DeleteRequest | null {
  return request
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 供宿主组件订阅。 */
export function useDeleteRequest(): DeleteRequest | null {
  return useSyncExternalStore(subscribe, getDeleteRequest, getDeleteRequest)
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
 * 确认框本体。视图与文案与设计稿 §7 一致（`Modal` + `variant="primary"` 主按钮「移入回收站」；
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
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const outcome = await callRemote(() => deps.delete(current.sessionId))
    setBusy(false)
    if (!outcome.ok) {
      setFailure(outcome.failure.message)
      return
    }
    clearDeleteRequest()
    // 回收站多了一条：让正开着的清单面板重读（它挂载时只取一次数，见 trash-store.ts 头注）。
    invalidateTrash()
    publishUndoNotice({ entryId: outcome.value.id, title: current.title })
  }

  return (
    <Modal
      open
      onClose={clearDeleteRequest}
      title={t('dialog.title')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="outline" onClick={clearDeleteRequest}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void confirm()}>
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
      <p>{t('dialog.hint')}</p>
      {failure === null ? null : <Tag tone="danger">{failure}</Tag>}
    </Modal>
  )
}
