/**
 * 回收站的详情读路：通用机制（`use-detail-reader.ts`）的薄实例——账本 = `trash-snapshot.ts` 的跨挂载账本
 * （键 = 条目 id），fetch = `deps.detail`；机制只住通用层一份。
 */
import type { TrashEntryWire } from '../shared/wire.js'
import type { SessionDeleteRemote, TrashDetailLike } from './remote.js'
import {
  emptiedTrash,
  rowGone,
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
  readonly subject: TrashEntryWire | null
  readonly topLevel: boolean
  readonly present: (entryId: string) => boolean
  /** 主体换成还没读过的那一条时要不要自动补读；窄档给 false（方向键只移选中），显式读与意图预取另算。 */
  readonly autoRead?: boolean
}

/** 对外形状就是通用那一台（主体键 `subject` = 清册行）：回收站实例不再抄一份字段清单。 */
export type TrashDetailReader = DetailReader<TrashEntryWire, TrashDetailLike>

/** 回收站账本 seam：`trash-snapshot.ts` 的跨挂载账本三函数原样接上（写时复制与淘汰口径都在那头）。 */
const TRASH_LEDGER: DetailLedger<TrashDetailLike> = {
  read: readCachedTrashDetail,
  write: writeTrashDetail,
  // 读数失败与行消失都只是这一条详情作废（`rowGone` 的「读数作废」那一面）；整本作废只走 `clear`。
  forget: rowGone,
  clear: emptiedTrash,
}

const entryIdOf = (entry: TrashEntryWire): string => entry.id

export function useTrashDetailReader(input: TrashDetailReaderInput): TrashDetailReader {
  return useDetailReader<TrashEntryWire, TrashDetailLike>({
    fetch: input.deps.detail,
    ledger: TRASH_LEDGER,
    subject: input.subject,
    idOf: entryIdOf,
    topLevel: input.topLevel,
    present: input.present,
    autoRead: input.autoRead ?? true,
  })
}
