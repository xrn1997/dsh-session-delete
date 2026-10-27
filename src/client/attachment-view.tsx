/**
 * 回收站详情与设置页维护卡预览里的一条附件：图片给缩略图 + 放大框，普通文件给下载 chip。
 *
 * 三条口径：
 * - **地址只由 `attachmentId` + `kind` 拼**：`/attachment` 段只认这两个参数寻址（`name` 只做下载名建议，
 *   不参与路径推导，见 `src/api/attachment.ts`）。空串与缺席同义——空串不是一个名字，不写进查询串。
 * - **图裂了就换占位**：缩略图与放大框共用同一份 `failed` 集合，`onError` 之后这一格改成「附件不可用」，
 *   不把破图留在屏上（放大框里裂了也换）。普通文件走 `<a download>`，没有页面内失败面：服务端失败回
 *   200 + JSON 信封，浏览器可能把这份错误响应存成文件。
 * - **放大框复用 `Modal`**：Escape、焦点归位、蒙层点击三件事都在那里，不另造一层浮层。
 *
 * 附件是**消息的一部分**，不单开一等区块：调用面把 `AttachmentStrip` 摆在自己那一行的位置
 * （用户：气泡之上；助手：Markdown 之后），并用 `align` 说自己那一行朝哪边靠——用户行右对齐
 * （气泡那一侧），助手行左对齐（正文那一侧）。条本身不自认角色，对齐由调用面给。
 */
import { useState, type CSSProperties } from 'react'
import { PARAMS, ROUTES, SESSION_DELETE_API_PREFIX, type TrashDetailAttachmentWire } from '../shared/wire.js'
import type { Translate } from './copy.js'
import { Button } from './ui/Button.js'
import { CARD } from './trash-view.js'
import { Modal } from './ui/Modal.js'
import { fileSizeText } from './ui/format.js'
import { IconWarningOutlineRegular } from './ui/icons.js'

/**
 * 一张附件的取数地址。**只从校验过的 id 与 kind 派生**：不接受路径、不接受任意查询串，
 * 所以调用面把 URL 交给 `<img src>` / `<a href>` 时不存在"读任意文件"的入口。
 */
export function attachmentUrl(a: TrashDetailAttachmentWire): string {
  const query = new URLSearchParams({
    [PARAMS.attachmentId]: a.attachmentId,
    [PARAMS.attachmentKind]: a.kind,
  })
  if (a.kind === 'file' && a.name !== undefined && a.name !== '') {
    query.set(PARAMS.attachmentName, a.name)
  }
  return `${SESSION_DELETE_API_PREFIX}${ROUTES.attachment}?${query.toString()}`
}

/** 空串与缺席同义：宿主侧的 `name` 是可选建议名，空串不是名字（兜底文案与"不带 name 查询"都看它）。 */
function nameOf(a: TrashDetailAttachmentWire): string | undefined {
  return a.name === undefined || a.name === '' ? undefined : a.name
}

const IMAGE_BUTTON: CSSProperties = {
  display: 'block',
  padding: 0,
  border: 0,
  background: 'none',
  cursor: 'zoom-in',
  maxWidth: '100%',
}

const THUMB: CSSProperties = {
  display: 'block',
  maxWidth: '100%',
  maxHeight: 260,
  // 缩略图框有上限，画面按 contain 收进去而不是被裁掉一角：缩略图用来认出这张图，不是裁切预览。
  objectFit: 'contain',
  borderRadius: 'var(--dsw-radius-lg)',
  background: 'var(--dsw-alias-bg-layer-2)',
}

const FILE_CHIP: CSSProperties = {
  display: 'inline-block',
  maxWidth: '100%',
  // 文件名是宿主日志里的自由文本：长名字要能折行，别把消息条撑破。
  wordBreak: 'break-all',
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
  textDecoration: 'underline',
}

const UNAVAILABLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  color: 'var(--dsw-alias-label-tertiary)',
}

/**
 * 图裂之后的占位。**仍然说清是哪一件**：名字（没有就用「附件图片」/「文件」）+ 体量 + 「附件不可用」。
 * 只剩一句「附件不可用」等于把"哪张图没了"也一起丢了。
 */
function Unavailable({ attachment, t }: { attachment: TrashDetailAttachmentWire; t: Translate }) {
  const label =
    nameOf(attachment) ??
    (attachment.kind === 'file' ? t('detail.attachment.file') : t('detail.attachment.alt'))
  return (
    <span style={UNAVAILABLE}>
      <IconWarningOutlineRegular size={13} />
      <span style={{ wordBreak: 'break-all' }}>{label}</span>
      <span>{fileSizeText(attachment.bytes)}</span>
      <span>{t('detail.attachment.unavailable')}</span>
    </span>
  )
}

/**
 * 一条消息的全部附件。顺序照日志，不重排：用户先发图后发文件，读起来应是他当时的顺序。
 *
 * `align` 是这一行的对齐（默认 `end`，与用户气泡同侧）：用户行靠右、助手行靠左，条跟着自己那条消息走。
 * `failed` 按 `attachmentId` 记：同一个内容哈希在一段会话里可能被引用多次，裂一次就都不再画破图。
 * 四个 `useState` 都在早退之前调用——附件从有到无时 hook 数量不变。
 */
export function AttachmentStrip({
  attachments,
  t,
  align = 'end',
}: {
  attachments: readonly TrashDetailAttachmentWire[]
  t: Translate
  /** `end`（默认）= 靠右，用户气泡那一侧；`start` = 靠左，助手正文那一侧。 */
  align?: 'start' | 'end'
}) {
  const [preview, setPreview] = useState<TrashDetailAttachmentWire | null>(null)
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  if (attachments.length === 0) return null
  const markFailed = (id: string) => setFailed((prev) => new Set(prev).add(id))
  const openPreview = (attachment: TrashDetailAttachmentWire): void => {
    setPreview(attachment)
    setSaveError(null)
    setSaving(false)
  }
  const closePreview = (): void => {
    setPreview(null)
    setSaveError(null)
    setSaving(false)
  }
  /**
   * 另存为：先把字节取回来拿到真实 `Content-Type`，再用 blob URL + `download` 落盘。
   * 不直接把 `<a download>` 指到 `/attachment`：图片响应是 inline，且仓库里没有原始扩展名，
   * 直接下载会得到没有扩展名的哈希文件。这里按响应类型补 `.png/.jpg/.webp/.gif`。
   */
  const savePreview = async (attachment: TrashDetailAttachmentWire): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    try {
      const response = await fetch(attachmentUrl(attachment))
      const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim()
      if (!response.ok || !contentType.startsWith('image/')) {
        // 操作失败是 200 + JSON 信封：这里是 fetch，能把服务端原文拿出来，不把「HTTP 200」当原因。
        let message = `HTTP ${String(response.status)}`
        if (contentType === 'application/json') {
          try {
            const body = await response.json() as { error?: { message?: unknown } }
            if (typeof body.error?.message === 'string' && body.error.message !== '') message = body.error.message
          } catch {
            // 不是信封：保留状态码。
          }
        }
        throw new Error(message)
      }
      const blob = await response.blob()
      const ext = contentType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin'
      const base = nameOf(attachment) ?? `attachment-${attachment.attachmentId.slice(7, 15)}`
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = /\.\w+$/u.test(base) ? base : `${base}.${ext}`
      document.body.appendChild(link)
      link.click()
      link.remove()
      // 捕获函数引用再延迟释放：测试/宿主可能在本拍之后换掉全局 URL，闭包里别再查一次。
      const revoke = URL.revokeObjectURL
      if (typeof revoke === 'function') setTimeout(() => revoke.call(URL, objectUrl), 0)
    } catch (error) {
      setSaveError(
        t('detail.attachment.saveFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    } finally {
      setSaving(false)
    }
  }
  return (
    <>
      <div
        data-sd-attachment-strip
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          justifyContent: align === 'start' ? 'flex-start' : 'flex-end',
          minWidth: 0,
        }}
      >
        {attachments.map((a, index) => {
          const key = `${a.attachmentId}:${String(index)}`
          const name = nameOf(a)
          if (a.kind === 'file') {
            return (
              <a key={key} href={attachmentUrl(a)} download={name ?? ''} style={FILE_CHIP}>
                {name ?? t('detail.attachment.file')} · {fileSizeText(a.bytes)}
              </a>
            )
          }
          if (failed.has(a.attachmentId)) {
            return (
              <span key={key}>
                <Unavailable attachment={a} t={t} />
              </span>
            )
          }
          const alt = name ?? t('detail.attachment.alt')
          return (
            <button
              key={key}
              type="button"
              style={IMAGE_BUTTON}
              aria-label={t('detail.attachment.open', { name: alt })}
              onClick={() => openPreview(a)}
            >
              {/* 缩略图懒加载：一段会话可能带几十张图，屏外的先不取；放大框那张不带 lazy（点开就要图）。 */}
              <img
                src={attachmentUrl(a)}
                alt={alt}
                loading="lazy"
                style={THUMB}
                onError={() => markFailed(a.attachmentId)}
              />
            </button>
          )
        })}
      </div>
      <Modal
        open={preview !== null}
        onClose={closePreview}
        title={preview === null ? t('detail.attachment.preview') : nameOf(preview) ?? t('detail.attachment.preview')}
        closeLabel={t('common.close')}
        footer={
          preview === null ? undefined : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
              <span
                style={{
                  flex: '1 1 auto',
                  minWidth: 0,
                  fontSize: 12,
                  lineHeight: '17px',
                  color: 'var(--dsw-alias-state-error-primary)',
                  wordBreak: 'break-word',
                }}
              >
                {saveError ?? ''}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={() => void savePreview(preview)}
              >
                {saving ? t('detail.attachment.saving') : t('detail.attachment.save')}
              </Button>
            </div>
          )
        }
      >
        {preview === null ? null : failed.has(preview.attachmentId) ? (
          <Unavailable attachment={preview} t={t} />
        ) : (
          <img
            src={attachmentUrl(preview)}
            alt={nameOf(preview) ?? t('detail.attachment.alt')}
            style={{ display: 'block', maxWidth: '100%', maxHeight: '80vh', margin: '0 auto' }}
            onError={() => markFailed(preview.attachmentId)}
          />
        )}
      </Modal>
    </>
  )
}

/**
 * 附件清理回执那一行提示（「N 个附件未能清理」/「附件未清理：原因」）。表现层只收一句已经拼好的话；
 * 什么时候该有这句话、失败与跳过怎么拼，归接线的那一侧（判据住 `receipt.ts` 与 `use-trash-query.ts`）。
 */
export function AttachmentNotice({ message }: { message: string | null }) {
  if (message === null) return null
  return (
    <div role="status" style={{ ...CARD, alignItems: 'flex-start', gap: 10, marginBottom: 10, padding: '10px 12px' }}>
      <span style={{ display: 'inline-flex', flex: 'none', color: 'var(--dsw-alias-state-warn-primary)' }} aria-hidden="true">
        <IconWarningOutlineRegular size={15} />
      </span>
      <span style={{ flex: '1 1 auto', minWidth: 0, wordBreak: 'break-word', fontSize: 12, lineHeight: '17px' }}>
        {message}
      </span>
    </div>
  )
}
