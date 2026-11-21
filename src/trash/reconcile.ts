/**
 * 回收站清单的**对账**：以 `session-trash/` 里的条目目录为准，把清单修回一致（CONTEXT.md 的「对账」条）。手工动回收站**只需要动那一个目录**——
 * 多出来的目录在这里被重建出行、目录没了的行在这里被摘掉；`~/.dsh/storages/` 那份清单从此是**内部索引**，不用手碰。
 *
 * 五条口径（都不是口味）：① **每次真相读都对账**（`src/trash/ledger.ts` 的 `list()`）：挂载、刷新、别处动过后的自动重读全走这条；
 * pure 读面对账会写行，必须排在到达序链上，所以走 `raw()`。代价 = 每次真相读多一次目录枚举；**零漂移零写入**。
 * ② **回收站根不在 ⇒ 整套跳过、一个字节都不动**：那不是"回收站空了"，照常对账会把全部行的元数据一次判没。
 * ③ **重建行只写"文件里真有的事实"**：`id` = 目录名、`sessionId`/`cwd` 读日志 header、`projectDir` 由 `cwd` 经 `projectKey` 反推、
 * `deletedAt` 从目录名时间戳解、`sizeBytes` 现场量。**文件侧没有副本的三件**按缺省落：`workspaceId: ''`（恢复落「未分组」）、
 * `wasArchived: false`、`title: ''`——这是重建的固有代价，不是可以"再读读看"的东西。
 * ④ **认不出 / 读不出的目录：不动、不列**（各跳过各的）：header 走有界头读，窗口里切不出完整帧同样算认不出；**跳过即静默**，绝不为它删目录或抛掉整次读数。
 * ⑤ **幂等**：再跑一遍零写入；崩在任何一步，下一次读清单接着把它修完。
 *
 * 与三个写动词的**串行化不在这里**（传输层的事，见 `src/api/dispatch.ts` 的到达序链）：交错跑会互相踩——删除刚把目录搬进回收站、行还没写上时，
 * 对账抢先把这行按目录"重建"出来，随后又被真实行覆盖成降级元数据。
 */
import { isSinglePathSegment, parseEntryId, trashDirOf, type TrashEntry } from './entry.js'
import type { ManifestPort } from './manifest.js'
import type { FsReconcilePort } from '../ports/fs-port.js'
import { projectDirOfCwd } from '../ports/host-port.js'
import { pickSessionLog, readSessionHeader } from '../log/session-log.js'
import { TRASH_DIR_NAME } from '../shared/wire.js'
import { decodeSessionSegment } from '../shared/session-path.js'

/** 对账只为读 header：**有界头读**的窗口（1 MiB）。header 是第一帧里的第一行（实测远小于 1 KiB），这个数是"不为一行把整本日志读进内存"的读取预算，
 *  不是"日志大小上限"。窗口切在帧中间时按前缀读的容忍口径丢掉最后那个不完整帧——header 在第一个完整帧里，照样读得到；不在窗口里才算"认不出"。 */
const HEADER_READ_BYTES = 1024 * 1024

export interface ReconcileDeps {
  fs: FsReconcilePort
  manifest: ManifestPort
  home: string
}

/** 目录名是不是一条条目 id（形状契约在 `entry.ts`）：段是宿主 `encodeSegment` 的产物（存量条目也可能还是原始目录名），无论哪种都必须能安全拼回磁盘路径——
 *  带分隔符的名字仍按"外人"跳过，不让一次对账读崩。 */
function isEntryId(name: string): boolean {
  try {
    return isSinglePathSegment(parseEntryId(name).sessionDirName)
  } catch {
    return false
  }
}

/**
 * 从一个手工放进回收站的目录重建清单行。**任一件事实拿不到就整体放弃这一条**（回 `undefined`）：半截行比"不列"更坏——恢复会照它把目录搬去错的地方。
 * `sessionId` 取日志 header 的 `id`（恢复之后宿主按日志 header 建索引，那才是会话身份）；header 缺席这个字段才回落到目录段——反解回原始 id。
 */
async function buildEntry(deps: ReconcileDeps, id: string): Promise<TrashEntry | undefined> {
  const dir = trashDirOf(id, deps.home)

  let logName: string | undefined
  try {
    logName = pickSessionLog(await deps.fs.listFiles(dir))
  } catch {
    return undefined
  }
  if (logName === undefined) return undefined

  let raw: Buffer
  try {
    // 有界头读：header 在文件开头，读到 1 MiB 还没读到就是"认不出"（下面 ④ 的跳过口径）。
    raw = await deps.fs.readFileHead(`${dir}/${logName}`, HEADER_READ_BYTES)
  } catch {
    return undefined
  }

  let header: ReturnType<typeof readSessionHeader>
  try {
    header = readSessionHeader(raw, { tolerateTruncatedTail: true })
  } catch {
    return undefined
  }
  if (header === undefined) return undefined

  let sizeBytes: number
  try {
    sizeBytes = await deps.fs.sizeOfDir(dir)
  } catch {
    return undefined
  }

  const { deletedAt, sessionDirName } = parseEntryId(id)
  // 判据与删除计划、会话列表投影**同一支**（`src/ports/host-port.ts` 的 `projectDirOfCwd`）：只有 header 里没有 cwd 才落 `_no-cwd`，
  // 空串照常编码。同一条会话在删除、恢复与孤儿扫描里不能指向两个目录。
  const cwd = typeof header.cwd === 'string' ? header.cwd : undefined
  return {
    id,
    sessionId: typeof header.id === 'string' && header.id !== '' ? header.id : decodeSessionSegment(sessionDirName),
    projectDir: projectDirOfCwd(cwd),
    workspaceId: '',
    wasArchived: false,
    deletedAt,
    title: '',
    sizeBytes,
  }
}

/** 对账并回清单——**返回的就是修好之后的那份**（与 `manifest.list()` 同序：最近删除在前）。 */
export async function reconcileTrash(deps: ReconcileDeps): Promise<TrashEntry[]> {
  const rows = await deps.manifest.list()
  const root = `${deps.home}/${TRASH_DIR_NAME}`
  if (!(await deps.fs.exists(root))) return rows

  const dirIds = new Set<string>()
  for (const name of await deps.fs.listDirs(root)) {
    if (isEntryId(name)) dirIds.add(name)
  }
  const rowIds = new Set(rows.map((row) => row.id))

  const drops = rows.filter((row) => !dirIds.has(row.id))
  const rebuilds: TrashEntry[] = []
  for (const id of dirIds) {
    if (rowIds.has(id)) continue
    const entry = await buildEntry(deps, id)
    if (entry !== undefined) rebuilds.push(entry)
  }
  if (drops.length === 0 && rebuilds.length === 0) return rows

  for (const row of drops) await deps.manifest.remove(row.id)
  for (const entry of rebuilds) await deps.manifest.add(entry)
  return await deps.manifest.list()
}
