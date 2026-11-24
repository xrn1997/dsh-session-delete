/**
 * 附件的**唯一域模块**：内容块提取、ID/路径闸、引用扫描、独占计划与执行。两条红线：① 只删 `$DSH_HOME/attachments/v1/objects` 下的图片；
 * 普通文件、tmp、v2、cache 一律不碰，源文件（$DSH_HOME 之外）没有进入路径拼接的入口。② 只要剩余引用源读不出来，就整体跳过（fail closed）——宁可留孤儿，不许删共享；
 * "读不出来"包括：读失败、目录非空却没有规范 zstd 日志（明文/陌生布局）、JSON 超出扫描上限、日志有坏行或尾巴被截断。
 * 宿主的内核写锁 `session.lock` 例外：恒为 0 字节时既不算读不懂、也不算"目录里有东西"；非空才回落到上面的 fail closed（判据见 `imageIdsOfDir`）。
 *
 * **批级扫描（一次批一扫）**：一批被删目录的独占计划走 `planBatchImageAttachmentRemoval`——候选按组收集（每组被删目录的
 * `imageIdsOfDir`），剩余引用**全批只扫一趟**（排除面 = 全部被删目录），候选 → 组的映射（`byGroup`）只收进计划的对象、
 * 且对象**单归属**（同批多组候选命中同一个对象时只归第一组，按组序先到先得）——批尾按组拆回逐条读数时相加才不双计。
 * 附件尾只带走**真删掉的目录**的独占副本（判据与顺序住 `verbs/permanent-removal.ts` 的 `executeAttachmentTail`）。
 */
import path from 'node:path'
import { isAbsentPath } from '../ports/fs-port.js'
import type { FsReferenceScanPort, FsReferenceScanRemovalPort } from '../ports/fs-port.js'
import type { SessionDeleteConfig } from '../config.js'
import { TRASH_DIR_NAME, type AttachmentCleanupWire } from '../shared/wire.js'
import { isCanonicalSessionLogName, MAX_SESSION_LOG_BYTES, pickSessionLog, readWholeSessionLog, walkSessionLog, type SessionRecord } from '../log/session-log.js'

export interface ImageRef {
  kind: 'image'
  id: string
  mediaType?: string
  bytes: number
  width?: number
  height?: number
  name?: string
}

export interface FileRef {
  kind: 'file'
  id: string
  name: string
  bytes: number
}

export type AttachmentRef = ImageRef | FileRef

const ATTACHMENT_ID = /^sha256:[0-9a-f]{64}$/u

/** 合法附件 ID：形状是 `sha256:` + 64 位小写十六进制。谓词必须收成**模板字面量形状**而不是 `string`：`attachmentPathOf` 里
 *  `!isAttachmentId(id)` 的假支若按「是 string」取反会被 TS 收成 `never`（参数本来就是 string），插值就成了 never 读数。 */
export function isAttachmentId(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && ATTACHMENT_ID.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** 路径缺席的判据只有一处：`src/ports/fs-port.ts` 的 `isAbsentPath`（ENOENT / ENOTDIR）。`statFile` / `readFile` / `sizeOfDir` 的读错误里，
 *  "不在"只认这两枚；权限、盘挂、I/O 错误都必须露成读不出（ADR-0039），别在这里另写只有 ENOENT 的抄本。 */
export const isMissing = isAbsentPath

/** 合法附件 ID → 宿主附件库里的绝对路径。`name` 不参与拼接。 */
export function attachmentPathOf(home: string, kind: 'image' | 'file', id: string): string {
  if (!isAttachmentId(id)) throw new Error(`附件 id 形状不对：${id}`)
  const hex = id.slice('sha256:'.length)
  const root = kind === 'image' ? 'objects' : 'file-objects'
  const base = `${home}/attachments/v1/${root}`
  const file = `${base}/${hex.slice(0, 2)}/${hex}`
  // 纵深防御：即便上面的正则将来被改宽，解析结果也必须仍在 store 根下。按**目录包含关系**判（resolve + relative），
  // 不按字符串前缀——前缀判会被 `../` 之类骗过去。
  const rel = path.relative(path.resolve(base), path.resolve(file))
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`附件路径越界：${id}`)
  }
  return file
}

/** 一条消息的 `content[]` 里的附件块；畸形 id / 非附件段一律跳过。 */
export function attachmentsInContent(content: unknown): AttachmentRef[] {
  if (!Array.isArray(content)) return []
  const out: AttachmentRef[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    const type = part.type
    const attachment = part.attachment
    if ((type !== 'image' && type !== 'file') || !isRecord(attachment)) continue
    const id = attachment.attachmentId
    if (!isAttachmentId(id)) continue
    if (type === 'image') {
      out.push({
        kind: 'image',
        id,
        ...(typeof attachment.mediaType === 'string' ? { mediaType: attachment.mediaType } : {}),
        bytes: numberOf(attachment.bytes),
        ...(numberOf(attachment.width) > 0 ? { width: numberOf(attachment.width) } : {}),
        ...(numberOf(attachment.height) > 0 ? { height: numberOf(attachment.height) } : {}),
        ...(typeof attachment.name === 'string' ? { name: attachment.name } : {}),
      })
    } else {
      out.push({
        kind: 'file',
        id,
        name: typeof attachment.name === 'string' ? attachment.name : '',
        bytes: numberOf(attachment.bytes),
      })
    }
  }
  return out
}

function contentArraysOf(record: SessionRecord): unknown[] {
  const data = record.data
  if (!isRecord(data)) return []
  const out: unknown[] = []
  if (Array.isArray(data.content)) out.push(data.content)
  if (isRecord(data.message) && Array.isArray(data.message.content)) out.push(data.message.content)
  return out
}

/** 一条日志的图片 id 读数，外加「这条日志是否完整」的判据。 */
interface LogImageIds {
  ids: Set<string>
  /** 有值 = 日志不完整（坏行 / 截断尾巴），它的引用集合不可信。 */
  damaged?: string
}

/**
 * `walkSessionLog` 对坏行与截断尾巴是**跳过并计数**，不抛：引用扫描只看解析出来的记录，就会把"少读了一行"当成"那一行没有引用"。
 * `.damaged` 有值 ⇒ 调用方必须按不可读处理。
 */
function scanImageIdsInLog(raw: Buffer): LogImageIds {
  const ids = new Set<string>()
  const stats = walkSessionLog(raw, (record) => {
    for (const content of contentArraysOf(record)) {
      for (const ref of attachmentsInContent(content)) if (ref.kind === 'image') ids.add(ref.id)
    }
  })
  const damaged = stats.unparsedLines > 0 || stats.truncatedTailBytes > 0
    ? `日志不完整（坏行 ${stats.unparsedLines} 条、截断尾巴 ${stats.truncatedTailBytes} 字节）`
    : undefined
  return { ids, ...(damaged === undefined ? {} : { damaged }) }
}

export interface AttachmentReadDeps {
  fs: FsReferenceScanPort
  home: string
  config: Pick<SessionDeleteConfig, 'maxJsonRefBytes'>
}

export interface AttachmentRemovalDeps extends AttachmentReadDeps {
  fs: FsReferenceScanRemovalPort
}

/** 宿主写日志时的临时名：`session.vN.jsonl.zstd.<hash>.tmp`（内容写完后才 rename 成规范名）。
 *  出处：asar `dsh-session-persistence-jsonl` 的 `writeSyncedTempFile`。 */
const TEMP_LOG_NAME = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?\.[0-9a-f]+\.tmp$/u

/**
 * 宿主**格式迁移**的暂存名：`session.migration.<token>.jsonl[.zstd].tmp`。出处：asar `dsh-session-persistence-jsonl` 的 `writeSyncedTemp`
 * （`randomToken` 是十六进制；`suffix` 是 `.jsonl.zstd` 或 `.jsonl`——**不是**裸 `.zstd`）。与普通临时日志的差别决定它**可以**在有规范日志时被忽略：
 * 迁移暂存是**同一会话历史日志的完整拷贝**（header + 全部事件），而它存在的前提是历史规范日志还在原处——那份可读日志已覆盖它的全部引用。
 * 写盘临时日志（`TEMP_LOG_NAME`）相反：可能装着还没进规范日志的新记录，非空就算不可读。**没有规范日志时它仍按不可读 fail closed**。
 */
const MIGRATION_TEMP_LOG_NAME = /^session\.migration\.[0-9a-f]+\.jsonl(?:\.zstd)?\.tmp$/u

/**
 * 宿主的内核写锁：宿主以写方式打开它即截断、**从不写入内容**、释放也从不删除（POSIX 上是 `flock(2)` 的目标，Windows 上没有这个文件）——
 * 每个已实体化的会话目录、以及跟着搬进回收站的条目里，它都与日志常态并存。锁只表达"谁在写"，不承载会话记录。
 */
const LOCK_NAME = 'session.lock'

/** 规范日志之外允许并存的几类文件：更老一代的规范日志（新代包含旧代）、0 字节临时日志（没有消息），以及宿主的**格式迁移暂存**
 *  （完整拷贝，可读规范日志已覆盖其引用——判据见 {@link MIGRATION_TEMP_LOG_NAME}）。其余任何文件都可能是规范日志没覆盖到的引用
 *  （例如写入中的非空临时日志），一律按不可读处理。宿主的 `session.lock` 到不了这里——它在 `imageIdsOfDir` 挑名单时就按"不是会话内容"剥掉了。 */
async function unreadableExtraFile(
  deps: AttachmentReadDeps,
  dir: string,
  names: readonly string[],
): Promise<string | undefined> {
  for (const name of names) {
    if (isCanonicalSessionLogName(name)) continue
    if (MIGRATION_TEMP_LOG_NAME.test(name)) continue
    if (!TEMP_LOG_NAME.test(name)) return `${dir}: 规范日志旁还有无法确认的文件 ${name}`
    const stat = await deps.fs.statFile(`${dir}/${name}`)
    if (stat.size > 0) return `${dir}: 规范日志旁还有非空临时日志 ${name}`
  }
  return undefined
}

interface ImageDirRead {
  ids: Set<string>
  /** 有值 = 日志不完整（坏行 / 截断尾巴），它的引用集合不可信。 */
  unreadable?: string
  /** 本次扫描确认目录在场；缺席或探测失败都算 false，批级补跑守卫据此 fail closed。 */
  present: boolean
}

/** 一个会话目录里的图片引用；`unreadable` 有值 = 这一组不可知（调用方按"跳过它"处理）。
 *
 *  **没有规范 zstd 日志 ≠ 没有引用**：明文日志、别的版本/布局、以及子目录都可能藏着引用。**有规范日志但还有子目录也不够**：日志只覆盖本目录。
 *  **规范日志旁的文件也要过关**：老一代可并存；0 字节临时日志是空产物；迁移暂存是完整拷贝。非空临时日志、明文日志或其他文件仍 fail closed。
 *  **整本日志读取有上限**（`readWholeSessionLog`，值住 `MAX_SESSION_LOG_BYTES`）：超限与读错误都按不可读处理，不为一份读不完的引用源把整本字节压进内存，更不折成"没有引用"。
 *  **宿主的内核写锁不是会话内容**：0 字节的锁在判目录形状之前先剥掉——不然每个已实体化的会话目录都会被读成"读不懂"，整份引用扫描在真机上恒跳过；
 *  非空的锁说明我们对这个文件的理解失效，仍按不可读处理。
 */
async function imageIdsOfPresentDir(
  deps: AttachmentReadDeps,
  dir: string,
): Promise<Omit<ImageDirRead, 'present'>> {
  let names: string[]
  try {
    names = await deps.fs.listFiles(dir)
    const withoutLock: string[] = []
    for (const name of names) {
      if (name !== LOCK_NAME) { withoutLock.push(name); continue }
      if ((await deps.fs.statFile(`${dir}/${name}`)).size > 0) {
        return { ids: new Set(), unreadable: `${dir}: 锁文件 ${name} 非空，无法确认里面没有引用` }
      }
    }
    names = withoutLock
  } catch (error) {
    return { ids: new Set(), unreadable: String(error) }
  }
  const log = pickSessionLog(names)
  if (log === undefined) {
    if (names.length > 0 && names.every((name) => TEMP_LOG_NAME.test(name))) {
      let subdirs: string[]
      try {
        subdirs = await deps.fs.listDirs(dir)
        if (subdirs.length === 0) {
          let allEmpty = true
          for (const name of names) {
            const stat = await deps.fs.statFile(`${dir}/${name}`)
            if (stat.size > 0) { allEmpty = false; break }
          }
          if (allEmpty) return { ids: new Set() }
        }
      } catch (error) {
        return { ids: new Set(), unreadable: String(error) }
      }
    }
    if (names.length > 0) return { ids: new Set(), unreadable: `${dir}: 没有可读的会话日志` }
    let subdirs: string[]
    try {
      subdirs = await deps.fs.listDirs(dir)
    } catch (error) {
      return { ids: new Set(), unreadable: String(error) }
    }
    if (subdirs.length > 0) return { ids: new Set(), unreadable: `${dir}: 没有可读的会话日志` }
    return { ids: new Set() }
  }
  try {
    const extra = await unreadableExtraFile(deps, dir, names)
    if (extra !== undefined) return { ids: new Set(), unreadable: extra }
    const subdirs = await deps.fs.listDirs(dir)
    if (subdirs.length > 0) {
      return { ids: new Set(), unreadable: `${dir}: 目录里还有子目录，规范日志覆盖不到它们` }
    }
    // 整本读取（含大小闸）归 `readWholeSessionLog`：超限与读错误都按不可读跳过（fail closed）——上限是"读不出"的判据，不是截断阈值。
    const logPath = `${dir}/${log}`
    const read = await readWholeSessionLog(deps.fs, logPath)
    if (!read.ok) {
      return {
        ids: new Set(),
        unreadable: read.kind === 'too-large'
          ? `${logPath}: 日志 ${read.size} 字节超过整本读取上限 ${MAX_SESSION_LOG_BYTES} 字节，未扫描`
          : String(read.cause),
      }
    }
    const scan = scanImageIdsInLog(read.raw)
    // 损坏的日志：解析出来的 id 也不可信（少读的行可能正是引用），整组按不可读处理。
    if (scan.damaged !== undefined) return { ids: new Set(), unreadable: `${dir}/${log}: ${scan.damaged}` }
    return { ids: scan.ids }
  } catch (error) {
    return { ids: new Set(), unreadable: String(error) }
  }
}

export async function imageIdsOfDir(deps: AttachmentReadDeps, dir: string): Promise<ImageDirRead> {
  let present: boolean
  try {
    present = await deps.fs.exists(dir)
  } catch (error) {
    return { ids: new Set(), unreadable: String(error), present: false }
  }
  if (!present) return { ids: new Set(), present: false }
  return { present: true, ...await imageIdsOfPresentDir(deps, dir) }
}

interface RemainingImageRefs {
  ids: Set<string>
  unreadable: string[]
}

/** 读全部剩余引用源；任何一处读不出都记进 `unreadable`。 */
async function collectRemainingImageRefs(
  deps: AttachmentReadDeps,
  input: {
    sessionRoot: string
    excludeDirs: readonly string[]
  },
): Promise<RemainingImageRefs> {
  const exclude = new Set(input.excludeDirs)
  const visited = new Set<string>()
  const ids = new Set<string>()
  const unreadable: string[] = []

  const visit = async (dir: string): Promise<void> => {
    if (exclude.has(dir) || visited.has(dir)) return
    visited.add(dir)
    const read = await imageIdsOfDir(deps, dir)
    if (read.unreadable !== undefined) unreadable.push(read.unreadable)
    for (const id of read.ids) ids.add(id)
  }

  if (await deps.fs.exists(input.sessionRoot)) {
    for (const project of await deps.fs.listDirs(input.sessionRoot)) {
      const projectDir = `${input.sessionRoot}/${project}`
      if (exclude.has(projectDir)) continue
      for (const session of await deps.fs.listDirs(projectDir)) await visit(`${projectDir}/${session}`)
    }
  }
  // 清册是缓存不是真相：`session-trash` 下每个目录都是剩余引用源，包括没进清册的（手工拷贝/半途对账失败）。
  // 只认这一层子目录——递归会把条目内部目录当成新引用源。
  const trashRoot = `${deps.home}/${TRASH_DIR_NAME}`
  if (await deps.fs.exists(trashRoot)) {
    for (const name of await deps.fs.listDirs(trashRoot)) await visit(`${trashRoot}/${name}`)
  }

  const scanJson = async (root: string): Promise<void> => {
    if (!(await deps.fs.exists(root))) return
    const maxJsonRefBytes = deps.config.maxJsonRefBytes
    const stack = [root]
    const seen = new Set<string>()
    while (stack.length > 0) {
      const dir = stack.pop() as string
      try {
        // `listDirs` 跟随软链之后，目录图不再是树：按**真实路径**去重，软链绕回祖先不会无线下潜。
        const real = await deps.fs.realpath(dir)
        if (seen.has(real)) continue
        seen.add(real)
        for (const name of await deps.fs.listDirs(dir)) stack.push(`${dir}/${name}`)
        for (const name of await deps.fs.listFiles(dir)) {
          if (!name.endsWith('.json')) continue
          const file = `${dir}/${name}`
          const stat = await deps.fs.statFile(file)
          if (stat.size > maxJsonRefBytes) {
            // 超过上限不读，但**绝不能**当成"这里没有引用"——它可能正是那个共享引用的唯一出处。
            unreadable.push(`${file}: JSON 引用源 ${stat.size} 字节超过扫描上限 ${maxJsonRefBytes} 字节，未扫描`)
            continue
          }
          const text = (await deps.fs.readFile(file)).toString('utf8')
          for (const match of text.matchAll(/sha256:[0-9a-f]{64}/gu)) ids.add(match[0])
        }
      } catch (error) {
        unreadable.push(`${dir}: ${String(error)}`)
      }
    }
  }
  await scanJson(`${deps.home}/storages`)
  await scanJson(`${deps.home}/cache`)

  return { ids, unreadable }
}

/**
 * 剩余引用扫描的 fail-closed 收口（独占计划 / 执行期复核 / 孤儿扫描三处共用同一形状）：扫描抛错或任一引用源读不出都回 `reason`，
 * 读得出才交引用集——「读不出」绝不折成「没有引用」（ADR-0020；缺席判据见 ADR-0039）。`reasonLabel` 只补前半句，后半句是读数原文。
 */
async function remainingRefsFailClosed(
  deps: AttachmentReadDeps,
  excludeDirs: readonly string[],
  reasonLabel: string,
): Promise<{ ok: true; refs: RemainingImageRefs } | { ok: false; reason: string }> {
  try {
    const refs = await collectRemainingImageRefs(deps, { sessionRoot: `${deps.home}/sessions`, excludeDirs })
    if (refs.unreadable.length > 0) return { ok: false, reason: `${reasonLabel}：${refs.unreadable[0]}` }
    return { ok: true, refs }
  } catch (error) {
    return { ok: false, reason: `${reasonLabel}：${String(error)}` }
  }
}

interface PlannedImageRemoval {
  id: string
  path: string
  bytes: number
}

export interface ImageRemovalPlan {
  entries: readonly PlannedImageRemoval[]
  bytes: number
  skipped?: string
}

/** 候选日志读不出的 skip 原因句：计划面的合计与批驱动的 per-group 拆分（`src/verbs/batch.ts` 的读数合成）都念它——
 *  同一句只许一个家，两处各写各的措辞会让同一批回执里长出两种说法。 */
export function unreadableCandidatesReason(count: number): string {
  return `${count} 个被删会话日志读不出`
}

/** 附件对象 stat 读不出的 skip 原因句：同上，合计（计划面）与逐组（批驱动合成）共用这一家。 */
export function unreadableObjectsReason(count: number): string {
  return `${count} 个附件对象读不出`
}

/** 执行期复核读不出剩余引用源的 fail-closed 原因：复核结果按 `recheckSkipped` 结构化交回，
 *  批驱动合成 per-id 读数**不拿原文子串当判据**（认不出就等于把 fail-closed 的用户可见落点丢了，ADR-0041）。 */
const RECHECK_SKIP_REASON = '读不到剩余引用源，无法复核独占'

/** 批级附件计划的一组：`id` 是这一组在批里的身份（purge 按条目 id、orphan-clean 按根 id），`dirs` 是本组被删目录。 */
export interface BatchAttachmentGroup {
  readonly id: string
  readonly dirs: readonly string[]
}

/** 一批一份的独占计划：`plan` 全批一份（候选 ∪ + **一次**剩余引用扫描），`byGroup` 是候选 → 组的映射——
 *  只收进 `plan.entries` 的对象，且对象单归属（一个对象只出现在一个组的集合里）。 */
export interface BatchAttachmentPlan {
  readonly plan: ImageRemovalPlan
  readonly byGroup: ReadonlyMap<string, ReadonlySet<string>>
  /** 每组候选日志读不出的次数：skipped 按组归因——只落真正执行成功组的回执，不串台（ADR-0070 边界）。 */
  readonly unreadableCandidatesByGroup: ReadonlyMap<string, number>
  /** 每组 stat 读不出的附件对象数（按 `owner` 的单归属记）：同样是逐组归因，不进 `sharedSkipped`。 */
  readonly unreadableObjectsByGroup: ReadonlyMap<string, number>
  /** 全批共享的 skip 原因：只有「剩余引用证明失败」这一种——候选与对象的读不出都逐组记。 */
  readonly sharedSkipped?: string
  /** 扫描时确认在场的目录；第二波只按路径 membership 放行不够，缺席时读成空集不算扫过。 */
  readonly presentDirs: ReadonlySet<string>
}

/**
 * 批级独占计划：候选 = 各组被删目录日志里的图片 id（逐组 `imageIdsOfDir`）；剩余引用 = 活动会话 + 全部未删
 * `session-trash` 目录 + storages/cache，**全批只扫一趟**（排除面 = 全部被删目录）。剩余引用源读不出 ⇒ 整体跳过；
 * 候选日志读不出 / 附件对象 stat 失败 ⇒ 只跳过那一部分，其余照常。
 * 对象单归属：一个对象被多组候选命中时只归**第一组**（组序先到先得）——批尾拆回逐条读数时批内相加才不双计。
 * 同 id 的两组按**并集**合并候选（调用点保证 id 唯一；重复时丢后一组等于静默漏删，宁可合并不静默）。
 */
export async function planBatchImageAttachmentRemoval(
  deps: AttachmentReadDeps,
  groups: readonly BatchAttachmentGroup[],
): Promise<BatchAttachmentPlan> {
  const candidatesByGroup = new Map<string, Set<string>>()
  const unreadableCandidatesByGroup = new Map<string, number>()
  const presentDirs = new Set<string>()
  const readsByDir = new Map<string, Awaited<ReturnType<typeof imageIdsOfDir>>>()
  let unreadableCandidates = 0
  for (const group of groups) {
    const ids = new Set<string>()
    let groupUnreadable = 0
    for (const dir of new Set(group.dirs)) {
      let read = readsByDir.get(dir)
      const firstRead = read === undefined
      if (read === undefined) {
        read = await imageIdsOfDir(deps, dir)
        readsByDir.set(dir, read)
      }
      if (read.present) presentDirs.add(dir)
      if (read.unreadable !== undefined) {
        if (firstRead) unreadableCandidates += 1
        groupUnreadable += 1
        continue
      }
      for (const id of read.ids) ids.add(id)
    }
    if (groupUnreadable > 0) {
      unreadableCandidatesByGroup.set(group.id, (unreadableCandidatesByGroup.get(group.id) ?? 0) + groupUnreadable)
    }
    const previous = candidatesByGroup.get(group.id)
    if (previous === undefined) candidatesByGroup.set(group.id, ids)
    else for (const id of ids) previous.add(id)
  }

  const skipReasons: string[] = []
  if (unreadableCandidates > 0) skipReasons.push(unreadableCandidatesReason(unreadableCandidates))

  const unreadableObjectsByGroup = new Map<string, number>()
  const candidates = new Set<string>()
  for (const ids of candidatesByGroup.values()) for (const id of ids) candidates.add(id)
  if (candidates.size === 0) {
    return {
      plan: { entries: [], bytes: 0, ...(skipReasons.length > 0 ? { skipped: skipReasons.join('；') } : {}) },
      byGroup: new Map(),
      unreadableCandidatesByGroup,
      unreadableObjectsByGroup,
      presentDirs,
    }
  }

  const excludeDirs = groups.flatMap((group) => [...group.dirs])
  const scanned = await remainingRefsFailClosed(deps, excludeDirs, '读不到剩余引用源，无法证明独占')
  if (!scanned.ok) {
    // 计划期候选读不出与证明失败说的不是同一件事，合计句都保留（ADR-0041 决定 4）。
    const skipped = [...skipReasons, scanned.reason].join('；')
    return {
      plan: { entries: [], bytes: 0, skipped },
      byGroup: new Map(),
      unreadableCandidatesByGroup,
      unreadableObjectsByGroup,
      presentDirs,
      sharedSkipped: scanned.reason,
    }
  }
  const remaining = scanned.refs

  // 对象单归属（组序先到先得）：一个对象多组候选命中时只有第一个组拿得到它的读数。
  const owner = new Map<string, string>()
  for (const group of groups) {
    for (const id of candidatesByGroup.get(group.id) ?? []) {
      if (!owner.has(id)) owner.set(id, group.id)
    }
  }

  const entries: PlannedImageRemoval[] = []
  const byGroup = new Map<string, Set<string>>()
  let bytes = 0
  let unreadableObjects = 0
  for (const id of candidates) {
    if (remaining.ids.has(id)) continue
    const path = attachmentPathOf(deps.home, 'image', id)
    try {
      const stat = await deps.fs.statFile(path)
      entries.push({ id, path, bytes: stat.size })
      bytes += stat.size
      const groupId = owner.get(id)
      if (groupId !== undefined) {
        const owned = byGroup.get(groupId) ?? new Set<string>()
        owned.add(id)
        byGroup.set(groupId, owned)
      }
    } catch (error) {
      // 对象已经不在：没有可删的字节，也不算失败。别的 stat 失败（权限/盘挂）**不是"不在"**：这一件这次没敢删，
      // 按单归属记进**它自己的组**（`unreadableObjectsByGroup`），合计句进 `skipped`——逐组归因不串台（ADR-0070）。
      if (!isMissing(error)) {
        unreadableObjects += 1
        const groupId = owner.get(id)
        if (groupId !== undefined) {
          unreadableObjectsByGroup.set(groupId, (unreadableObjectsByGroup.get(groupId) ?? 0) + 1)
        }
      }
    }
  }
  if (unreadableObjects > 0) skipReasons.push(unreadableObjectsReason(unreadableObjects))
  return {
    plan: { entries, bytes, ...(skipReasons.length > 0 ? { skipped: skipReasons.join('；') } : {}) },
    byGroup,
    unreadableCandidatesByGroup,
    unreadableObjectsByGroup,
    presentDirs,
  }
}

/** 复核结果：`plan` 是这一刻仍无引用的那一份；`recheckSkipped` 只在**复核读不出**剩余引用源时给——
 *  批驱动合成 per-id 读数按这格结构化地认领原因，不拿 `skipped` 原文子串当判据。 */
export interface RecheckedRemovalPlan {
  readonly plan: ImageRemovalPlan
  readonly recheckSkipped?: string
}

/**
 * 执行期复核：计划与真删对象之间隔着一整趟目录删除（秒级），这期间别的会话可能把同一张图（内容寻址 ⇒ 同一个 sha256 id）再引用一次，
 * 或派生存储新写一条引用。计划是数据、会过期：删对象之前用同一套剩余引用扫描再判一次，**只删这一刻仍无引用的那些**（ADR-0041）。
 *
 * 调用时机：会话 / 回收站目录已经删掉之后、`executeImageAttachmentRemoval` 之前——扫到的就是真正的"剩余"。读不出照旧 fail closed：回空计划 + `skipped`。
 * 空计划直接返回（不为零删付一次全 home 扫描）。
 */
export async function recheckImageRemovalExclusivity(
  deps: AttachmentReadDeps,
  plan: ImageRemovalPlan,
): Promise<RecheckedRemovalPlan> {
  if (plan.entries.length === 0) return { plan }
  const scanned = await remainingRefsFailClosed(deps, [], RECHECK_SKIP_REASON)
  if (!scanned.ok) {
    // 计划期的 `skipped` 不丢：两条原因说的不是同一件事（候选日志读不出 / 复核读不出），上屏时二选一等于替用户藏掉一条（ADR-0041 决定 4）。
    const skipped = plan.skipped === undefined ? scanned.reason : `${plan.skipped}；${scanned.reason}`
    return { plan: { entries: [], bytes: 0, skipped }, recheckSkipped: scanned.reason }
  }
  const remaining = scanned.refs
  const entries = plan.entries.filter((entry) => !remaining.ids.has(entry.id))
  const bytes = entries.reduce((total, entry) => total + entry.bytes, 0)
  return {
    plan: {
      entries,
      bytes,
      ...(plan.skipped === undefined ? {} : { skipped: plan.skipped }),
    },
  }
}

/**
 * 逐文件删；ENOENT 由端口的 `force` 吞掉；其他错误计数并继续。删除动作只认「`home` + `id` 自己推导出来的那一条路径」：
 * 计划是数据，手搭的/被改过的条目只要路径与推导不一致就拒绝（计数为失败，不删），源文件因此没有删除入口。
 * `failedIds` 逐个点名失败对象：批尾按组归失败读数要用（`failed` 计数保留）。
 */
export async function executeImageAttachmentRemoval(
  deps: AttachmentRemovalDeps,
  plan: ImageRemovalPlan,
): Promise<{ removed: number; freedBytes: number; failed: number; failedIds: readonly string[] }> {
  let removed = 0
  let freedBytes = 0
  let failed = 0
  const failedIds: string[] = []
  for (const entry of plan.entries) {
    let derived: string
    try {
      derived = attachmentPathOf(deps.home, 'image', entry.id)
    } catch (error) {
      failed += 1
      failedIds.push(entry.id)
      console.warn(`附件清理拒绝：计划条目的 id 形状不对：${entry.id}`, error)
      continue
    }
    if (derived !== entry.path) {
      failed += 1
      failedIds.push(entry.id)
      console.warn(`附件清理拒绝：计划路径与 id 推导不一致：${entry.id}`, entry.path)
      continue
    }
    try {
      await deps.fs.removeFile(derived)
      removed += 1
      freedBytes += entry.bytes
    } catch (error) {
      failed += 1
      failedIds.push(entry.id)
      console.warn(`附件清理失败：${entry.id}`, error)
    }
  }
  return { removed, freedBytes, failed, failedIds }
}

/* ── 孤儿附件：对象还在，但任何引用源都不再引用它 ─────────────────────────── */

/** 真实宿主的图片库布局是 `objects/<2 hex>/<64 hex>`；这两条形状之外的名字一律不是候选。 */
const OBJECT_PREFIX = /^[0-9a-f]{2}$/u
const OBJECT_NAME = /^[0-9a-f]{64}$/u

/**
 * 扫「当前没有任何引用源引用」的图片对象。引用侧与删除计划共用同一条判据（活动会话 + 全部 `session-trash` 目录 + `storages/cache` JSON）：
 * 任何一处读不出 ⇒ 整份报告跳过（fail closed），绝不把"读不出"折成"没有引用"。候选侧只认 `attachments/v1/objects` 下 `<2 hex>/<64 hex>`
 * 这一种真实形状：`file-objects` / `tmp` / `v2` / `cache` 与非规范名字一律不进候选——清理只处理 `.dsh` 内的图片副本。
 * 对象列表或 stat 读不出同样整份跳过：报告宁可失败，也不给一份"少算了一些"的清理计划。
 */
export async function scanOrphanImageAttachments(deps: AttachmentReadDeps): Promise<ImageRemovalPlan> {
  const scanned = await remainingRefsFailClosed(deps, [], '读不到引用源，无法判定孤儿附件')
  if (!scanned.ok) return { entries: [], bytes: 0, skipped: scanned.reason }
  const remaining = scanned.refs

  const objectsRoot = `${deps.home}/attachments/v1/objects`
  const entries: PlannedImageRemoval[] = []
  let bytes = 0
  try {
    if (!(await deps.fs.exists(objectsRoot))) return { entries: [], bytes: 0 }
    for (const prefix of await deps.fs.listDirs(objectsRoot)) {
      if (!OBJECT_PREFIX.test(prefix)) continue
      for (const name of await deps.fs.listFiles(`${objectsRoot}/${prefix}`)) {
        // 名字必须与所在前缀目录同头，否则 `attachmentPathOf` 推导出来的不是这个文件的路径。
        if (!OBJECT_NAME.test(name) || !name.startsWith(prefix)) continue
        const id = `sha256:${name}`
        if (remaining.ids.has(id)) continue
        const objectPath = attachmentPathOf(deps.home, 'image', id)
        const stat = await deps.fs.statFile(objectPath)
        entries.push({ id, path: objectPath, bytes: stat.size })
        bytes += stat.size
      }
    }
  } catch (error) {
    return { entries: [], bytes: 0, skipped: `读不到附件对象列表，无法判定孤儿：${String(error)}` }
  }
  return { entries, bytes }
}

/** 清掉扫描那一刻无引用的图片对象；扫描跳过 ⇒ 零删，并原样带回跳过的原因。
 *  线上读数就 `AttachmentCleanupWire` 那三格（外加可选 `skipped`）：执行回执的 `failedIds` 是批尾的内部读数，不过线。 */
export async function cleanOrphanImageAttachments(deps: AttachmentRemovalDeps): Promise<AttachmentCleanupWire> {
  const plan = await scanOrphanImageAttachments(deps)
  if (plan.skipped !== undefined) return { removed: 0, freedBytes: 0, failed: 0, skipped: plan.skipped }
  const run = await executeImageAttachmentRemoval(deps, plan)
  return { removed: run.removed, freedBytes: run.freedBytes, failed: run.failed }
}
