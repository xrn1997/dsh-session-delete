/**
 * 六个确认框共用的**一个壳**：`Modal` + 标题 + 关闭钮 + 「取消（描边） / 确认（主按钮）」页脚。
 *
 * 共用的只有**页脚与关框规则**（`useIdleClose`：在飞时取消与关闭都按住），不共用业务：每个框的
 * 标题、正文、列什么、确认键文案与危险层级都由调用方交，各框自己的状态机与失败面一行业没少。
 * 曾经在 `batch-confirm.tsx` 的头注里否过一次共壳——那时否的是把单删的 `busy` / 失败面拖进批量形；
 * 这里共的是页脚这一层，裁决见 ADR-0052。
 */
import type { ReactNode } from 'react'
import { useIdleClose } from './confirm-close.js'
import { BULK_DANGER } from './trash-view.js'
import { Button } from './ui/Button.js'
import { Modal } from './ui/Modal.js'

export interface ConfirmDialogProps {
  readonly title: string
  readonly closeLabel: string
  readonly cancelLabel: string
  readonly confirmLabel: string
  /** 在飞：取消 / 关闭与确认键一起按住。 */
  readonly busy: boolean
  readonly onCancel: () => void
  readonly onConfirm: () => void
  /** 危险层级：实心红主按钮；缺省是普通 primary（与「移入回收站」同款）。 */
  readonly danger?: boolean
  readonly children?: ReactNode
}

export function ConfirmDialog({
  title,
  closeLabel,
  cancelLabel,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
  danger = false,
  children,
}: ConfirmDialogProps): ReactNode {
  const { close, closeDisabled } = useIdleClose(busy, onCancel)
  return (
    <Modal
      open
      onClose={close}
      title={title}
      closeLabel={closeLabel}
      footer={
        <>
          <Button variant="outline" disabled={closeDisabled} onClick={close}>
            {cancelLabel}
          </Button>
          <Button
            variant="primary"
            {...(danger ? { style: BULK_DANGER } : {})}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  )
}
