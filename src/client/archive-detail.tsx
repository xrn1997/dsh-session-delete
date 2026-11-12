/**
 * 归档详情投影（`session-detail.tsx` 的归档档入口）：信息表**恰五行**
 * （项目 / 日志末条 / 会话 id / 大小 / 状态），无「回收站目录」「原本归档」；
 * 子会话段与回收站共用同一套呈现（数据来自宿主闭包，见 `src/trash/archive-detail.ts`）。
 *
 * 标题与大小与**选中行**配对：显示名走 `displayNameOf`（label 优先），大小只摆信息表那一行
 * （行的 `sizeBytes`，缺席显式「—」；计量行不重复）——详情只给正文与日志读数，不重算这两格。
 * 状态行认**主体自己的归档态**（不认导航道）：已归档主体（清单行、以及清单不可见时被打开的
 * 已归档孩子）说「已归档」；未归档孩子说「随归档父会话查看」。
 */
import type { Translate } from './copy.js'
import type { ArchiveDetailLike } from './remote.js'
import type { DetailState } from './use-detail-reader.js'
import type { ArchiveDetailSubject } from './use-archive-detail-reader.js'
import { detailNameOf, displayNameOf } from './trash-view.js'
import { fileSizeText } from './ui/format.js'
import {
  SessionDetail,
  timeText,
  type DetailInfoRow,
  type DetailNav,
  type DetailPager,
} from './session-detail.js'
import { useSubagentSection } from './subagent-section.js'

export interface ArchiveDetailProps {
  state: DetailState<ArchiveDetailSubject, ArchiveDetailLike>
  busy: boolean
  wide: boolean
  /** 与回收站档同一面导航（按会话 id 交接，`DetailNav`）；孩子视图由 `parentContext` 在场判定。 */
  detailNav: DetailNav
  onRetry: () => void
  onBack: () => void
  pager: DetailPager
  t: Translate
}

export function ArchiveDetail({
  state,
  busy,
  wide,
  detailNav,
  onRetry,
  onBack,
  pager,
  t,
}: ArchiveDetailProps) {
  const row = state.kind === 'idle' ? null : state.subject
  const detail = state.kind === 'ready' || state.kind === 'holding' ? state.detail : undefined
  const project = detail === undefined || detail.cwd === '' ? t('trash.project.unknown') : detail.cwd
  const sizeText = row?.sizeBytes === undefined ? null : fileSizeText(row.sizeBytes)
  const infoRows: readonly DetailInfoRow[] = row === null || detail === undefined ? [] : [
    { label: t('detail.field.project'), value: project, title: project },
    // 「日志末条」是详情侧的标签：它与列表的「最后活动」（updatedAt）不是同一个读数，不共用名字。
    { label: t('archive.detail.lastEvent'), value: timeText(detail.lastActivity) },
    { label: t('detail.field.sessionId'), value: row.sessionId, title: row.sessionId, code: true },
    { label: t('detail.field.size'), value: sizeText ?? t('archive.size.absent') },
    {
      label: t('archive.detail.statusLabel'),
      // 状态行认**这一读**的主体归档态（wire 的 `archived`），不认主体快照或 `parentContext`：
      // 宿主侧解除归档后，旧快照会照错说「已归档」；导航道也会串（清单不可见时已归档孩子走孩子视图）。
      value: detail.archived ? t('archive.detail.status') : t('archive.detail.statusChild'),
    },
  ]
  const subagents = useSubagentSection({
    subjectId: row?.sessionId ?? '',
    // 单级：孩子视图里不再交出 `onOpenChild`，这一段整段不画（与回收站同一条，ADR-0055）。
    children: detailNav.onOpenChild === undefined ? [] : (detail?.subagents ?? []).map((child) => ({
      id: child.sessionId,
      name: displayNameOf({ label: child.label ?? '', title: child.title, sessionId: child.sessionId }, t),
      sizeBytes: child.sizeBytes,
      at: child.updatedAt,
      navigable: true,
    })),
    total: detail?.subagentsTotal,
    totalSizeBytes: detail?.subagentsSizeBytes,
    // 归档行的大小可以整批读不出（`sessionPersistence` 缺席或该行没给读数）：这一格与清单行走
    // 同一个键 `archive.size.absent`，缺席就是缺席，不拿 0 冒充。
    sizeAbsentText: t('archive.size.absent'),
    note: t('archive.subagents.note'),
    ...(detailNav.onOpenChild === undefined ? {} : { onOpenChild: detailNav.onOpenChild }),
    ...(detailNav.onPrefetchChild === undefined ? {} : { onPrefetchChild: detailNav.onPrefetchChild }),
    t,
  })
  return (
    <SessionDetail
      state={state}
      subjectId={row?.sessionId ?? ''}
      // 大小只住信息表那一行；标题排的 head 只交显示名（计量行不再重复同一个数）。
      head={{ displayName: row === null ? '' : detailNameOf(row, detail, displayNameOf(row, t)), sizeText: null }}
      infoRows={infoRows}
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
