/**
 * 附件的**唯一域模块**：内容块提取、ID/路径闸、引用扫描、独占计划与执行。
 *
 * 两条红线：
 * ① 只删 `$DSH_HOME/attachments/v1/objects` 下的图片；普通文件、tmp、v2、cache 一律不碰；
 *    源文件（$DSH_HOME 之外）没有进入路径拼接的入口。
 * ② 只要剩余引用源读不出来，就整体跳过（fail closed）——宁可留孤儿，不许删共享。
 *    引用源"读不出来"包括：目录/文件读失败、目录非空却没有规范 zstd 日志（明文/陌生布局）、
 *    JSON 超出扫描上限、日志有坏行或尾巴被截断。
 */
import path from 'node:path'
import type { FsPort } from '../ports/fs-port.js'
import { TRASH_DIR_NAME, type AttachmentCleanupWire } from '../shared/wire.js'
import { isCanonicalSessionLogName, pickSessionLog, walkSessionLog, type SessionRecord } from '../log/session-log.js'

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

export function isAttachmentId(value: unknown): value is string {
  return typeof value === 'string' && ATTACHMENT_ID.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** `statFile` / `readFile` / `sizeOfDir` 里只有 ENOENT 能当"不在"；权限、盘挂、I/O 错误都必须露成读不出。 */
export function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === 'ENOENT'
}

/** 合法附件 ID → 宿主附件库里的绝对路径。`name` 不参与拼接。 */
export function attachmentPathOf(home: string, kind: 'image' | 'file', id: string): string {
  if (!isAttachmentId(id)) throw new Error(`附件 id 形状不对：${id}`)
  const hex = id.slice('sha256:'.length)
  const root = kind === 'image' ? 'objects' : 'file-objects'
  const base = `${home}/attachments/v1/${root}`
  const file = `${base}/${hex.slice(0, 2)}/${hex}`
  // 纵深防御：即便上面的正则将来被改宽，解析结果也必须仍在 store 根下。
  // 按**目录包含关系**判（resolve + relative），不按字符串前缀——前缀判会被 `../` 之类骗过去。
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
 * `walkSessionLog` 对坏行与截断尾巴是**跳过并计数**，不抛：引用扫描如果只看解析出来的记录，
 * 就会把"少读了一行"当成"那一行没有引用"。这里的 `.damaged` 有值 ⇒ 调用方必须按不可读处理。
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
  fs: Pick<FsPort, 'exists' | 'listFiles' | 'listDirs' | 'readFile' | 'statFile'>
  home: string
}

export interface AttachmentRemovalDeps extends AttachmentReadDeps {
  fs: Pick<FsPort, 'exists' | 'listFiles' | 'listDirs' | 'readFile' | 'statFile' | 'removeFile'>
}

/** 宿主写日志时的临时名：`session.vN.jsonl.zstd.<hash>.tmp`（内容写完后才 rename 成规范名）。 */
const TEMP_LOG_NAME = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?\.[0-9a-f]+\.tmp$/u

/** 规范日志之外允许并存的两类文件：更老一代的规范日志（新代包含旧代）与 0 字节临时日志（没有消息）。
 *  其余任何文件都可能是规范日志没覆盖到的引用（例如写入中的非空临时日志），一律按不可读处理。 */
async function unreadableExtraFile(
  deps: AttachmentReadDeps,
  dir: string,
  names: readonly string[],
): Promise<string | undefined> {
  for (const name of names) {
    if (isCanonicalSessionLogName(name)) continue
    if (!TEMP_LOG_NAME.test(name)) return `${dir}: 规范日志旁还有无法确认的文件 ${name}`
    const stat = await deps.fs.statFile(`${dir}/${name}`)
    if (stat.size > 0) return `${dir}: 规范日志旁还有非空临时日志 ${name}`
  }
  return undefined
}

/** 一个会话目录里的图片引用；`unreadable` 有值 = 这一组不可知（调用方按"跳过它"处理）。
 *
 *  **没有规范 zstd 日志 ≠ 没有引用**：明文日志、别的版本/布局、以及子目录都可能藏着引用。
 *  **有规范日志但目录里还有子目录也不够**：日志只覆盖本目录，子目录里的引用读它看不见——
 *  同样按不可读处理（宁可留下对象等维护卡兜底，不冒"没引用"）。
 *  **规范日志旁的文件也要过关**：老一代规范日志可以并存（新代包含旧代）；0 字节临时日志是
 *  写盘未完成的空产物，也没有引用。非空临时日志、明文日志或其他任何文件仍按不可读处理（fail closed）。
 */
export async function imageIdsOfDir(
  deps: AttachmentReadDeps,
  dir: string,
): Promise<{ ids: Set<string>; unreadable?: string }> {
  if (!(await deps.fs.exists(dir))) return { ids: new Set() }
  let names: string[]
  try {
    names = await deps.fs.listFiles(dir)
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
    const scan = scanImageIdsInLog(await deps.fs.readFile(`${dir}/${log}`))
    // 损坏的日志：解析出来的 id 也不可信（少读的行可能正是引用），整组按不可读处理。
    if (scan.damaged !== undefined) return { ids: new Set(), unreadable: `${dir}/${log}: ${scan.damaged}` }
    return { ids: scan.ids }
  } catch (error) {
    return { ids: new Set(), unreadable: String(error) }
  }
}

interface RemainingImageRefs {
  ids: Set<string>
  unreadable: string[]
}

/** 单个 JSON 引用源的扫描上限；超过就记成不可读（fail closed），**不许当作"没有引用"跳过**。 */
const MAX_JSON_REF_BYTES = 10 * 1024 * 1024

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
    const stack = [root]
    while (stack.length > 0) {
      const dir = stack.pop() as string
      try {
        for (const name of await deps.fs.listDirs(dir)) stack.push(`${dir}/${name}`)
        for (const name of await deps.fs.listFiles(dir)) {
          if (!name.endsWith('.json')) continue
          const file = `${dir}/${name}`
          const stat = await deps.fs.statFile(file)
          if (stat.size > MAX_JSON_REF_BYTES) {
            // 超过上限不读，但**绝不能**当成"这里没有引用"——它可能正是那个共享引用的唯一出处。
            unreadable.push(`${file}: JSON 引用源 ${stat.size} 字节超过扫描上限 ${MAX_JSON_REF_BYTES} 字节，未扫描`)
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

/**
 * 独占计划：候选 = 本次被删会话日志里的图片 id；剩余引用 = 活动会话 + 全部未删 `session-trash`
 * 目录 + storages/cache。
 * 剩余引用源读不出 ⇒ 整体跳过；候选日志读不出 / 附件对象 stat 失败 ⇒ 只跳过那一部分，其余照常。
 */
export async function planImageAttachmentRemoval(
  deps: AttachmentReadDeps,
  removedDirs: readonly string[],
): Promise<ImageRemovalPlan> {
  const candidates = new Set<string>()
  let unreadableCandidates = 0
  for (const dir of removedDirs) {
    const read = await imageIdsOfDir(deps, dir)
    if (read.unreadable !== undefined) {
      unreadableCandidates += 1
      continue
    }
    for (const id of read.ids) candidates.add(id)
  }

  const skipReasons: string[] = []
  if (unreadableCandidates > 0) skipReasons.push(`${unreadableCandidates} 个被删会话日志读不出`)

  if (candidates.size === 0) {
    return { entries: [], bytes: 0, ...(skipReasons.length > 0 ? { skipped: skipReasons.join('；') } : {}) }
  }

  let remaining: RemainingImageRefs
  try {
    remaining = await collectRemainingImageRefs(deps, {
      sessionRoot: `${deps.home}/sessions`,
      excludeDirs: removedDirs,
    })
  } catch (error) {
    return { entries: [], bytes: 0, skipped: `读不到剩余引用源，无法证明独占：${String(error)}` }
  }
  if (remaining.unreadable.length > 0) {
    return { entries: [], bytes: 0, skipped: `读不到剩余引用源，无法证明独占：${remaining.unreadable[0]}` }
  }

  const entries: PlannedImageRemoval[] = []
  let bytes = 0
  let unreadableObjects = 0
  for (const id of candidates) {
    if (remaining.ids.has(id)) continue
    const path = attachmentPathOf(deps.home, 'image', id)
    try {
      const stat = await deps.fs.statFile(path)
      entries.push({ id, path, bytes: stat.size })
      bytes += stat.size
    } catch (error) {
      // 对象已经不在：没有可删的字节，也不算失败。别的 stat 失败（权限/盘挂）**不是"不在"**：
      // 这一件这次没敢删，记进 `skipped`，但其余读得出的条目照常计划。
      if (!isMissing(error)) unreadableObjects += 1
    }
  }
  if (unreadableObjects > 0) skipReasons.push(`${unreadableObjects} 个附件对象读不出`)
  return { entries, bytes, ...(skipReasons.length > 0 ? { skipped: skipReasons.join('；') } : {}) }
}

/**
 * 逐文件删；ENOENT 由端口的 `force` 吞掉；其他错误计数并继续。
 *
 * 删除动作只认「`home` + `id` 自己推导出来的那一条路径」：计划是数据，手搭的/被改过的条目
 * 只要路径与推导不一致就拒绝（计数为失败，不删），源文件因此没有删除入口。
 */
export async function executeImageAttachmentRemoval(
  deps: AttachmentRemovalDeps,
  plan: ImageRemovalPlan,
): Promise<{ removed: number; freedBytes: number; failed: number }> {
  let removed = 0
  let freedBytes = 0
  let failed = 0
  for (const entry of plan.entries) {
    let derived: string
    try {
      derived = attachmentPathOf(deps.home, 'image', entry.id)
    } catch (error) {
      failed += 1
      console.warn(`附件清理拒绝：计划条目的 id 形状不对：${entry.id}`, error)
      continue
    }
    if (derived !== entry.path) {
      failed += 1
      console.warn(`附件清理拒绝：计划路径与 id 推导不一致：${entry.id}`, entry.path)
      continue
    }
    try {
      await deps.fs.removeFile(derived)
      removed += 1
      freedBytes += entry.bytes
    } catch (error) {
      failed += 1
      console.warn(`附件清理失败：${entry.id}`, error)
    }
  }
  return { removed, freedBytes, failed }
}

/* ── 孤儿附件：对象还在，但任何引用源都不再引用它 ─────────────────────────── */

/** 真实宿主的图片库布局是 `objects/<2 hex>/<64 hex>`；这两条形状之外的名字一律不是候选。 */
const OBJECT_PREFIX = /^[0-9a-f]{2}$/u
const OBJECT_NAME = /^[0-9a-f]{64}$/u

/**
 * 扫「当前没有任何引用源引用」的图片对象。
 *
 * 引用侧与删除计划共用同一条判据：活动会话 + 全部 `session-trash` 目录 + `storages/cache` JSON。
 * 任何一处读不出 ⇒ 整份报告跳过（fail closed），绝不把"读不出"折成"没有引用"。
 * 候选侧只认 `attachments/v1/objects` 下 `<2 hex>/<64 hex>` 这一种真实形状：`file-objects` /
 * `tmp` / `v2` / `cache` 与非规范名字一律不进候选——清理只处理 `.dsh` 内的图片副本。
 *
 * 对象列表或 stat 读不出同样整份跳过：报告宁可失败，也不给一份"少算了一些"的清理计划。
 */
export async function scanOrphanImageAttachments(deps: AttachmentReadDeps): Promise<ImageRemovalPlan> {
  let remaining: RemainingImageRefs
  try {
    remaining = await collectRemainingImageRefs(deps, {
      sessionRoot: `${deps.home}/sessions`,
      excludeDirs: [],
    })
  } catch (error) {
    return { entries: [], bytes: 0, skipped: `读不到引用源，无法判定孤儿附件：${String(error)}` }
  }
  if (remaining.unreadable.length > 0) {
    return { entries: [], bytes: 0, skipped: `读不到引用源，无法判定孤儿附件：${remaining.unreadable[0]}` }
  }

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

/** 清掉扫描那一刻无引用的图片对象；扫描跳过 ⇒ 零删，并原样带回跳过的原因。 */
export async function cleanOrphanImageAttachments(deps: AttachmentRemovalDeps): Promise<AttachmentCleanupWire> {
  const plan = await scanOrphanImageAttachments(deps)
  if (plan.skipped !== undefined) return { removed: 0, freedBytes: 0, failed: 0, skipped: plan.skipped }
  return executeImageAttachmentRemoval(deps, plan)
}
