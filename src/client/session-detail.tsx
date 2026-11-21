/**
 * 会话详情的通用视图（只画状态，不取数）：状态壳、信息表、计量行、工作步骤、提问轨、附件与分页。
 *
 * 档差只在三个投影口里：`head`（与选中行配对）、`infoRows`（两档各自的行集）、`subagents`（子会话段）。
 * 两档共用的接线（读路状态 + 分页读面 + 提问轨）由 `use-detail-frame.ts` 拼成详情帧，这里只消费 `state` / `pager`。
 *
 * 两档同守：动作留在清单行；正文是块（用户/助手常显，其余默认折叠；注入也铺进正文——对宿主 Chat 的有意偏离，删之前看全）；助手/思考走 Markdown，提问保持原话。
 */
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { AttachmentStrip } from './attachment-view.js'
import { absoluteText, localeProbe, stepsText, type CopyKey, type Translate } from './copy.js'
import type { SessionDetailWire, TrashDetailBlockWire, TrashDetailInjectionBlockWire, TrashDetailTextBlockWire } from '../shared/wire.js'
import { MarkdownBody } from './markdown.js'
import { Button } from './ui/Button.js'
import {
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconWarningOutlineRegular,
} from './ui/icons.js'
import { ELLIPSIS, QUIET_DANGER, TABULAR_NUMS } from './ui/recipe.js'
import { hasDialogue, isDisclosureBlock, threadItems } from './detail-blocks.js'
import { useDetailFramePager, type DetailFrameView } from './use-detail-frame.js'
import { JUMP_SCROLL_MARGIN_PX } from './use-prompt-rail.js'

/** 详情的导航面（孩子视图的开与回）：类型定义在这里（控制器 `import type` 避免环）；孩子一律按 id 交接（ADR-0055）。 */
export interface DetailNav {
  /** 只在主体是清单选中那条时交出（ADR-0055 沿用的单级判据，唯一实现）。 */
  readonly onOpenChild?: (childId: string) => void
  /** 与 `onOpenChild` 同进同出的意图预取：hover/focus 子会话行时先把它的详情读进来。 */
  readonly onPrefetchChild?: (childId: string) => void
  /** 孩子视图的返回目标；title 是原文（未命名兜底由视图按 t 处理）。 */
  readonly parentContext?: { readonly title: string; readonly onBack: () => void }
}


/** 信息表的一行：标签 + 值（`title` 只在原文值得展开时给，不给就没有悬停提示；`code` 走等宽样式）。 */
export interface DetailInfoRow {
  readonly label: string
  readonly value: string
  readonly title?: string
  readonly code?: boolean
}

export interface SubagentSectionProps {
  readonly badge: ReactNode
  readonly body: ReactNode
}

export interface SessionDetailProps<S, D extends SessionDetailWire> {
  /** 详情帧：壳只消费读路状态与分页读面；`rail` / `canNavigate` / 行投影不归壳。 */
  frame: DetailFrameView<S, D>
  /** 主体身份（换条复位滚动、body 重挂载的 key、保持提示的判据都按它）。 */
  subjectId: string
  /** 标题与大小与**选中行**配对：列表行给 display name 与大小，详情不重算。 */
  head: { readonly displayName: string; readonly sizeText: string | null }
  infoRows: readonly DetailInfoRow[]
  subagents?: SubagentSectionProps
  busy: boolean
  wide: boolean
  onRetry: () => void
  onBack: () => void
  detailNav: DetailNav
  t: Translate
}

const SHELL: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  boxSizing: 'border-box',
  // 只给下限、不给定高：`HEAD` 的 sticky 包含块是这一层，定高会被滚动容器拉成首屏高，返回键跟着滚走。
  minHeight: '100%',
  minWidth: 0,
}

/** 返回键排在标题之后；标题排按紧凑按钮预留高度（父子切换不跳 6px）。`position: sticky`：长会话中段返回键仍在（触屏没有 Esc）。 */
export const HEAD_MIN_HEIGHT = 28
export const HEAD_PAD_BOTTOM = 6

const HEAD: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  minHeight: HEAD_MIN_HEIGHT,
  position: 'sticky',
  top: 0,
  zIndex: 1,
  background: 'var(--dsw-alias-bg-base)',
  paddingBottom: HEAD_PAD_BOTTOM,
}

const TITLE_LINE: CSSProperties = { ...ELLIPSIS, flex: '1 1 auto', minWidth: 0, fontSize: 15, fontWeight: 600, lineHeight: '22px' }

const BACK: CSSProperties = { flex: 'none' }

/** 保持超过 300ms 才出「正在读…」：本地读数通常在这之前落地；与宿主慢扫描提示同档。 */
const HOLD_NOTICE_DELAY_MS = 300

const HOLD_NOTICE: CSSProperties = {
  flex: 'none',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--sd-label-tertiary)',
}

/** 会话信息表：行序按「认出 → 时间定位 → 精确核对 → 调试属性」排（`docs/ui-spec.md` §2 ⑥）；长串省略、全称走 `title`。 */
const META: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  gap: '3px 12px',
  margin: '8px 0 0',
  fontSize: 12,
  lineHeight: '18px',
}

const META_LABEL = { color: 'var(--sd-label-tertiary)', whiteSpace: 'nowrap' } as CSSProperties

const META_VALUE = {
  ...ELLIPSIS,
  ...TABULAR_NUMS,
  margin: 0,
  minWidth: 0,
} as CSSProperties

const META_CODE = {
  fontFamily: 'var(--ds-font-family-code)',
  fontSize: 11,
  color: 'var(--dsw-alias-label-secondary)',
} as CSSProperties

/** 计量行：可横着扫的数字，与表分开；不插中点分隔符——那是各语言自己的标点。 */
const METRICS: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '2px 14px',
  marginTop: 8,
  minWidth: 0,
  fontSize: 12,
  lineHeight: '18px',
}

const METRIC = { display: 'inline-flex', gap: 6, minWidth: 0, maxWidth: '100%' } as CSSProperties

const METRIC_LABEL = { flex: 'none', color: 'var(--sd-label-tertiary)', whiteSpace: 'nowrap' } as CSSProperties

const METRIC_VALUE = {
  ...ELLIPSIS,
  ...TABULAR_NUMS,
  minWidth: 0,
} as CSSProperties

/** 行距取宿主 `--dsh-chat-flow-gap` 的换轮档 12px（我们相邻两条必然换轮）。 */
const THREAD: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }

/**
 * 消息行照宿主 `MessageItem` / `AssistantMarkdown` 抄（来源 `app.asar` 里 `@deepseek-ai/dsh-client-ui-chat/lib/client.js`
 * 内联的 `MessageItem.module.css` 与 `AssistantMarkdown.module.css`，逐字声明）：只有用户有气泡，助手正文铺满栏（给助手画卡片会走形）；
 * 字号走 `--dsh-content-font-size`，宿主调内容字号时这里一起动。
 */
/** 提问轨跳过来的落位让位（`JUMP_SCROLL_MARGIN_PX`）：目标行停在 sticky 标题排之下而不是被它盖住。 */
const USER_ROW: CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, minWidth: 0, scrollMarginTop: JUMP_SCROLL_MARGIN_PX }

const ASSISTANT_ROW: CSSProperties = { display: 'flex', flexDirection: 'column', minWidth: 0 }

/** 宿主是 `.userRow > .userStack > .bubble` 三层，宽度上限在中间层；这里一行一气泡，直接挂在气泡上（少一层）。 */
const BUBBLE: CSSProperties = {
  background: 'var(--sd-specific-bubble)',
  borderRadius: 'var(--sd-radius-xl)',
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
  color: 'var(--sd-label-tertiary)',
}

/** 读失败与写失败共用的那块（`role="status"`；播报口径与其未验证的边界见 docs/ui-spec.md）。 */
const STATUS_BLOCK: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  padding: '12px 14px',
  background: 'var(--dsw-alias-bg-layer-2)',
  border: '0.5px solid var(--sd-border-l4)',
  borderRadius: 'var(--sd-radius-lg)',
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
  gap: 8,
}

/** 标签不参与收缩：摘要是 `1 1 auto`，标签若也可缩，长结果会把「工具调用 / 来源」挤成几个字。
 *  颜色不跟 `.sd-disclosure-row` 继承：标签提 secondary、摘要留 tertiary，否则同色糊成一句。 */
const BLOCK_TITLE: CSSProperties = {
  ...ELLIPSIS,
  flex: 'none',
  maxWidth: '50%',
  fontWeight: 500,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
}

const BLOCK_SUMMARY: CSSProperties = {
  ...ELLIPSIS,
  flex: '1 1 auto',
  minWidth: 0,
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--sd-label-tertiary)',
}

export const BLOCK_META: CSSProperties = {
  flex: 'none',
  fontSize: 11,
  lineHeight: '18px',
  color: 'var(--sd-label-tertiary)',
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
  border: '0.5px solid var(--sd-border-l4)',
  borderRadius: 'var(--sd-radius-md)',
  fontFamily: 'var(--ds-font-family-code)',
  fontSize: 12,
  lineHeight: '18px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 320,
  overflow: 'auto',
}

export const SECTION_LABEL: CSSProperties = {
  fontSize: 11,
  lineHeight: '16px',
  color: 'var(--sd-label-tertiary)',
}

/** 标准档「工作步骤」展开后的过程块容器：再缩进一档，与折叠头的前导对齐。 */
const PROCESS_BODY: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '2px 0 4px calc(22px + var(--dsh-content-font-delta, 0px))',
  minWidth: 0,
}

const TOOLBAR: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  minWidth: 0,
}

const TRUNCATED: CSSProperties = {
  fontSize: 11,
  lineHeight: '16px',
  color: 'var(--sd-label-tertiary)',
}

const ERROR_TEXT: CSSProperties = { color: 'var(--dsw-alias-state-error-primary)' }

const HOUR = 3600000
const DAY = 86400000

/** 日志里那两个时间戳缺省时的降级（`src/trash/detail.ts` 把初值写成 0，读不到就是 0）。 */
export function timeText(ms: number): string {
  return ms === 0 ? '—' : absoluteText(ms)
}

/** 活跃跨度：不足一天给小时、超过给天；两端任一缺省就不答（不把「不知道」报成任何量级）。 */
function spanText(from: number, to: number, t: Translate): string | undefined {
  if (from === 0 || to === 0) return undefined
  const ms = Math.max(0, to - from)
  if (ms < HOUR) return t('detail.value.spanLessThanHour')
  return ms < DAY
    ? t('detail.value.spanHours', { n: Math.round(ms / HOUR) })
    : t('detail.value.spanDays', { n: Math.round(ms / DAY) })
}

/** 空串不是名字：wire 用缺席表示没读到，清册字段仍可能是空串；行名与标题排共用这一条。 */
export function present(value: string | undefined): value is string {
  return value !== undefined && value !== ''
}

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

/** 工作步骤展示档位（学宿主那四档；回收站轮次都已结束，所以只落成「过程块显示多少」）；判据住 `docs/ui-spec.md` §2 ⑥。 */
type ViewMode = 'compact' | 'standard' | 'detailed' | 'verbose'

const VIEW_MODES: readonly { readonly key: ViewMode; readonly label: CopyKey }[] = [
  { key: 'compact', label: 'detail.viewMode.compact' },
  { key: 'standard', label: 'detail.viewMode.standard' },
  { key: 'detailed', label: 'detail.viewMode.detailed' },
  { key: 'verbose', label: 'detail.viewMode.verbose' },
]

interface DisclosureProps {
  /** 折叠头只读块的 `kind`（`data-sd-block`）与 `id`（开合键）；块内容由 `children` 给。 */
  block: { readonly kind: TrashDetailBlockWire['kind']; readonly id: string }
  label: string
  /** 悬停原文（标签是映射后的人话时用）；缺省与 `label` 相同。 */
  title?: string | undefined
  summary: string
  status?: { text: string; error: boolean }
  time: string
  open: boolean
  onToggle: (id: string) => void
  children: ReactNode
}

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
  probe: string
  t: Translate
}

/** 单块载荷闸截断后的提示：各块共用同一句，别有的画省略号、有的只画字。 */
function TruncatedNote({ t }: { t: Translate }) {
  return <div style={TRUNCATED}>{t('detail.block.truncated')}</div>
}

function markdownFold(block: TrashDetailTextBlockWire, label: string, context: BlockRenderContext): ReactNode {
  const { open, toggle, probe, t } = context
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
      <MarkdownBody text={block.text} t={t} probe={probe} />
      {block.truncated ? <TruncatedNote t={t} /> : null}
    </Disclosure>
  )
}

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
  const { open, toggle, probe, t } = context
  switch (block.kind) {
    case 'user':
      return (
        <div key={block.id} data-sd-msg="user" data-block-id={block.id} style={USER_ROW}>
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
          <MarkdownBody text={block.text} t={t} probe={probe} />
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


export function SessionDetail<S, D extends SessionDetailWire>({
  frame,
  subjectId,
  head,
  infoRows,
  subagents,
  busy,
  wide,
  onRetry,
  onBack,
  detailNav,
  t,
}: SessionDetailProps<S, D>) {
  const { state, pager } = frame
  const { scrollRef } = pager
  const holding = state.kind === 'holding'
  const shownId = state.kind === 'idle' ? null : subjectId
  const [holdNotice, setHoldNotice] = useState(false)

  // 换到另一条（含 holding → ready 的整帧换）时滚动回顶：容器共用，不复位就继承上一条的偏移。
  // 只在 shown id 真的变了时复位：首挂不碰，也不覆盖分页补偿的初始读数。
  const previousShownId = useRef<string | null | undefined>(undefined)
  useLayoutEffect(() => {
    const previous = previousShownId.current
    previousShownId.current = shownId
    if (previous === undefined || previous === shownId) return
    const element = scrollRef?.current
    if (element !== null && element !== undefined) element.scrollTop = 0
  }, [shownId, scrollRef])

  // 提示只在保持超过静默窗口后出现；`holdId` 从 A 换 B 时先收掉上一条的提示，从 B 自己的窗口重新计时。
  const holdId = holding ? subjectId : null
  useEffect(() => {
    setHoldNotice(false)
    if (holdId === null) return
    const timer = setTimeout(() => { setHoldNotice(true) }, HOLD_NOTICE_DELAY_MS)
    return () => { clearTimeout(timer) }
  }, [holdId])

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
          fontSize: 12,
          lineHeight: '18px',
          color: 'var(--sd-label-tertiary)',
        }}
      >
        {t('detail.notSelected')}
      </div>
    )
  }

  const detail = state.kind === 'ready' || state.kind === 'holding' ? state.detail : undefined
  const body = detail === undefined ? null : (
    <ReadyBody
      key={subjectId}
      frame={frame}
      head={head}
      infoRows={infoRows}
      detail={detail}
      subagentBody={subagents?.body}
      t={t}
    />
  )

  return (
    <div style={SHELL}>
      {/* 两颗返回互斥（看父 vs 看清单）共用同一位置；未命名兜底按 t 做。 */}
      <div data-dsh-session-delete="session-detail-head" style={HEAD}>
        <div style={TITLE_LINE}>
          {/* 内层按文字收缩：悬停提示不跟着吃满整行。 */}
          <span title={head.displayName}>{head.displayName}</span>
        </div>
        {holding && holdNotice ? (
          <span data-dsh-session-delete="session-detail-hold" style={HOLD_NOTICE}>
            {t('detail.loading')}
          </span>
        ) : null}
        {subagents?.badge ?? null}
        {detailNav.parentContext !== undefined ? (
          <Button
            variant="ghost"
            size="sm"
            style={BACK}
            onClick={detailNav.parentContext.onBack}
            title={detailNav.parentContext.title === '' ? t('common.untitled') : detailNav.parentContext.title}
          >
            {t('detail.backToParent')}
          </Button>
        ) : wide ? null : (
          <Button variant="ghost" size="sm" style={BACK} onClick={onBack}>
            {t('detail.back')}
          </Button>
        )}
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
            <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--sd-label-tertiary)', wordBreak: 'break-word' }}>
              {state.message}
            </div>
          </div>
          <Button variant="outline" size="sm" style={{ flex: 'none' }} disabled={busy} onClick={onRetry}>
            {t('common.retry')}
          </Button>
        </div>
      ) : null}

      {detail === undefined ? null : holding ? (
        // 保持期：正文按上一条画，但整块 inert + aria-busy，不能把 A 的分页读到 B 上。
        <div data-dsh-session-delete="session-detail-hold-body" aria-busy="true" {...{ inert: '' }}>
          {body}
        </div>
      ) : body}
    </div>
  )
}

/** 读数中：没有上一条可保持时才会走到这里（首次）。骨架按内容形状画，不给百分比（本机一条 135ms，进度是假话）。 */
function LoadingBody({ t }: { t: Translate }) {
  return (
    <>
      <div style={{ fontSize: 12, lineHeight: '18px', color: 'var(--sd-label-tertiary)' }}>
        {t('detail.loading')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }} aria-hidden="true">
        {([['48px', '72%'], ['40px', '58%'], ['56px', '66%'], ['44px', '50%']] as const).map(([label, value]) => (
          <div key={label} style={{ display: 'flex', gap: 12 }}>
            <div className="sd-skeleton-bar" style={{ height: 11, width: label, borderRadius: 6 }} />
            <div className="sd-skeleton-bar" style={{ height: 11, width: value, borderRadius: 6 }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }} aria-hidden="true">
        {([70, 96, 52, 88, 34] as const).map((percent) => (
          <div
            key={percent}
            className="sd-skeleton-bar"
            style={{ height: 11, width: `${percent}%`, borderRadius: 6 }}
          />
        ))}
      </div>
    </>
  )
}

function Meta({ label, title, code, children }: { label: string; title?: string | undefined; code?: boolean; children: string }) {
  return (
    <>
      <dt style={META_LABEL}>{label}</dt>
      <dd style={META_VALUE} title={title}>
        {code === true ? <code style={META_CODE}>{children}</code> : children}
      </dd>
    </>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span style={METRIC}>
      <span style={METRIC_LABEL}>{label}</span>
      <span style={METRIC_VALUE}>{value}</span>
    </span>
  )
}

interface ReadyBodyProps<S, D extends SessionDetailWire> {
  /** 详情帧：这里只消费 `pager` 那一格（翻页入口与分页失败面挂在它上面）；正文由上层拆成 `detail`。 */
  frame: DetailFrameView<S, D>
  head: { readonly displayName: string; readonly sizeText: string | null }
  infoRows: readonly DetailInfoRow[]
  detail: D
  subagentBody: ReactNode
  t: Translate
}

/** 有内容：会话信息 + 计量行 + 子会话段 + 工作步骤。两本账分开读：会话信息的计数是整条日志的，正文是分页取回的块
 *  （更早页由读者点「加载更早」，跳转走提问轨，ADR-0057）；档位与折叠状态只活在这里，切条目靠 `key={subjectId}` 重挂载。 */
function ReadyBody<S, D extends SessionDetailWire>({ frame, head, infoRows, detail, subagentBody, t }: ReadyBodyProps<S, D>) {
  const { loadingOlder, olderFailure } = frame.pager
  const [mode, setMode] = useState<ViewMode>('standard')
  /** 标准档「工作步骤」组的开合（按组后那条对话块的 id 记，prepend 不换键）。 */
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set())
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  /** 手动「加载更早」、简洁档自动连翻与 prepend 后的滚动锚点整块住在 hook 里。 */
  const { loadOlder } = useDetailFramePager(frame, detail, mode === 'compact')


  // memo 的语言探针：渲染时算好交给 MarkdownBody，切语言这一拍它跟着变（借哪句住 copy.ts 的 localeProbe）。
  const probe = localeProbe(t)
  const span = spanText(detail.createdAt, detail.lastActivity, t) ?? '—'
  const disclosureBlocks = detail.blocks.filter(isDisclosureBlock)
  const items = threadItems(detail.blocks)

  const toggle = (id: string): void => {
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleGroup = (id: string): void => {
    setOpenGroups((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 换档：切进完全展开才铺开当前全部过程块（按住的档位不重开读者刚收起的），离开时收回；
   *  切进简洁档且当前页全是过程块时先自动前翻，不留白。 */
  const chooseViewMode = (next: ViewMode): void => {
    setMode(next)
    // 只在**切进**完全展开时铺开：再点一次按住的档位不该把读者刚收起的块重新打开。
    if (next === 'verbose') {
      if (mode !== 'verbose') setOpen(new Set(disclosureBlocks.map((block) => block.id)))
    } else if (mode === 'verbose') {
      setOpen(new Set())
    }
    if (
      next === 'compact'
      && mode !== 'compact'
      && detail.blocks.length > 0
      && !hasDialogue(detail.blocks)
      && detail.olderCursor !== null
    ) loadOlder()
  }

  return (
    <>
      {/* 会话信息：行集由来源投影给，顺序由调用方定（认出 → 时间 → 精确核对 → 归档状态）。 */}
      <dl style={META}>
        {infoRows.map((row) => (
          <Meta key={row.label} label={row.label} title={row.title} code={row.code === true}>{row.value}</Meta>
        ))}
      </dl>
      <div style={METRICS}>
        {/* 大小与**选中行**配对（列表行给）；行没有可信读数 ⇒ 这一格不摆（缺席 ≠ 0）。 */}
        {head.sizeText === null ? null : <Metric label={t('detail.field.size')} value={head.sizeText} />}
        <Metric label={t('detail.field.span')} value={span} />
        <Metric label={t('detail.field.turns')} value={String(detail.turnCount)} />
        <Metric label={t('detail.field.userMessages')} value={String(detail.userMessageCount)} />
        <Metric label={t('detail.field.assistantMessages')} value={String(detail.assistantMessageCount)} />
        <Metric label={t('detail.field.toolCalls')} value={String(detail.toolCallCount)} />
        <Metric label={t('detail.field.injections')} value={String(detail.injectedCount)} />
      </div>

      {subagentBody}

      <div style={TOOLBAR}>
        {/* 分页只由读者点这里发起（ADR-0057）：滚到顶不替人取数；在飞禁用，失败原文落同一行状态格。 */}
        {detail.olderCursor === null ? null : (
          <Button variant="outline" size="sm" disabled={loadingOlder} onClick={loadOlder}>
            {loadingOlder ? t('detail.loadOlder.loading') : t('detail.loadOlder')}
          </Button>
        )}
        {olderFailure === null ? null : (
          <span role="status" style={{ ...META_LINE, minWidth: 0, wordBreak: 'break-word' }}>{olderFailure}</span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          <span className="sd-seg" role="group" aria-label={t('detail.viewMode.label')}>
            {VIEW_MODES.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                aria-pressed={mode === key}
                onClick={() => { chooseViewMode(key) }}
              >
                {t(label)}
              </button>
            ))}
          </span>
        </span>
      </div>

      {detail.blocks.length === 0 ? (
        <div style={META_LINE}>{t('detail.noBody')}</div>
      ) : (
        <div style={THREAD}>
          {mode === 'standard'
            ? items.map((item) => item.kind === 'block'
                ? renderBlock(item.block, { open, toggle, probe, t })
                : (
                  <div key={item.id}>
                    <button
                      type="button"
                      className="sd-disclosure-row"
                      data-dsh-session-delete="session-process-head"
                      data-expandable=""
                      aria-expanded={openGroups.has(item.id)}
                      onClick={() => { toggleGroup(item.id) }}
                      style={BLOCK_ROW}
                    >
                      <span className="sd-disclosure-leading" style={{ marginRight: 0 }} aria-hidden="true">
                        {openGroups.has(item.id)
                          ? <IconChevronDownOutlineRegular size={14} />
                          : <IconChevronRightOutlineRegular size={14} />}
                      </span>
                      <span style={BLOCK_TITLE}>{t('detail.process.header')}</span>
                      <span style={BLOCK_SUMMARY}>{stepsText(item.blocks.length, t)}</span>
                    </button>
                    {openGroups.has(item.id)
                      ? <div style={PROCESS_BODY}>{item.blocks.map((block) => renderBlock(block, { open, toggle, probe, t }))}</div>
                      : null}
                  </div>
                ))
            : detail.blocks
                .filter((block) => mode !== 'compact' || !isDisclosureBlock(block))
                .map((block) => renderBlock(block, { open, toggle, probe, t }))}
          {/* 简洁档只画对话；当前页全是过程内容时按有无更早页改口，自动连翻在飞时不挂（按钮正停在「正在加载更早…」）。 */}
          {mode === 'compact' && detail.blocks.length > 0 && !hasDialogue(detail.blocks) && !loadingOlder
            ? (
              <div style={META_LINE}>
                {t(detail.olderCursor === null ? 'detail.compact.empty' : 'detail.compact.pageOnly')}
              </div>
            )
            : null}
        </div>
      )}
    </>
  )
}
