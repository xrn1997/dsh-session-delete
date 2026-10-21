/**
 * 回收站的**详情块**（docs/ui-spec.md 的四态）。
 *
 * 它**不自己取数**：选中、缓存、失败与重读全在面板控制器（`use-trash-panel-controller.ts`）手里，
 * 这里只把一个状态画出来——
 * 所以它能被单独测穿（喂四种状态，断四张形状）。
 *
 * 三个不能让步的点：
 * ① **动作不住在这里**（2026-10-15 真机反馈后定，与 2026-10-01 那版同形）：「恢复」「彻底删除…」
 *    在清单行右侧。搬进详情那一阵子，左栏为了只放标题被压到 316px，读起来就是"左侧太窄"——
 *    动作回行内之后左栏需要的宽度也回来了（420px，理由写在面板常量处）。
 * ② **标题优先用清册那一份**：保证「行里叫 A、点开也叫 A」，清册标题是空串才回落到日志里的
 *    `session/title`。
 * ③ **注入条数与截断条数必须上屏**：正文比日志里的 `user/message` 少一大截是**过滤的结果**，
 *    页面上要说清少掉的是什么、多少条，不能让它读起来像"这条会话就这么点内容"。
 *
 * 皮肤**只由 token 决定**，且 token 与消息行的声明都来自宿主自己那两张表（`MessageItem.module.css` /
 * `AssistantMarkdown.module.css` / `MarkdownText.module.css`，逐字抄，来源与差异记在 `ui/markdown.css`
 * 文件头）——字号一律走 `--dsh-content-font-*` 那根轴，不再写宿主同类面的字面量 px。
 * **助手正文走 Markdown，用户提问走原话**（2026-10-15 真机反馈后改；见 `markdown.tsx` 那三行收口）：
 * 助手的 `text` 段本身就是 markdown 源，用 `pre-wrap` 摆出来就是用户说的"对话内容没渲染、是一整块纯文本"。
 */
import { type CSSProperties } from 'react'
import { absoluteText, agoText, type Translate } from './copy.js'
import type { TrashDetailLike, TrashEntryLike } from './remote.js'
import { MarkdownBody } from './markdown.js'
import { Button } from './ui/Button.js'
import { fileSizeText } from './ui/format.js'
import { IconWarningOutlineRegular } from './ui/icons.js'
import { ELLIPSIS, QUIET_DANGER } from './ui/recipe.js'

export type TrashDetailState =
  | { kind: 'idle' }
  | { kind: 'loading'; entry: TrashEntryLike }
  | { kind: 'failed'; entry: TrashEntryLike; message: string }
  | { kind: 'ready'; entry: TrashEntryLike; detail: TrashDetailLike }

export interface TrashDetailProps {
  state: TrashDetailState
  /** 有写操作在飞（动作按钮住在清单行里，这里只用来把「重试」按住）。 */
  busy: boolean
  /** 宽档不画返回——同屏就有清单，返回是多余的一步。 */
  wide: boolean
  onRetry: () => void
  onBack: () => void
  t: Translate
}

const SHELL: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  boxSizing: 'border-box',
  height: '100%',
  minWidth: 0,
}

const HEAD: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 10 }

/** 元信息那张表：label 一列、值一列，窄档也不横向溢出。 */
const META: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  gap: '3px 12px',
  margin: 0,
  fontSize: 12,
  lineHeight: '17px',
}

const META_LABEL = { color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' } as CSSProperties

const META_VALUE = { margin: 0, minWidth: 0, wordBreak: 'break-word' } as CSSProperties

/**
 * 线程的行距取宿主那两档里的 12px 那档（`ChatView.module.css` 的 `--dsh-chat-flow-gap`：默认 6px，
 * **换轮**之后 12px）。我们的线程里相邻两条必然换轮（一问一答），所以落在 12 这一档。
 */
const THREAD: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }

/**
 * 消息行照宿主拄（2026-10-15 真机反馈后重写；来源 `app.asar` 里
 * `@deepseek-ai/dsh-client-ui-chat/lib/client.js` 内联的 `MessageItem.module.css` 与
 * `AssistantMarkdown.module.css`，逐字声明）。两条关键事实：
 * **只有用户有气泡**，助手那侧宿主不铺底、不给边框，正文直接铺满栏——上一版给助手画了带边框的卡片，
 * 就是"右侧 UI 风格问题很多"里最难看的那一处。字号也不再用字面量：走 `--dsh-content-font-size` 那根轴，
 * 宿主调内容字号时这里一起动。
 */
const USER_ROW: CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, minWidth: 0 }

const ASSISTANT_ROW: CSSProperties = { display: 'flex', flexDirection: 'column', minWidth: 0 }

/**
 * 宿主是 `.userRow > .userStack > .bubble` 三层，`min(内容宽 × .702, 82%)` 这个上限住在中间那层；
 * 我们一行只有一个气泡，直接把上限挂在气泡上（同一父宽下百分比与 `min()` 的结果一致，少一层）。
 */
const BUBBLE: CSSProperties = {
  background: 'var(--dsw-specific-bubble)',
  borderRadius: 'var(--dsw-radius-xl)',
  maxWidth: 'min(calc(var(--dsh-chat-content-width, 748px) * .702), 82%)',
  fontSize: 'var(--dsh-content-font-size, 14px)',
  lineHeight: 'calc(22px + var(--dsh-content-font-delta, 0px))',
  color: 'var(--dsw-alias-label-primary)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  padding: '10px 16px',
  boxSizing: 'border-box',
}

/** 宿主的次级行字阶（`.referenceSummary` / `.retryRow` 那一族）：角色与时间就归它，不再自造 11px。 */
const META_LINE: CSSProperties = {
  fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
  lineHeight: 'calc(18px + var(--dsh-content-font-delta-secondary, 0px))',
  color: 'var(--dsw-alias-label-tertiary)',
}

/** 读失败与写失败共用的那块（`role="status"`：读屏走到这里会当状态消息念）。 */
const STATUS_BLOCK: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  padding: '12px 14px',
  background: 'var(--dsw-alias-bg-layer-2)',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 'var(--dsw-radius-lg)',
}

const HOUR = 3600000
const DAY = 86400000

/** 日志里那两个时间戳缺省时的降级（`src/trash/detail.ts` 把初值写成 0，读不到就是 0）。 */
function timeText(ms: number): string {
  return ms === 0 ? '—' : absoluteText(ms)
}

/** 活跃跨度：不足一天给小时，超过给天——都是"这条会话活了多久"这一个问题的答案。
 *  两端任一缺省就**不答**：`Math.max(1, …)` 会把"不知道"报成"1 小时"，那是一条编出来的账。 */
function spanText(from: number, to: number, t: Translate): string | undefined {
  if (from === 0 || to === 0) return undefined
  const ms = Math.max(0, to - from)
  return ms < DAY
    ? t('detail.value.spanHours', { n: Math.max(1, Math.round(ms / HOUR)) })
    : t('detail.value.spanDays', { n: Math.round(ms / DAY) })
}

/** 详情头部显示的那句标题：清册优先，空串才回落到日志里的 `session/title`。 */
function titleOf(entry: TrashEntryLike, detail: TrashDetailLike | undefined, t: Translate): string {
  if (entry.title !== '') return entry.title
  if (detail !== undefined && detail.logTitle !== '') return detail.logTitle
  return t('common.untitled')
}

export function TrashDetail({ state, busy, wide, onRetry, onBack, t }: TrashDetailProps) {
  if (state.kind === 'idle') {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          padding: '24px',
          textAlign: 'center',
          fontSize: 12.5,
          lineHeight: '18px',
          color: 'var(--dsw-alias-label-tertiary)',
        }}
      >
        {t('detail.notSelected')}
      </div>
    )
  }

  const entry = state.entry
  const detail = state.kind === 'ready' ? state.detail : undefined

  return (
    <div style={SHELL}>
      <div style={HEAD}>
        {wide ? null : (
          <Button variant="ghost" size="sm" style={{ flex: 'none' }} onClick={onBack}>
            {t('detail.back')}
          </Button>
        )}
        <div style={{ minWidth: 0 }}>
          <div style={{ ...ELLIPSIS, fontSize: 15, fontWeight: 600, lineHeight: '22px' }} title={titleOf(entry, detail, t)}>
            {titleOf(entry, detail, t)}
          </div>
        </div>
      </div>

      {state.kind === 'loading' ? <LoadingBody t={t} /> : null}

      {state.kind === 'failed' ? (
        <div role="status" style={STATUS_BLOCK}>
          <span
            style={{ display: 'inline-flex', flex: 'none', paddingTop: 2, ...QUIET_DANGER }}
            aria-hidden="true"
          >
            <IconWarningOutlineRegular size={16} />
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 auto', minWidth: 0 }}>
            <div style={{ fontSize: 13, lineHeight: '19px' }}>{t('detail.readFailed')}</div>
            <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-word' }}>
              {state.message}
            </div>
          </div>
          <Button variant="outline" size="sm" style={{ flex: 'none' }} disabled={busy} onClick={onRetry}>
            {t('common.retry')}
          </Button>
        </div>
      ) : null}

      {detail === undefined ? null : <ReadyBody entry={entry} detail={detail} t={t} />}
    </div>
  )
}

/** 读数中：一句"正在读" + 骨架几条。不给百分比（本机量级是"一条 135ms"，给进度是假话）。 */
function LoadingBody({ t }: { t: Translate }) {
  return (
    <>
      <div style={{ fontSize: 12.5, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }}>
        {t('detail.loading')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {([70, 96, 52, 88, 34] as const).map((percent, index) => (
          <div
            key={index}
            style={{
              height: 11,
              width: `${percent}%`,
              borderRadius: 6,
              background: 'var(--dsw-alias-bg-layer-2)',
            }}
          />
        ))}
      </div>
    </>
  )
}

function Meta({ label, title, children }: { label: string; title?: string; children: string }) {
  return (
    <>
      <dt style={META_LABEL}>{label}</dt>
      <dd style={META_VALUE} title={title}>{children}</dd>
    </>
  )
}

/**
 * 有内容：元信息（时间 → 体量 → 位置三组的顺序）+ 正文。
 *
 * 计数与正文**同源**：`提问`/`回复` 就是进了正文的那两类条数，不是日志里的 `user/message` 总数——
 * 后者被 `injectedCount` 单独说清，页面上不出现两本对不上的账。
 */
function ReadyBody({ entry, detail, t }: { entry: TrashEntryLike; detail: TrashDetailLike; t: Translate }) {
  // 回收站的目录名就是条目 id（CONTEXT.md 的「条目」条），转义那部分不承载额外信息 ⇒ 原样摆，完整串交给 title。
  const folder = entry.id
  const project = detail.cwd === '' ? t('trash.project.unknown') : detail.cwd
  return (
    <>
      <dl style={META}>
        <Meta label={t('detail.field.created')}>{timeText(detail.createdAt)}</Meta>
        <Meta label={t('detail.field.lastActivity')}>{timeText(detail.lastActivity)}</Meta>
        <Meta label={t('detail.field.span')}>{spanText(detail.createdAt, detail.lastActivity, t) ?? '—'}</Meta>
        {/* 「删除于」两样都要（docs/ui-spec.md 状态⑥）：相对那句好读，绝对那句好核对。 */}
        <Meta label={t('detail.field.deletedAt')}>
          {`${agoText(entry.deletedAt, Date.now(), t)}（${absoluteText(entry.deletedAt)}）`}
        </Meta>
        <Meta label={t('detail.field.size')}>{fileSizeText(entry.sizeBytes)}</Meta>
        <Meta label={t('detail.field.turns')}>{String(detail.turnCount)}</Meta>
        <Meta label={t('detail.field.userMessages')}>{String(detail.userMessageCount)}</Meta>
        <Meta label={t('detail.field.assistantMessages')}>{String(detail.assistantMessageCount)}</Meta>
        <Meta label={t('detail.field.toolCalls')}>{String(detail.toolCallCount)}</Meta>
        <Meta label={t('detail.field.models')}>{detail.models.join(', ') || '—'}</Meta>
        <Meta label={t('detail.field.project')} title={project}>{project}</Meta>
        <Meta label={t('detail.field.sessionId')} title={entry.sessionId}>{entry.sessionId}</Meta>
        <Meta label={t('detail.field.trashDir')} title={folder}>{folder}</Meta>
        <Meta label={t('detail.field.wasArchived')}>
          {entry.wasArchived ? t('detail.value.yes') : t('detail.value.no')}
        </Meta>
      </dl>

      <div style={META_LINE}>
        {detail.injectedCount > 0 ? t('detail.messages.hidden', { count: detail.injectedCount }) : ''}
        {detail.omittedByPayloadCap > 0
          ? `${detail.injectedCount > 0 ? ' · ' : ''}${t('detail.messages.omitted', { count: detail.omittedByPayloadCap })}`
          : ''}
      </div>

      {detail.messages.length === 0 ? (
        <div style={META_LINE}>{t('detail.noBody')}</div>
      ) : (
        <div style={THREAD}>
          {detail.messages.map((message, index) => (
            <div
              key={`${message.time}-${index}`}
              data-sd-msg={message.role}
              style={message.role === 'user' ? USER_ROW : ASSISTANT_ROW}
            >
              <div style={META_LINE}>
                {`${message.role === 'user' ? t('detail.role.user') : t('detail.role.assistant')} · ${timeText(message.time)}`}
              </div>
              {/* 助手的 `text` 段本身就是 markdown 源，照宿主那样渲；**用户的提问是原话**，
                  渲成 markdown 会把"我打过的那串反斜杠"改掉样子——所以只有助手侧过 MarkdownBody。 */}
              {message.role === 'user' ? (
                <div data-sd-bubble style={BUBBLE}>
                  {message.text}
                  {message.truncated ? '…' : ''}
                </div>
              ) : (
                <>
                  <MarkdownBody text={message.text} />
                  {message.truncated ? <div style={META_LINE}>…</div> : null}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
