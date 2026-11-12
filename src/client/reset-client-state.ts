/**
 * 浏览器半**所有模块级现场**的一枚复位口：测试的 beforeEach / afterEach 只调这一条。
 *
 * 为什么收：现场分散在八个 module（清单、首帧快照、多选、行登记、撤销台、删除请求、批量确认、
 * 主视图），每个测试文件各自抄一份"要清哪些"的清单；新增一个现场就要挨个文件补一行，漏掉的
 * 文件会带着上一用例的状态跑。这里沿 `store.ts` 的骨架登记全部复位口——新增现场只改这一个文件。
 *
 * 只给测试用（生产没有调用点）：不引入新的运行期状态，只把各 module 已有的复位函数串起来。
 */
import { resetArchiveStore } from './archive-store.js'
import { resetBatchConfirm } from './batch-confirm.js'
import { resetSelection } from './batch-selection-store.js'
import { resetDeleteRequest } from './delete-confirm.js'
import { resetHostRows } from './host-rows.js'
import { resetMainView } from './main-view.js'
import { clearTrashSnapshot } from './trash-snapshot.js'
import { resetTrashStore } from './trash-store.js'
import { resetUndoNotice } from './undo-notices.js'

export function resetClientState(): void {
  resetTrashStore()
  resetArchiveStore()
  clearTrashSnapshot()
  resetSelection()
  resetHostRows()
  resetUndoNotice()
  resetDeleteRequest()
  resetBatchConfirm()
  resetMainView()
}
