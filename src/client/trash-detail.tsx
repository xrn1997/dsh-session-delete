/**
 * 回收站详情块：`session-detail.tsx` 的**回收站投影**——显示名/大小与选中行配对、信息表七行
 * （含「回收站目录」「原本归档」）、子会话段（徽标 + 段体）。取数与账本不在这（见
 * `use-trash-detail-reader.ts`）；通用的状态壳、正文块、工作步骤与分页住 `session-detail.tsx`。
 */
import type { Translate } from './copy.js'
import type { TrashEntryWire } from '../shared/wire.js'
import type { TrashDetailLike } from './remote.js'
import { fileSizeText } from './ui/format.js'
import { timeText } from './session-detail.js'
import {
  SessionDetail,
  type DetailInfoRow,
  type DetailNav,
  type DetailPager,
} from './session-detail.js'
import type { DetailState } from './use-detail-reader.js'
import { rowName, useSubagentSection } from './subagent-section.js'
import { detailNameOf } from './trash-view.js'

/** 详情主体只承诺清册那一行：孩子视图看的那条不在客户端清单里，没有只读数可配对
 *  （孩子摘要随父详情过线，那一格的判据住 `src/client/remote.ts` 的 `TrashDetailLike`）。
 *  形状与通用详情读路同为 `DetailState`（主体键 `subject`）；两档不再各持一份可互转的副本。 */
export type TrashDetailState = DetailState<TrashEntryWire, TrashDetailLike>

export interface TrashDetailProps {
  state: TrashDetailState
  /** 有写操作在飞（动作按钮住在清单行里，这里只用来把「重试」按住）。 */
  busy: boolean
  /** 宽档不画「返回清单」——同屏就有清单，那一步多余。孩子视图另有一颗返回，见 `detailNav.parentContext`。 */
  wide: boolean
  onRetry: () => void
  onBack: () => void
  /** 孩子视图的开与回（控制器派生，判据见 `DetailNav`）：缺席 = 不画入口/返回，组件只画状态，不自己造动作。 */
  detailNav: DetailNav
  pager: DetailPager
  t: Translate
}


/** 标题排的显示名：行 label → 详情自己的 descriptor label（独立子会话没有父行可兜）→
 *  清册标题 → 日志 `session/title`；次序与归档档共用 `detailNameOf`（ADR-0058）。 */
function headerName(entry: TrashEntryWire, detail: TrashDetailLike | undefined, t: Translate): string {
  return detailNameOf(entry, detail, t('common.untitled'))
}


/** 回收站信息表的行集（七行，顺序 = 决策相关性）：项目 → 模型 → 创建 → 最后活动 → 会话 id
 *  → 回收站目录 → 原本归档。归档档的行集归 `archive-detail.tsx`，两档不共用。 */
function trashInfoRows(entry: TrashEntryWire, detail: TrashDetailLike, t: Translate): DetailInfoRow[] {
  const project = detail.cwd === '' ? t('trash.project.unknown') : detail.cwd
  const models = detail.models.join(', ') || '—'
  return [
    { label: t('detail.field.project'), value: project, title: project },
    { label: t('detail.field.models'), value: models, title: models },
    { label: t('detail.field.created'), value: timeText(detail.createdAt) },
    { label: t('detail.field.lastActivity'), value: timeText(detail.lastActivity) },
    { label: t('detail.field.sessionId'), value: entry.sessionId, title: entry.sessionId, code: true },
    { label: t('detail.field.trashDir'), value: entry.id, title: entry.id, code: true },
    { label: t('detail.field.wasArchived'), value: entry.wasArchived ? t('detail.value.yes') : t('detail.value.no') },
  ]
}


export function TrashDetail({
  state,
  busy,
  wide,
  onRetry,
  onBack,
  detailNav,
  pager,
  t,
}: TrashDetailProps) {
  const shownId = state.kind === 'idle' ? null : state.subject.id
  const entry = state.kind === 'idle' ? null : state.subject
  const detail = state.kind === 'ready' || state.kind === 'holding' ? state.detail : undefined
  const title = entry === null ? '' : headerName(entry, detail, t)

  /** 孩子视图里 `onOpenChild` 缺席：整段不画（详情不给孩子再开入口，ADR-0055 单级）。 */
  const children = detailNav.onOpenChild === undefined ? [] : detail?.subagents ?? []
  const subagents = useSubagentSection({
    subjectId: shownId ?? '',
    children: children.map((child) => ({
      id: child.id,
      name: rowName(child, t),
      sizeBytes: child.sizeBytes,
      at: child.deletedAt,
      navigable: true,
    })),
    // 合计与总数只念 Node 半那两份读数（全部孩子的合计、被截断时的总数）：这里不再自己求和。
    total: detail?.subagentsTotal,
    totalSizeBytes: detail?.subagentsSizeBytes,
    note: t('detail.subagents.note'),
    // 导航面按 id 交接（`DetailNav` 的形状）：把 id 补回清册行是控制器的事，视图不第二次查孩子。
    ...(detailNav.onOpenChild === undefined ? {} : { onOpenChild: detailNav.onOpenChild }),
    ...(detailNav.onPrefetchChild === undefined ? {} : { onPrefetchChild: detailNav.onPrefetchChild }),
    t,
  })

  return (
    <SessionDetail
      state={state}
      subjectId={shownId ?? ''}
      head={{ displayName: title, sizeText: entry === null ? null : fileSizeText(entry.sizeBytes) }}
      infoRows={entry === null || detail === undefined ? [] : trashInfoRows(entry, detail, t)}
      {...(subagents === undefined ? {} : { subagents })}
      busy={busy}
      wide={wide}
      onRetry={onRetry}
      onBack={onBack}
      detailNav={detailNav}
      pager={pager}
      t={t}
    />
  )
}
