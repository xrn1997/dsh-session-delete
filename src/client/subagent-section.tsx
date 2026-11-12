/**
 * 详情里的**子会话段**（回收站与归档共用）：默认收起成一条摘要条，展开后逐条列孩子。
 * 调用方交来的是**每个孩子的原始事实**（显示名、字节数、时间、可不可点）加上总数与合计；
 * 段里的三样派生读数——徽标条数、「已列 N / 共 M」、合计那格文案——由本模块自己算，
 * 呈现、开合、锚点与意图预取也只在这里。
 *
 * 为什么独立成文件：两档的数据来源不同（回收站看清册、归档看宿主闭包），但界面表现应一致；
 * 把样式、交互与这些派生读数只留一份，别让两档各抄一套、各算一次。
 */
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { agoText, type Translate } from './copy.js'
import { preferredNameOf } from './trash-view.js'
import { fileSizeText } from './ui/format.js'
import { intentPrefetchHandlers, useDelayedPrefetch } from './use-prefetch.js'
import {
  BLOCK_META,
  HEAD_MIN_HEIGHT,
  HEAD_PAD_BOTTOM,
  SECTION_LABEL,
  type SubagentSectionProps,
} from './session-detail.js'
import {
  IconBranchOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
} from './ui/icons.js'
import { ELLIPSIS, TABULAR_NUMS } from './ui/recipe.js'

const SUBAGENTS: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  borderTop: '1px solid var(--sd-border-l4)',
  paddingTop: 10,
  marginTop: 2,
  scrollMarginTop: HEAD_MIN_HEIGHT + HEAD_PAD_BOTTOM,
}

const SUBAGENT_STRIP: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  minWidth: 0,
  border: 'none',
  padding: '4px 6px',
  font: 'inherit',
  textAlign: 'start',
  cursor: 'pointer',
  borderRadius: 'var(--sd-radius-md)',
  color: 'var(--dsw-alias-label-primary)',
}

const SUBAGENT_LEAD: CSSProperties = {
  display: 'inline-flex',
  flex: 'none',
  color: 'var(--dsw-alias-brand-primary)',
}

const SUBAGENT_LABEL: CSSProperties = {
  flex: 'none',
  fontSize: 13,
  lineHeight: '20px',
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
}

const SUBAGENT_COUNT: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 20,
  height: 20,
  padding: '0 7px',
  borderRadius: 999,
  background: 'var(--dsw-alias-brand-primary)',
  color: 'var(--sd-label-primary-foreground)',
  fontSize: 11,
  fontWeight: 600,
  lineHeight: '16px',
  ...TABULAR_NUMS,
}

const SUBAGENT_SIZE: CSSProperties = { ...BLOCK_META, marginLeft: 'auto' }

const JUMP_BADGE: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  border: '0.5px solid var(--dsw-alias-border-l2)',
  color: 'var(--dsw-alias-label-secondary)',
  borderRadius: 999,
  padding: '2px 6px 2px 9px',
  font: 'inherit',
  fontSize: 11,
  lineHeight: '16px',
  cursor: 'pointer',
}

const JUMP_BADGE_ICON: CSSProperties = {
  display: 'inline-flex',
  flex: 'none',
  color: 'var(--dsw-alias-label-secondary)',
}

const JUMP_BADGE_COUNT: CSSProperties = {
  ...SUBAGENT_COUNT,
  minWidth: 16,
  height: 16,
  padding: '0 5px',
  fontSize: 10,
}

const SUBAGENT_CHEVRON: CSSProperties = {
  display: 'inline-flex',
  flex: 'none',
  color: 'var(--dsw-alias-label-secondary)',
}

const SUBAGENT_BODY: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 }

const SUBAGENT_RAIL: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  marginLeft: 6,
  paddingLeft: 10,
  borderLeft: '1px solid var(--sd-border-l3)',
  maxHeight: 260,
  overflow: 'auto',
  scrollbarGutter: 'stable',
}

const SUBAGENT_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  minWidth: 0,
  border: 'none',
  padding: '6px 8px',
  font: 'inherit',
  textAlign: 'start',
  cursor: 'pointer',
  borderRadius: 'var(--sd-radius-md)',
  color: 'var(--dsw-alias-label-primary)',
  flex: 'none',
}

const SUBAGENT_TITLE: CSSProperties = {
  ...ELLIPSIS,
  flex: '1 1 auto',
  minWidth: 0,
  fontSize: 13,
  lineHeight: '20px',
  fontWeight: 500,
}

/** 子会话行与摘要条共用的显示名：次序走 `preferredNameOf`（ADR-0058），空串走未命名兜底。 */
export function rowName(row: { readonly label?: string; readonly title: string }, t: Translate): string {
  const name = preferredNameOf(row)
  return name === '' ? t('common.untitled') : name
}

/**
 * 一个孩子的**原始事实**（不是文案）：显示名两档各自按名次序算好交进来（那是词汇表里的
 * 「显示名次序」，不属于这一段），其余三样由这一段自己念成话。
 */
export interface SubagentChild {
  readonly id: string
  readonly name: string
  /** 已知字节数；`undefined` ⇒ 摆 `sizeAbsentText` 给的那句（不给就摆「—」）。 */
  readonly sizeBytes: number | undefined
  /** 时间读数（回收站 = 删除时间，归档 = 最后活动）；`undefined` ⇒ 这一格不画。 */
  readonly at: number | undefined
  /** 有可打开的详情才可点；归档里未归档的孩子只读。 */
  readonly navigable: boolean
}

export interface SubagentSectionInput {
  readonly subjectId: string
  /** 已列出来的孩子（被条数闸截断时就是前 N 条）。空表 ⇒ 整段不画。 */
  readonly children: readonly SubagentChild[]
  /** 孩子总数，只在被截断时给（`undefined` = 已列的就是全部）：徽标与摘要条念它，
   *  「已列 N / 共 M」也由它与 `children.length` 算出。写成 `number | undefined` 而不是可选键：
   *  调用方交的就是「详情里那一格有没有读数」，两者在这里同义。 */
  readonly total: number | undefined
  /** **全部**孩子的已知大小合计；`undefined` = 没有可信读数 ⇒ 摘要条不摆这一格。
   *  合计的家在 Node 半：这里不拿已列的前 N 条求和，那是少报。 */
  readonly totalSizeBytes: number | undefined
  /** 单行大小缺席时念什么（归档交自己键上的那句，与它的清单行同一个字符）；不给 ⇒ 「—」。 */
  readonly sizeAbsentText?: string
  /** 展开体里那句「它们跟谁走」；两档各自给（回收站=随组恢复/删除，归档=按自己的归档状态）。 */
  readonly note: string
  readonly onOpenChild?: (id: string) => void
  readonly onPrefetchChild?: (id: string) => void
  readonly t: Translate
}

/** 一行的可见文案：由原始事实 + 本段的口径算出来，不给调用方留第二份算法。 */
interface SubagentRowView {
  readonly id: string
  readonly name: string
  readonly sizeText: string
  readonly timeText: string | null
  readonly navigable: boolean
}

/**
 * 子会话段的两个槽：徽标（标题排）与段体（计量行之后）。没有孩子时返回 `undefined`，
 * 调用方整段不画。
 */
export function useSubagentSection(input: SubagentSectionInput): SubagentSectionProps | undefined {
  const { subjectId, children, total, totalSizeBytes, sizeAbsentText, note, onOpenChild, onPrefetchChild, t } = input
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)

  // 只活在这一条会话的详情里：换条目（含父子切换）回到默认收起。
  useLayoutEffect(() => { setOpen(false) }, [subjectId])

  const prefetchChild = useDelayedPrefetch((id: string): void => {
    onPrefetchChild?.(id)
  })

  if (children.length === 0) return undefined

  const count = total ?? children.length
  const rows: readonly SubagentRowView[] = children.map((child) => ({
    id: child.id,
    name: child.name,
    sizeText: child.sizeBytes === undefined ? sizeAbsentText ?? '—' : fileSizeText(child.sizeBytes),
    timeText: child.at === undefined ? null : agoText(child.at, Date.now(), t),
    navigable: child.navigable,
  }))
  // 截断只由「总数 vs 已列」算得出，两档同一句、同一处拼。
  const truncationText = total === undefined ? null : t('detail.subagents.truncated', { shown: children.length, total })
  const totalSizeText = totalSizeBytes === undefined ? null : fileSizeText(totalSizeBytes)

  const showSection = (): void => {
    setOpen(true)
    const section = anchorRef.current
    // jsdom 没有 scrollIntoView：跑得动测试，真实浏览器里一定有。
    if (section !== null && typeof section.scrollIntoView === 'function') {
      section.scrollIntoView({ block: 'start' })
    }
  }

  const badge = (
    <button
      type="button"
      data-dsh-session-delete="session-subagents-jump"
      style={JUMP_BADGE}
      title={t('detail.subagents.jump')}
      onClick={showSection}
    >
      <span style={JUMP_BADGE_ICON} aria-hidden="true"><IconBranchOutlineRegular size={12} /></span>
      <span>{t('detail.subagents.label')}</span>
      <span style={JUMP_BADGE_COUNT}>{count}</span>
    </button>
  )

  const body = (
    <div ref={anchorRef} data-dsh-session-delete="session-subagents" style={SUBAGENTS}>
      <button
        type="button"
        data-dsh-session-delete="session-subagents-toggle"
        aria-expanded={open}
        style={SUBAGENT_STRIP}
        title={open ? t('detail.subagents.collapse') : t('detail.subagents.expand')}
        onClick={() => { setOpen((current) => !current) }}
      >
        <span style={SUBAGENT_LEAD} aria-hidden="true"><IconBranchOutlineRegular size={14} /></span>
        <span style={SUBAGENT_LABEL}>{t('detail.subagents.label')}</span>
        <span style={SUBAGENT_COUNT}>{count}</span>
        {totalSizeText === null ? null : <span style={SUBAGENT_SIZE}>{totalSizeText}</span>}
        <span style={SUBAGENT_CHEVRON} aria-hidden="true">
          {open ? <IconChevronDownOutlineRegular size={14} /> : <IconChevronRightOutlineRegular size={14} />}
        </span>
      </button>
      {open ? (
        <div style={SUBAGENT_BODY}>
          <div style={SECTION_LABEL}>{note}</div>
          <div data-dsh-session-delete="session-subagent-list" style={SUBAGENT_RAIL}>
            {rows.map((row) => row.navigable && onOpenChild !== undefined ? (
              <button
                key={row.id}
                type="button"
                data-dsh-session-delete="session-subagent-row"
                data-session-id={row.id}
                style={SUBAGENT_ROW}
                title={t('detail.subagents.open')}
                {...intentPrefetchHandlers(prefetchChild, row.id)}
                onClick={() => { onOpenChild(row.id) }}
              >
                <SubagentRowBody row={row} />
              </button>
            ) : (
              <div
                key={row.id}
                data-dsh-session-delete="session-subagent-row-static"
                data-session-id={row.id}
                style={{ ...SUBAGENT_ROW, cursor: 'default' }}
                title={row.name}
              >
                <SubagentRowBody row={row} />
              </div>
            ))}
          </div>
          {truncationText === null ? null : (
            <div style={SECTION_LABEL} data-dsh-session-delete="session-subagents-truncated">
              {truncationText}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )

  return { badge, body }
}

function SubagentRowBody({ row }: { row: SubagentRowView }) {
  return (
    <>
      <span style={{ ...SUBAGENT_LEAD, color: 'var(--dsw-alias-label-secondary)' }} aria-hidden="true">
        <IconBranchOutlineRegular size={14} />
      </span>
      <span style={SUBAGENT_TITLE}>{row.name}</span>
      <span style={BLOCK_META}>{row.sizeText}</span>
      {row.timeText === null ? null : <span style={BLOCK_META}>{row.timeText}</span>}
    </>
  )
}
