/**
 * 回收站详情块：只画状态，不取数。选中、缓存、失败与重读都在面板控制器里。
 *
 * 三条界面约束：
 * - 动作（恢复/彻底删除）留在清单行右侧；详情只负责看。
 * - 标题优先用清册标题，空串才回落到日志的 session/title。
 * - 正文是**块**：用户/助手文字常显；思考、工具、注入、系统消息、压缩摘要默认折叠，折叠头给
 *   标签 + 首行摘要（工具另给状态）。注入也铺进正文——这是对宿主 Chat 的有意偏离（它隐藏普通注入，
 *   而这里的目标是「删之前看全」）；条数另进元信息表。
 *
 * 助手正文与思考走 Markdown，用户提问保持原话；工具参数/结果走等宽纯文本（限高可滚）。
 * 附件随块位置渲染：用户气泡之上、助手正文之后、工具展开体末尾。
 */
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { AttachmentStrip } from './attachment-view.js'
import { absoluteText, agoText, type CopyKey, type Translate } from './copy.js'
import type { TrashDetailBlockWire, TrashDetailInjectionBlockWire, TrashDetailTextBlockWire } from '../shared/wire.js'
import type { TrashDetailLike, TrashEntryLike } from './remote.js'
import { MarkdownBody } from './markdown.js'
import { Button } from './ui/Button.js'
import { fileSizeText } from './ui/format.js'
import {
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconWarningOutlineRegular,
} from './ui/icons.js'
import { ELLIPSIS, QUIET_DANGER } from './ui/recipe.js'

export type TrashDetailState =
  | { kind: 'idle' }
  | { kind: 'loading'; entry: TrashEntryLike }
  | { kind: 'failed'; entry: TrashEntryLike; message: string }
  | { kind: 'ready'; entry: TrashEntryLike; detail: TrashDetailLike }

/** 「加载更早」这一块（在飞/失败 + 滚动容器）整体过手：`TrashDetail` 只转交，谁画正文谁拆开用。
 *  四样东西是一个概念（分页读面）的四个格子，打包走一个名字，不再逐样穿透组件边界。 */
export interface DetailPager {
  /** 更早一页正在读。 */
  loadingOlder: boolean
  /** 更早一页读失败的原文；正文本身仍是 ready。 */
  olderFailure: string | null
  onLoadOlder: () => void
  /** 详情栏的滚动容器；prepend 更早一页后按高度差补偿滚动位置。 */
  scrollRef?: RefObject<HTMLDivElement | null>
}

export interface TrashDetailProps {
  state: TrashDetailState
  /** 有写操作在飞（动作按钮住在清单行里，这里只用来把「重试」按住）。 */
  busy: boolean
  /** 宽档不画返回——同屏就有清单，返回是多余的一步。 */
  wide: boolean
  onRetry: () => void
  onBack: () => void
  pager: DetailPager
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
 * 消息行照宿主抄（来源 `app.asar` 里
 * `@deepseek-ai/dsh-client-ui-chat/lib/client.js` 内联的 `MessageItem.module.css` 与
 * `AssistantMarkdown.module.css`，逐字声明）。两条关键事实：
 * **只有用户有气泡**，助手那侧宿主不铺底、不给边框，正文直接铺满栏；给助手画带边框的卡片
 * 会与宿主消息行不同形。字号走 `--dsh-content-font-size` 那根轴，宿主调内容字号时这里一起动。
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

/** 读失败与写失败共用的那块（`role="status"`；播报口径与其未验证的边界见 docs/ui-spec.md）。 */
const STATUS_BLOCK: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  padding: '12px 14px',
  background: 'var(--dsw-alias-bg-layer-2)',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 'var(--dsw-radius-lg)',
}

/* ── 块与折叠头 ───────────────────────────────────────────── */

const BLOCK: CSSProperties = { display: 'flex', flexDirection: 'column', minWidth: 0 }

/** 折叠头：与清单组头共用 `sd-disclosure-row` 的布局/悬停/无障碍；这里把 button 的 UA 样式压掉。 */
const BLOCK_ROW: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  textAlign: 'start',
  width: '100%',
  minWidth: 0,
  gap: 6,
}

/** 标签不参与收缩：摘要是 `1 1 auto`，标签若也可缩，长结果会把「工具调用 / 来源」挤成几个字。 */
const BLOCK_TITLE: CSSProperties = {
  ...ELLIPSIS,
  flex: 'none',
  maxWidth: '50%',
  fontWeight: 500,
  fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
}

const BLOCK_SUMMARY: CSSProperties = {
  ...ELLIPSIS,
  flex: '1 1 auto',
  minWidth: 0,
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-tertiary)',
}

const BLOCK_META: CSSProperties = {
  flex: 'none',
  fontSize: 11.5,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-tertiary)',
  whiteSpace: 'nowrap',
}

const BLOCK_BODY: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '8px 0 4px calc(22px + var(--dsh-content-font-delta, 0px))',
  minWidth: 0,
}

const PLAIN_BODY: CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
  lineHeight: '20px',
  color: 'var(--dsw-alias-label-secondary)',
}

/** 工具参数/结果：等宽、保留换行、限高自滚——一段工具输出可能比整页还长。 */
const CODE_BLOCK: CSSProperties = {
  margin: 0,
  padding: '8px 10px',
  background: 'var(--dsw-alias-bg-layer-2)',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 'var(--dsw-radius-md)',
  fontFamily: 'var(--ds-font-family-code)',
  fontSize: 12,
  lineHeight: '18px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 320,
  overflow: 'auto',
}

const SECTION_LABEL: CSSProperties = {
  fontSize: 11.5,
  lineHeight: '16px',
  color: 'var(--dsw-alias-label-tertiary)',
}

const TOOLBAR: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  minWidth: 0,
}

const TRUNCATED: CSSProperties = {
  fontSize: 11.5,
  lineHeight: '16px',
  color: 'var(--dsw-alias-label-tertiary)',
}

const ERROR_TEXT: CSSProperties = { color: 'var(--dsw-alias-state-error-primary)' }

const HOUR = 3600000
const DAY = 86400000

/** 日志里那两个时间戳缺省时的降级（`src/trash/detail.ts` 把初值写成 0，读不到就是 0）。 */
function timeText(ms: number): string {
  return ms === 0 ? '—' : absoluteText(ms)
}

/** 活跃跨度：不足一天给小时，超过给天——都是"这条会话活了多久"这一个问题的答案。
 *  两端任一缺省就**不答**（不把"不知道"报成任何量级）；不足一小时说"不足 1 小时"，
 *  不把 10 分钟舍入成 1 小时冒充整点。 */
function spanText(from: number, to: number, t: Translate): string | undefined {
  if (from === 0 || to === 0) return undefined
  const ms = Math.max(0, to - from)
  if (ms < HOUR) return t('detail.value.spanLessThanHour')
  return ms < DAY
    ? t('detail.value.spanHours', { n: Math.round(ms / HOUR) })
    : t('detail.value.spanDays', { n: Math.round(ms / DAY) })
}

/** 详情头部显示的那句标题：清册优先，空串才回落到日志里的 `session/title`。 */
function titleOf(entry: TrashEntryLike, detail: TrashDetailLike | undefined, t: Translate): string {
  if (entry.title !== '') return entry.title
  if (detail !== undefined && detail.logTitle !== '') return detail.logTitle
  return t('common.untitled')
}

/** 折叠头的摘要：第一行非空文字。 */
function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? ''
  return line.trim()
}

/** Markdown 块的摘要去掉粗体星号（与宿主 ReasoningRow 同一手法）；纯文本块照原样。 */
function markdownSummary(text: string): string {
  return firstLine(text).replaceAll('**', '')
}

/** 宿主当前发过的 `source.kind` 全在这里；日志词表随宿主代次增长，新值先落到「其他上下文」。 */
const INJECTION_LABEL_KEYS = {
  'runtime-context': 'detail.injection.runtimeContext',
  'time-context': 'detail.injection.timeContext',
  'agent-instructions': 'detail.injection.agentInstructions',
  'skill-catalog': 'detail.injection.skillCatalog',
  'agent-message': 'detail.injection.agentMessage',
  'subagent-settled': 'detail.injection.subagentSettled',
  'tool-jobs': 'detail.injection.toolJobs',
  'skill-invocation': 'detail.injection.skillInvocation',
  'user-approval': 'detail.injection.userApproval',
  'goal': 'detail.injection.goal',
} as const satisfies Record<string, CopyKey>

/** 来源标签 + 悬停原串：认不出的 kind 收进「其他上下文」，原串留在 title。 */
function injectionLabel(kind: string, t: Translate): { text: string; title: string } {
  const key = (INJECTION_LABEL_KEYS as Record<string, CopyKey>)[kind]
  if (key !== undefined) {
    const text = t(key)
    return { text, title: text }
  }
  // 空串是日志里就没有来源；非空但认不出只把原串交给 title，不让英文 slug 混进中文正文。
  return { text: t('detail.injection.other'), title: kind === '' ? t('detail.injection.other') : kind }
}

function toolStatus(status: 'ok' | 'error' | 'unfinished', t: Translate): string {
  if (status === 'ok') return t('detail.block.status.ok')
  if (status === 'error') return t('detail.block.status.error')
  return t('detail.block.status.unfinished')
}

type DisclosureBlockWire = Exclude<TrashDetailBlockWire, { kind: 'user' } | { kind: 'assistant' }>

function isDisclosureBlock(block: TrashDetailBlockWire): block is DisclosureBlockWire {
  return block.kind !== 'user' && block.kind !== 'assistant'
}

interface DisclosureProps {
  block: DisclosureBlockWire
  label: string
  /** 悬停原文（标签是映射后的人话时用）；缺省与 `label` 相同。 */
  title?: string
  summary: string
  status?: { text: string; error: boolean }
  time: string
  open: boolean
  onToggle: (id: string) => void
  children: ReactNode
}

/** 一个可折叠块：折叠头一行（chevron + 标签 + 摘要 + 可选状态 + 时间），展开体由调用方给。 */
function Disclosure({ block, label, title, summary, status, time, open, onToggle, children }: DisclosureProps) {
  return (
    <div data-sd-block={block.kind} style={BLOCK}>
      <button
        type="button"
        className="sd-disclosure-row"
        data-expandable=""
        aria-expanded={open}
        onClick={() => onToggle(block.id)}
        style={BLOCK_ROW}
      >
        <span className="sd-disclosure-leading" style={{ marginRight: 0 }} aria-hidden="true">
          {open ? <IconChevronDownOutlineRegular size={14} /> : <IconChevronRightOutlineRegular size={14} />}
        </span>
        <span style={BLOCK_TITLE} title={title ?? label}>{label}</span>
        {summary === '' ? null : <span style={BLOCK_SUMMARY} title={summary}>{summary}</span>}
        {status === undefined ? null : (
          <span style={status.error ? { ...BLOCK_META, ...ERROR_TEXT } : BLOCK_META}>{status.text}</span>
        )}
        <span style={BLOCK_META}>{time}</span>
      </button>
      {open ? <div data-sd-block-body style={BLOCK_BODY}>{children}</div> : null}
    </div>
  )
}

interface BlockRenderContext {
  open: ReadonlySet<string>
  toggle: (id: string) => void
  localeKey: string
  t: Translate
}

/** 单块载荷闸截断后的提示：各块共用同一句，别有的画省略号、有的只画字。 */
function TruncatedNote({ t }: { t: Translate }) {
  return <div style={TRUNCATED}>{t('detail.block.truncated')}</div>
}

/** 展开体走 Markdown 的折叠块（思考、压缩摘要）。 */
function markdownFold(block: TrashDetailTextBlockWire, label: string, context: BlockRenderContext): ReactNode {
  const { open, toggle, localeKey, t } = context
  return (
    <Disclosure
      key={block.id}
      block={block}
      label={label}
      summary={markdownSummary(block.text)}
      time={timeText(block.time)}
      open={open.has(block.id)}
      onToggle={toggle}
    >
      <MarkdownBody text={block.text} t={t} localeKey={localeKey} />
      {block.truncated ? <TruncatedNote t={t} /> : null}
    </Disclosure>
  )
}

/** 展开体走等宽原文的折叠块（注入、系统消息）：这两类带附件。 */
function plainFold(
  block: TrashDetailTextBlockWire | TrashDetailInjectionBlockWire,
  label: string,
  context: BlockRenderContext,
  title?: string,
): ReactNode {
  const { open, toggle, t } = context
  return (
    <Disclosure
      key={block.id}
      block={block}
      label={label}
      title={title}
      summary={firstLine(block.text)}
      time={timeText(block.time)}
      open={open.has(block.id)}
      onToggle={toggle}
    >
      <div style={PLAIN_BODY}>{block.text}</div>
      <AttachmentStrip attachments={block.attachments} t={t} align="start" />
      {block.truncated ? <TruncatedNote t={t} /> : null}
    </Disclosure>
  )
}

/** 块联合新增成员而 `renderBlock` 没跟上时这里编译失败；运行时只可能是前后半版本错配，画空不炸整栏。 */
function unhandledBlock(block: never): null {
  void block
  return null
}

function renderBlock(block: TrashDetailBlockWire, context: BlockRenderContext): ReactNode {
  const { open, toggle, localeKey, t } = context
  switch (block.kind) {
    case 'user':
      return (
        <div key={block.id} data-sd-msg="user" style={USER_ROW}>
          <div style={META_LINE}>{`${t('detail.role.user')} · ${timeText(block.time)}`}</div>
          <AttachmentStrip attachments={block.attachments} t={t} align="end" />
          {/* 纯附件块没有可说的话 ⇒ 不铺一只空气泡；图/文件名就是这一条的内容。 */}
          {block.text === '' ? null : (
            <div data-sd-bubble style={BUBBLE}>{block.text}</div>
          )}
          {block.truncated ? <TruncatedNote t={t} /> : null}
        </div>
      )
    case 'assistant':
      return (
        <div key={block.id} data-sd-msg="assistant" style={ASSISTANT_ROW}>
          <div style={META_LINE}>{`${t('detail.role.assistant')} · ${timeText(block.time)}`}</div>
          <MarkdownBody text={block.text} t={t} localeKey={localeKey} />
          {block.truncated ? <TruncatedNote t={t} /> : null}
          <AttachmentStrip attachments={block.attachments} t={t} align="start" />
        </div>
      )
    case 'reasoning':
      return markdownFold(block, t('detail.block.reasoning'), context)
    case 'tool':
      return (
        <Disclosure
          key={block.id}
          block={block}
          label={block.name === '' ? t('detail.block.tool') : block.name}
          summary={firstLine(block.result) || firstLine(block.args)}
          status={{ text: toolStatus(block.status, t), error: block.status === 'error' }}
          time={timeText(block.time)}
          open={open.has(block.id)}
          onToggle={toggle}
        >
          <div style={SECTION_LABEL}>{t('detail.block.args')}</div>
          <pre style={CODE_BLOCK}>{block.args === '' ? '—' : block.args}</pre>
          <div style={SECTION_LABEL}>{t('detail.block.result')}</div>
          {block.status === 'unfinished' && block.result === ''
            ? <div style={META_LINE}>{t('detail.block.noResult')}</div>
            : <pre style={CODE_BLOCK}>{block.result === '' ? '—' : block.result}</pre>}
          <AttachmentStrip attachments={block.attachments} t={t} align="start" />
          {block.argsTruncated || block.resultTruncated ? <TruncatedNote t={t} /> : null}
        </Disclosure>
      )
    case 'injection': {
      const label = injectionLabel(block.sourceKind, t)
      return plainFold(
        block,
        `${t('detail.block.injection')} · ${label.text}`,
        context,
        `${t('detail.block.injection')} · ${label.title}`,
      )
    }
    case 'system':
      return plainFold(block, t('detail.block.system'), context)
    case 'compaction':
      return markdownFold(block, t('detail.block.compaction'), context)
    default:
      return unhandledBlock(block)
  }
}

export function TrashDetail({
  state,
  busy,
  wide,
  onRetry,
  onBack,
  pager,
  t,
}: TrashDetailProps) {
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

      {detail === undefined ? null : (
        <ReadyBody
          key={entry.id}
          entry={entry}
          detail={detail}
          pager={pager}
          t={t}
        />
      )}
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

interface ReadyBodyProps {
  entry: TrashEntryLike
  detail: TrashDetailLike
  pager: DetailPager
  t: Translate
}

/**
 * 有内容：元信息（时间 → 体量 → 位置三组的顺序）+ 折叠块。
 *
 * 页面上**两本账分开读**：元信息里的计数是整条日志的（注入条数也在表里）；
 * 正文是分页取回来的块。`olderCursor` 非空时顶部出「加载更早」。
 * 折叠状态只活在这个组件里；切条目用 `key={entry.id}` 重挂载，不会把 A 的展开状态带到 B。
 */
function ReadyBody({ entry, detail, pager, t }: ReadyBodyProps) {
  const { loadingOlder, olderFailure, onLoadOlder, scrollRef } = pager
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  /** 更早一页要 prepend 时的块数；换页回来（组件重挂载）这份意图会丢，那是可接受的边界。 */
  const pendingScroll = useRef<{ blocks: number } | null>(null)
  /** 上一次布局后的滚动高度：合并更早一页时用它算**真正插进来的高度**，不把请求在飞期间的
   *  滚动或折叠变化也算进去。 */
  const lastHeight = useRef<number | null>(null)

  // memo 的语言探针：渲染时算好交给 MarkdownBody，切语言这一拍它跟着变（markdown.tsx 头注）。
  const localeKey = t('common.close')
  const project = detail.cwd === '' ? t('trash.project.unknown') : detail.cwd
  const disclosureBlocks = detail.blocks.filter(isDisclosureBlock)
  const allOpen = disclosureBlocks.length > 0 && disclosureBlocks.every((block) => open.has(block.id))

  const toggle = (id: string): void => {
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleAll = (): void => {
    setOpen(allOpen ? new Set() : new Set(disclosureBlocks.map((block) => block.id)))
  }

  const loadOlder = (): void => {
    const element = scrollRef?.current
    if (element !== null && element !== undefined) {
      pendingScroll.current = { blocks: detail.blocks.length }
    }
    onLoadOlder()
  }

  // 更早一页 prepend 后补偿滚动位置：读者正看着的那一块不因上方长出新内容而跳走。
  // 加的是**当前** `scrollTop`（请求在飞时读者可能继续滚动），高度差只取这一拍真正插进来的部分。
  useLayoutEffect(() => {
    const element = scrollRef?.current
    const pending = pendingScroll.current
    if (element === null || element === undefined || pending === null) return
    if (detail.blocks.length !== pending.blocks) {
      pendingScroll.current = null
      if (lastHeight.current !== null) {
        element.scrollTop += element.scrollHeight - lastHeight.current
      }
      return
    }
    if (!loadingOlder) pendingScroll.current = null
  }, [detail.blocks.length, loadingOlder, scrollRef])

  // 每次布局后记下高度：它在合并更早一页的那一拍就是「插入前」的高度（滚动不触发渲染，
  // 折叠开合会先渲染、顺带把这笔高度更新掉）。
  useLayoutEffect(() => {
    const element = scrollRef?.current
    if (element !== null && element !== undefined) lastHeight.current = element.scrollHeight
  })

  return (
    <>
      <dl style={META}>
        <Meta label={t('detail.field.created')}>{timeText(detail.createdAt)}</Meta>
        <Meta label={t('detail.field.lastActivity')}>{timeText(detail.lastActivity)}</Meta>
        <Meta label={t('detail.field.span')}>{spanText(detail.createdAt, detail.lastActivity, t) ?? '—'}</Meta>
        {/* 「删除于」两样都要（docs/ui-spec.md 状态⑥）：相对那句好读，绝对那句好核对。 */}
        <Meta label={t('detail.field.deletedAt')}>
          {t('detail.deletedAt.combined', {
            relative: agoText(entry.deletedAt, Date.now(), t),
            absolute: absoluteText(entry.deletedAt),
          })}
        </Meta>
        <Meta label={t('detail.field.size')}>{fileSizeText(entry.sizeBytes)}</Meta>
        <Meta label={t('detail.field.turns')}>{String(detail.turnCount)}</Meta>
        <Meta label={t('detail.field.userMessages')}>{String(detail.userMessageCount)}</Meta>
        <Meta label={t('detail.field.assistantMessages')}>{String(detail.assistantMessageCount)}</Meta>
        <Meta label={t('detail.field.toolCalls')}>{String(detail.toolCallCount)}</Meta>
        <Meta label={t('detail.field.injections')}>{String(detail.injectedCount)}</Meta>
        <Meta label={t('detail.field.models')}>{detail.models.join(', ') || '—'}</Meta>
        <Meta label={t('detail.field.project')} title={project}>{project}</Meta>
        <Meta label={t('detail.field.sessionId')} title={entry.sessionId}>{entry.sessionId}</Meta>
        <Meta label={t('detail.field.trashDir')} title={entry.id}>{entry.id}</Meta>
        <Meta label={t('detail.field.wasArchived')}>
          {entry.wasArchived ? t('detail.value.yes') : t('detail.value.no')}
        </Meta>
      </dl>

      <div style={TOOLBAR}>
        {detail.olderCursor === null ? null : (
          <Button variant="outline" size="sm" disabled={loadingOlder} onClick={loadOlder}>
            {loadingOlder ? t('detail.loadOlder.loading') : t('detail.loadOlder')}
          </Button>
        )}
        {olderFailure === null ? null : (
          <span role="status" style={{ ...META_LINE, minWidth: 0, wordBreak: 'break-word' }}>{olderFailure}</span>
        )}
        {disclosureBlocks.length === 0 ? null : (
          <span style={{ marginLeft: 'auto' }}>
            <Button variant="ghost" size="sm" onClick={toggleAll}>
              {allOpen ? t('detail.collapseAll') : t('detail.expandAll')}
            </Button>
          </span>
        )}
      </div>

      {detail.blocks.length === 0 ? (
        <div style={META_LINE}>{t('detail.noBody')}</div>
      ) : (
        <div style={THREAD}>
          {detail.blocks.map((block) => renderBlock(block, { open, toggle, localeKey, t }))}
        </div>
      )}
    </>
  )
}
