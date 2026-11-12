/**
 * 回收站的详情读路：通用机制（`use-detail-reader.ts`）的**薄实例**——
 * 账本 = `trash-snapshot.ts` 的模块级账本（键 = 条目 id），fetch = `deps.detail`。
 * 对外形状就是通用 `DetailState`（主体键 `subject`）：视图与控制器的语义住
 * `trash-detail.tsx` / `use-trash-panel-controller.ts`，机制只住通用层一份。
 */
import type { TrashEntryWire } from '../shared/wire.js'
import type { SessionDeleteRemote, TrashDetailLike } from './remote.js'
import {
  clearTrashDetails,
  forgetTrashDetail,
  readCachedTrashDetail,
  writeTrashDetail,
} from './trash-snapshot.js'
import type { DetailLedger } from './detail-ledger.js'
import {
  useDetailReader,
  type DetailReader,
} from './use-detail-reader.js'

type DetailDeps = Pick<SessionDeleteRemote, 'detail'>

export interface TrashDetailReaderInput {
  readonly deps: DetailDeps
  /** 当前详情主体（孩子视图 / 清单选中）；null = 没有主体。 */
  readonly subject: TrashEntryWire | null
  /** 主体是清单里的顶层行：孩子视图不保持上一条（它的返回键语义在 `childView` 上，会串）。 */
  readonly topLevel: boolean
  /** 上一条已就绪的详情是否仍在清单里：被清单换版收走就不再顶住画面。 */
  readonly present: (entryId: string) => boolean
}

/** 对外形状就是通用那一台（主体键 `subject` = 清册行）：回收站实例不再抄一份字段清单。 */
export type TrashDetailReader = DetailReader<TrashEntryWire, TrashDetailLike>

/** 回收站账本 seam：`trash-snapshot.ts` 的模块级账本三函数原样接上（写时复制与淘汰口径都在那头）。 */
const TRASH_LEDGER: DetailLedger<TrashDetailLike> = {
  read: readCachedTrashDetail,
  write: writeTrashDetail,
  forget: forgetTrashDetail,
  clear: clearTrashDetails,
}

/** 模块级取键函数：身份恒稳，不随渲染换引用（通用层把它放进 memo/effect 的依赖）。 */
const entryIdOf = (entry: TrashEntryWire): string => entry.id

export function useTrashDetailReader(input: TrashDetailReaderInput): TrashDetailReader {
  return useDetailReader<TrashEntryWire, TrashDetailLike>({
    fetch: input.deps.detail,
    ledger: TRASH_LEDGER,
    subject: input.subject,
    idOf: entryIdOf,
    topLevel: input.topLevel,
    present: input.present,
  })
}
