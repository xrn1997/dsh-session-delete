/**
 * 归档详情读路：通用机制（`use-detail-reader.ts`）的薄实例——
 * 账本是**挂载内 Map**（键 = sessionId，容量与淘汰口径住 `detail-ledger.ts`），卸载即丢、
 * **不进 `trash-snapshot`**（归档档的清单/选中/详情都不进首帧快照；键域是会话 id，与回收站的
 * 条目 id 两不相干——混一台账本会让 `reloadSucceeded` 永远裁不到归档详情、还会挤掉回收站详情）。
 * 归档档的顶层行与「离清单的孩子视图」共用这一本；孩子视图交 `topLevel: false`（不保持上一条），
 * 读孩子时由 `rootOf` 带上那条已归档父会话，供 `/archive-detail` 做闭包校验。
 */
import { useCallback, useRef } from 'react'
import type { ArchiveSubagentWire } from '../shared/wire.js'
import { useArchiveRevision } from './archive-store.js'
import { writeDetail, type DetailLedger } from './detail-ledger.js'
import type { ArchiveDetailLike, SessionDeleteRemote } from './remote.js'
import { useDetailReader, type DetailReader } from './use-detail-reader.js'
import { DEFAULT_REFRESH_COALESCE_MS, useGatedRefresh } from './use-gated-refresh.js'
import { useLatest } from './store.js'

/** 归档详情主体：清单里的已归档行，或父详情子会话段里那条孩子（后者可缺时间读数）。 */
export interface ArchiveDetailSubject {
  readonly sessionId: string
  readonly projectDir: string
  readonly title: string
  readonly label?: string
  readonly updatedAt?: number
  readonly updatedAtSource?: 'prompt' | 'created'
  readonly sizeBytes?: number
}

/** 模块级取键函数：身份恒稳（归档主体的身份是会话 id）。 */
const sessionIdOf = (row: ArchiveDetailSubject): string => row.sessionId

/** 孩子视图的主体：只带详情投影真正消费的格；时间读数缺席就不造 0。
 *  归档态不在主体上：状态行只认这一读的 `ArchiveDetailWire.archived`（ADR-0061 决定 4），
 *  主体的旧快照或导航道都不能替它。 */
export function childSubjectOf(child: ArchiveSubagentWire): ArchiveDetailSubject {
  return {
    sessionId: child.sessionId,
    projectDir: child.projectDir,
    title: child.title,
    ...(child.label === undefined ? {} : { label: child.label }),
    ...(child.updatedAt === undefined ? {} : { updatedAt: child.updatedAt }),
    ...(child.updatedAtSource === undefined ? {} : { updatedAtSource: child.updatedAtSource }),
    ...(child.sizeBytes === undefined ? {} : { sizeBytes: child.sizeBytes }),
  }
}

export function useArchiveDetailReader(input: {
  deps: Pick<SessionDeleteRemote, 'archiveDetail'>
  /** 归档档是否在眼前：不活动时控制器交 `subject: null`（没有读需求），这里只负责订失效。 */
  active: boolean
  subject: ArchiveDetailSubject | null
  present: (sessionId: string) => boolean
  /** 主体是清单里的顶层行：孩子视图不保持上一条（与回收站同一条）。 */
  topLevel: boolean
  /** 清单行（自己已归档）回 `undefined`；离清单的 id（含孩子视图尚未打开时的意图预取）带上清单选中行作只读根。 */
  rootOf: (sessionId: string) => string | undefined
}): DetailReader<ArchiveDetailSubject, ArchiveDetailLike> {
  // 惰性建一次（挂载内有效）；写入的挪队尾与淘汰与回收站那本同一条口径。
  const ledgerRef = useRef<DetailLedger<ArchiveDetailLike> | null>(null)
  if (ledgerRef.current === null) {
    const map = new Map<string, ArchiveDetailLike>()
    ledgerRef.current = {
      read: (id) => map.get(id),
      write: (id, detail) => { writeDetail(map, id, detail) },
      forget: (id) => { map.delete(id) },
      clear: () => { map.clear() },
    }
  }
  const { deps, rootOf } = input
  // undefined 的键由通道 adapter 统一省略（`remote.ts`），这里不再按缺席分支。
  const fetch = useCallback(
    (id: string, before?: number) => deps.archiveDetail(id, before, rootOf(id)),
    [deps, rootOf],
  )
  const reader = useDetailReader<ArchiveDetailSubject, ArchiveDetailLike>({
    fetch,
    ledger: ledgerRef.current,
    subject: input.subject,
    idOf: sessionIdOf,
    topLevel: input.topLevel,
    present: input.present,
  })

  // 归档集变了 ⇒ 账本里每条的 `subagents[].archived` 与主体的 `archived`（wire）都可能过期：
  // 整本作废并重读当前主体；其余条目等重新选中时自然重读。`useArchiveRevision` 只在本档自己的
  // A1 / 自救动作 / 恢复删除后递增（ADR-0060 决定第 4 条），不做轮询。
  // 节奏（档位门 / dirty / 单飞 / 合并窗）归共用生命周期。**作废落在 refresh 里、不落 revision 当场**：
  // `clearAll` 会把账本与在飞登记一起清掉，而通用读者在「主体在场、账本为空、没在读」时会由兜底
  // effect 立刻补读——当场作废等于给每一发修订开一条绕过窗口与单飞的读。放进 refresh：窗口到点先
  // 整本作废、同一拍立刻 ensure，兜底那一拍看到的已经是「在读」，不会抢跑；风暴里的多发修订只在
  // 结算后补一轮。代价是旧归档态最多多留一个合并窗（120ms），但读只发一次。
  const archiveRevision = useArchiveRevision()
  const current = useLatest({ subject: input.subject, ensure: reader.ensure, clearAll: reader.clearAll })
  useGatedRefresh({
    active: input.active,
    demand: input.subject !== null,
    revisions: [archiveRevision],
    refresh: async () => {
      const subject = current.current.subject
      if (subject === null) return
      current.current.clearAll()
      await current.current.ensure(sessionIdOf(subject))
    },
    policy: { coalesceMs: DEFAULT_REFRESH_COALESCE_MS },
  })

  return reader
}
