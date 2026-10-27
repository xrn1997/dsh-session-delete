import { TRASH_DIR_NAME } from '../shared/wire.js'

/** 回收站的一条记录。`id` 由 `makeEntryId` 生成（`<删除时刻>-<原目录名>`）——**它不是随手起的键**：
 *  回收站目录名就是它，恢复也按它反推出原目录名放回（CONTEXT.md 的「条目」条），所以 id 的形状有契约意义。
 *  其余字段在删除那一刻就地取。 */
export interface TrashEntry {
  id: string
  sessionId: string
  projectDir: string
  /** 删除时它所属的工作区；**空串 = 删除时就没有账目**（「未分组」的会话，宿主的"删除工作区"会造出这种），
   *  恢复时据此跳过 `attach`。 */
  workspaceId: string
  /** 删除前的归档态，只作事实记录：删除不再改变归档，恢复也不按它还原可见性。
   *  旧条目迁移用它区分“删除时被我们归档的”（false 且当前仍归档）与“用户删前自己归档的”（true）。 */
  wasArchived: boolean
  deletedAt: number
  /** 删除时**尽力**取的会话标题（来源：宿主 projection cache 服务；底层是
   *  `storages/session_projcache/sessions/<会话id>.json` 里的 `title` 投影）。取不到存空串，绝不因此让删除失败。 */
  title: string
  /** 删除时用 `fs.sizeOfDir` 量到的会话目录字节数。 */
  sizeBytes: number
  /** **组语义**：这一条是跟着父一起进回收站的子会话 ⇒ 记父那一行的 `id`。
   *  缺席 = 这一行是父（或它自己就是被单独删掉的）。清单据此把孩子折进父行、不单独列。
   *  清册被清后由目录重建出来的行没有这个字段（文件侧没有它的副本，与
   *  `workspaceId`/`wasArchived`/`title` 同一类降级），那一趟它们会各占一行——那是"分组信息随清册一起没了"
   *  的如实结果，不假装知道（CONTEXT.md 的「无主子会话」条）。 */
  parentEntryId?: string
}

/**
 * 清册里**每条记录都必须有**的那几格（`TrashEntry` 的非可选字段）——运行期校验器与「文件里真有的事实」
 * 共用这一份清单。
 *
 * **可选字段不在这里**：`parentEntryId`（级联那批加的）缺席是合法的——老行没有它，缺了就是"没有父"；
 * 校验器只管这几格的类型，其余键**原样带走**（`parse` 交回的就是 `raw` 本身）⇒ 新字段照旧存得住。
 *
 * 键集与接口由 `tests/wire-shape.test.ts` 双向钉住：接口加一个必填字段而这里没跟 ⇒ 测试红。
 */
export const REQUIRED_ENTRY_FIELDS = {
  id: 'string', sessionId: 'string', projectDir: 'string', workspaceId: 'string',
  wasArchived: 'boolean', deletedAt: 'number', title: 'string', sizeBytes: 'number',
} as const

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

export function makeEntryId(deletedAt: number, sessionDirName: string): string {
  const d = new Date(deletedAt)
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  return `${stamp}-${sessionDirName}`
}

const ENTRY_ID_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-(.+)$/

/** `makeEntryId` 的逆。时间戳按 UTC 拆字段再 `Date.UTC` 合回——不交给 `Date.parse`
 *  去猜（`20260930T130500Z` 不是任何被承认的日期格式，猜出来的是 NaN）。 */
export function parseEntryId(id: string): { deletedAt: number; sessionDirName: string } {
  const m = ENTRY_ID_RE.exec(id)
  if (!m) throw new Error(`bad entry id: ${id}`)
  const [, y, mo, d, h, mi, s, sessionDirName] = m
  return { deletedAt: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), sessionDirName }
}

/** 路径里的每一段都必须是**单段**：这一层不信宿主的 `header.id` 与清册，破坏性动词直接删目录。
 *  `/`、`\`、`.`、`..` 与 NUL 都能把递归删除带出 `sessions/` / `session-trash/`。 */
export function isSinglePathSegment(value: string): boolean {
  return value !== '' && value !== '.' && value !== '..' && !/[\\/\0]/u.test(value)
}

function assertSingleSegment(value: string, label: string, allowEmpty = false): void {
  if (value === '') {
    if (allowEmpty) return
    throw new Error(`${label} 不能为空`)
  }
  if (!isSinglePathSegment(value)) {
    throw new Error(`${label} 不是单段路径：${value}`)
  }
}

/** `sessionDirName` 允许空串：恢复的预检用它取**项目根**（`sessions/<projectDir>`），不是会话目录。 */
export function sessionDirOf(projectDir: string, sessionDirName: string, home: string): string {
  assertSingleSegment(projectDir, '项目目录名')
  assertSingleSegment(sessionDirName, '会话目录名', true)
  return `${home}/sessions/${projectDir}/${sessionDirName}`
}

export function trashDirOf(entryId: string, home: string): string {
  assertSingleSegment(entryId, '回收站条目 id')
  return `${home}/${TRASH_DIR_NAME}/${entryId}`
}
