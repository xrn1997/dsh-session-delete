/**
 * 回收站清单的**对账**：以 `session-trash/` 里的条目目录为准，把清单修回一致（设计稿 2026-10-15 §9）。
 *
 * 手工动回收站**只需要动那一个目录**——多出来的目录在这里被重建出行、目录没了的行在这里被摘掉；
 * `~/.dsh/storages/` 那份清单从此是**内部索引**，不用手碰。
 *
 * 五条口径（都不是口味）：
 * ① **每次读清单都对账**（`GET /list` 的正文就是"对账 + 读"）：挂载、刷新、别处动过后的自动重读、
 *    客户端启动探测全走这条 ⇒ "改完目录不用再做任何事，下一次读就对了"。代价 = 每次读多一次目录枚举
 *    （本机 124 条，毫秒级）；**零漂移零写入**（快路直接返回原清单）。
 * ② **回收站根不在 ⇒ 整套跳过、一个字节都不动**：那不是"回收站空了"，是"这块地不在原处"
 *    （人为搬走、盘没挂上）——照常对账会把全部行的元数据一次判没。
 * ③ **重建行只写"文件里真有的事实"**：`id` = 目录名、`sessionId`/`cwd` 读日志 header、
 *    `projectDir` 由 `cwd` 经宿主同名算法 `projectKey` 反推、`deletedAt` 从目录名的时间戳解、
 *    `sizeBytes` 现场量。**文件侧没有副本的三件**按缺省落：`workspaceId: ''`（恢复时跳过挂账本，
 *    落在「未分组」）、`wasArchived: false`（恢复按"可见"还原）、`title: ''`（详情有日志标题兜底）
 *    ——这是重建的固有代价，不是可以"再读读看"的东西。
 * ④ **认不出 / 读不出的目录：不动、不列**（名字不像条目、目录里没有日志、header 读不出、尺寸量不出，
 *    各跳过各的）。它是"外人放进来的东西"，不是用户动作失败：跳过即静默，绝不为它删目录或抛掉整次读数。
 * ⑤ **幂等**：再跑一遍零写入；崩在任何一步，下一次读清单接着把它修完。
 *
 * 与三个写动词的**串行化不在这里**（那是传输层的事，见 `src/api/dispatch.ts` 的到达序链）：
 * 对账与删除/恢复/彻底删除都是"读清单 + 动文件 + 写清单"的多步，交错跑会互相踩——删除刚把目录搬进
 * 回收站、行还没写上时，对账抢先把这行按目录"重建"出来，随后又被真实行覆盖成降级元数据。
 */
import { isSinglePathSegment, parseEntryId, trashDirOf, type TrashEntry } from './entry.js'
import type { ManifestPort } from './manifest.js'
import type { FsPort } from '../ports/fs-port.js'
import { NO_CWD_PROJECT_DIR, projectKey } from '../ports/host-port.js'
import { pickSessionLog, readSessionHeader } from '../log/session-log.js'
import { TRASH_DIR_NAME } from '../shared/wire.js'

export interface ReconcileDeps {
  fs: FsPort
  manifest: ManifestPort
  home: string
}

/** 目录名是不是一条条目 id（形状契约在 `entry.ts`：`<删除时刻UTC>-<原目录名>`；
 *  原目录名还必须能安全地拼回磁盘路径——带分隔符的名字仍按"外人"跳过，不让一次对账读崩）。 */
function isEntryId(name: string): boolean {
  try {
    return isSinglePathSegment(parseEntryId(name).sessionDirName)
  } catch {
    return false
  }
}

/**
 * 从一个手工放进回收站的目录重建清单行。**任一件事实拿不到就整体放弃这一条**（回 `undefined`）：
 * 半截行比"不列"更坏——恢复会照它把目录搬去一个错的地方（同 `detail.ts` 那条"半截正文"的口径）。
 *
 * `sessionId` 取日志 header 的 `id`（恢复之后宿主按日志 header 建索引，那才是会话身份）；
 * header 缺席这个字段才回落到目录名里那段原目录名。
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
    raw = await deps.fs.readFile(`${dir}/${logName}`)
  } catch {
    return undefined
  }

  let header: ReturnType<typeof readSessionHeader>
  try {
    header = readSessionHeader(raw)
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
  const cwd = typeof header.cwd === 'string' ? header.cwd : ''
  return {
    id,
    sessionId: typeof header.id === 'string' && header.id !== '' ? header.id : sessionDirName,
    projectDir: cwd === '' ? NO_CWD_PROJECT_DIR : projectKey(cwd),
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
