/** 回收站的一条记录。`id` 由 `makeEntryId` 生成（`<删除时刻>-<原目录名>`）——**它不是随手起的键**：
 *  回收站目录名就是它，恢复也按它反推出原目录名放回（设计稿 §3），所以 id 的形状有契约意义。
 *  其余字段在删除那一刻就地取。 */
export interface TrashEntry {
  id: string
  sessionId: string
  projectDir: string
  /** 删除时它所属的工作区；**空串 = 删除时就没有账目**（「未分组」的会话，宿主的"删除工作区"会造出这种），
   *  恢复时据此跳过 `attach`。 */
  workspaceId: string
  /** 删除**之前**的归档态。删除会把"原本未归档"的会话归档（藏起来，免得它掉进「未分组」），
   *  恢复时按这个字段还原可见性：true ⇒ 仍处归档态，false ⇒ 取消归档放回树里。 */
  wasArchived: boolean
  deletedAt: number
  /** 删除时**尽力**取的会话标题（来源：`storages/session_projcache/sessions/<会话id>.json`
   *  里的 `rows.title.val`）；取不到存空串，绝不因此让删除失败。 */
  title: string
  /** 删除时用 `fs.sizeOfDir` 量到的会话目录字节数。 */
  sizeBytes: number
}

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

export function sessionDirOf(projectDir: string, sessionDirName: string, home: string): string {
  return `${home}/sessions/${projectDir}/${sessionDirName}`
}

export function trashDirOf(entryId: string, home: string): string {
  return `${home}/session-trash/${entryId}`
}
