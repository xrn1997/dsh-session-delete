/**
 * 归档详情读路：通用机制（`use-detail-reader.ts`）的薄实例——
 * 账本是**挂载内 Map**（键 = sessionId，容量与淘汰口径住 `detail-ledger.ts`），卸载即丢、
 * **不进 `trash-snapshot`**（归档档的清单/选中/详情都不进首帧快照；键域是会话 id，与回收站的
 * 条目 id 两不相干——混一台账本会让 `reloadSucceeded` 永远裁不到归档详情、还会挤掉回收站详情）。
 * 归档档的顶层行与「离清单的孩子视图」共用这一本；孩子视图交 `topLevel: false`（不保持上一条），
 * 读孩子时由 `rootOf` 带上那条已归档父会话，供 `/archive-detail` 做闭包校验。
 */
import { useCallback, useEffect, useRef } from 'react'
import type { ArchiveSubagentWire } from '../shared/wire.js'
import { useArchiveRevision } from './archive-store.js'
import { writeDetail, type DetailLedger } from './detail-ledger.js'
import type { ArchiveDetailLike, SessionDeleteRemote } from './remote.js'
import { useDetailReader, type DetailReader } from './use-detail-reader.js'

/** 归档详情主体：清单里的已归档行，或父详情子会话段里那条孩子（后者可缺时间读数）。 */
export interface ArchiveDetailSubject {
  readonly sessionId: string
  /** 这个主体**自己**的归档态；**缺席 = 清单行**（进了归档清单就是已归档的定义）。
   *  孩子行照抄 wire 的 `archived`。状态行认这一格（`false` ⇒「随归档父会话查看」），
   *  **不认导航道**——清单不可见时已归档孩子也会进孩子视图，那时照实说「已归档」。 */
  readonly archived?: boolean
  readonly projectDir: string
  readonly title: string
  readonly label?: string
  readonly updatedAt?: number
  readonly updatedAtSource?: 'prompt' | 'created'
  readonly sizeBytes?: number
}

/** 模块级取键函数：身份恒稳（归档主体的身份是会话 id）。 */
const sessionIdOf = (row: ArchiveDetailSubject): string => row.sessionId

/** 孩子视图的主体：只带详情投影真正消费的格；时间读数缺席就不造 0。 */
export function childSubjectOf(child: ArchiveSubagentWire): ArchiveDetailSubject {
  return {
    sessionId: child.sessionId,
    archived: child.archived,
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

  // 归档集变了 ⇒ 账本里每条的 `subagents[].archived`、主体归档态与孩子视图的旧快照都可能过期：
  // 整本作废并重读当前主体；其余条目等重新选中时自然重读。`useArchiveRevision` 只在本档自己的
  // A1 / 自救动作 / 恢复删除后递增（ADR-0060 决定第 4 条），不做轮询。
  const archiveRevision = useArchiveRevision()
  const lastRevision = useRef(archiveRevision)
  useEffect(() => {
    if (lastRevision.current === archiveRevision) return
    lastRevision.current = archiveRevision
    reader.clearAll()
    const current = input.subject
    if (current !== null) void reader.ensure(sessionIdOf(current))
  }, [archiveRevision, reader, input.subject])

  return reader
}
