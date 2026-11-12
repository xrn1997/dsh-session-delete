/**
 * 宿主**投影缓存**（`session_projcache`）的孤儿判定、手动清理与永久删除收尾。
 *
 * 缓存是宿主的派生数据：一条会话一份记录，按 `session id` 落盘（`storages/session_projcache/sessions/`）。
 * 宿主只写不删——删除会话不会让它消失，所以永久删除必须自己把对应记录带走；否则每删一个会话就
 * 永久多一份记录。孤儿判定与手动清理共用**同一条判据**（永久删除的收尾按实际删掉的会话 id 逐条删）：
 *
 *   缓存里的 id −（会话语料/持久化 ∪ 清册 raw 行 ∪ `session-trash/` 目录）＝ 孤儿。
 *
 * id 按 `bareSessionId` 比较：`session-x` 与 `x` 是同一个会话的两代写法（见 `domain/closure.ts`），
 * 不归一就会把还在册的会话误报成孤儿。
 *
 * 判据只读调用方交来的 **raw 清册行**与**目录名**：**不对账、不写清册**。`ledger.list()` 会把目录
 * 不在的幽灵行摘掉，而幽灵行正是本判据要保护的面（ADR-0062）；清理若先对账，就会把报告里保护住的
 * 缓存删掉，并顺手改写清册。失败关闭规则（缺一不可）：
 * - 语料读面缺席或抛错 ⇒ `io`（活体只有它看得见，持久化列表不是全集）；
 * - 持久化服务在场但列表读面回缺席/抛错 ⇒ `io`（可能有看不见的 persisted-only 会话）；
 * - 持久化服务缺席 ⇒ 没有 persisted-only 会话，语料已是完整的保护面；
 * - 投影缓存域不可用 ⇒ `io`；**服务缺席不算「没有记录」**，旧版本可能留下记录。
 *
 * 删除只经宿主端口（`storageDomain.get('session_projcache').table('sessions')` 的同一条写链），
 * **不直接删 `storages/` 下的文件**：绕过域的内存权威会让运行中的宿主与盘上不一致。
 */
import { bareSessionId, sessionIdShapes } from '../domain/closure.js'
import { parseEntryId, type TrashEntry } from './entry.js'
import { TRASH_DIR_NAME, type ProjectionCacheCleanupWire, type ProjectionCacheOrphanReportWire } from '../shared/wire.js'
import type { CoreDeps, RemovalDeps } from '../deps.js'
import type { CorpusRead, SessionIdentity } from '../ports/host-port.js'
import { verbError } from '../verbs/errors.js'

/**
 * 仍在册的会话 id（去前缀后的形状）：语料（live ∪ persisted）与持久化列表**两条都并进来**——
 * 语料读面可能跳过冷无 cwd 的会话，只信一条会把还在盘上的会话误报成孤儿。
 *
 * 清册 raw 行与 `session-trash/` 目录都算保护面：行在、目录不在的幽灵行也保护，宁可少报一条也不误删；
 * 手工搬进回收站、还没对账成行的目录按目录名保护（条目 id 的 `<时间戳>-<会话目录名>` 逆推）。
 *
 * 失败关闭见模块头：语料缺席或任一读面抛错折 `io`（活体只有语料看得见）；持久化服务在场但
 * 列表缺席折 `io`；持久化服务**确实缺席**时没有 persisted-only 会话，语料是完整保护面。
 */
async function protectedBareIds(deps: CoreDeps, trash: readonly TrashEntry[]): Promise<Set<string>> {
  const protectedIds = new Set<string>()
  let corpus: CorpusRead<readonly SessionIdentity[]>
  try {
    corpus = await deps.host.listSessions()
  } catch (error) {
    throw verbError('io', '读取会话语料失败：sessionQuery.listSessions 抛错，无法判断投影缓存是否孤儿', error)
  }
  // 语料缺席 ⇒ 失败关闭：`listSessions` = 磁盘持久化 ∪ 活体，**活体只有它看得见**——持久化
  // 列表不是全集，拿它当唯一真相会把没落盘的活体会话的缓存误报成孤儿（「看不见 ≠ 没有」）。
  if (!corpus.available) {
    throw verbError('io', '读取会话语料失败：sessionQuery 缺席，看不见活体会话，无法判断投影缓存是否孤儿')
  }
  for (const session of corpus.value) protectedIds.add(bareSessionId(session.sessionId))
  let persisted: CorpusRead<ReadonlyMap<string, number | undefined>>
  try {
    persisted = await deps.host.persistedSizes()
  } catch (error) {
    throw verbError('io', '读取持久化会话失败：sessionPersistence.list 抛错，无法判断投影缓存是否孤儿', error)
  }
  if (persisted.available) {
    for (const sessionId of persisted.value.keys()) protectedIds.add(bareSessionId(sessionId))
  } else if (deps.host.persistenceMounted()) {
    // 服务在场却没有列表：可能有语料看不见的 persisted-only 会话，不能拿语料当唯一真相。
    throw verbError('io', '持久化服务在场但会话列表读不出，无法判断投影缓存是否孤儿')
  }
  for (const row of trash) protectedIds.add(bareSessionId(row.sessionId))
  const trashRoot = `${deps.home}/${TRASH_DIR_NAME}`
  try {
    if (await deps.fs.exists(trashRoot)) {
      for (const name of await deps.fs.listDirs(trashRoot)) {
        try {
          protectedIds.add(bareSessionId(parseEntryId(name).sessionDirName))
        } catch {
          // 认不出的目录是外人：对账也不为它建行，这里不拿它保护任何缓存记录。
        }
      }
    }
  } catch (error) {
    throw verbError('io', '读取回收站目录失败，无法判断投影缓存是否孤儿', error)
  }
  return protectedIds
}

/** 当前投影缓存里没有任何会话痕迹的记录 id（原样，供删除用；比较时才归一）。 */
export async function orphanProjectionCacheIds(
  deps: CoreDeps,
  trash: readonly TrashEntry[],
): Promise<readonly string[]> {
  const cache = await deps.host.projectionCacheIds()
  if (!cache.available) {
    throw verbError('io', '投影缓存域不可用：宿主没有已打开的 session_projcache.sessions 存储域（服务缺席不算空表）')
  }
  const protectedIds = await protectedBareIds(deps, trash)
  return cache.value.filter((sessionId) => !protectedIds.has(bareSessionId(sessionId)))
}

/** 维护卡的只读报告：只念条数，不算体积（缓存记录不是本插件的字节读数面）。 */
export async function reportProjectionCacheOrphans(
  deps: CoreDeps,
  trash: readonly TrashEntry[],
): Promise<ProjectionCacheOrphanReportWire> {
  return { count: (await orphanProjectionCacheIds(deps, trash)).length }
}

/**
 * 维护卡的聚合清理：用路由交来的 **raw 清册行** + 目录名保护，**不先对账、不改写清册**——
 * `ledger.list()` 会摘掉幽灵行，让报告保护住的缓存反被删掉（ADR-0062 的边界）。
 *
 * 删除失败不抛成顶层失败：批量写链抛错回 `{ removed: 0, failed: 名单条数 }`；旧宿主逐条删除的
 * 部分失败由端口回真实 `{ removed, failed }`。界面清完自动重查，真实剩余量以重查为准。
 */
export async function cleanProjectionCacheOrphans(
  deps: RemovalDeps,
  trash: readonly TrashEntry[],
): Promise<ProjectionCacheCleanupWire> {
  const ids = await orphanProjectionCacheIds(deps, trash)
  if (ids.length === 0) return { removed: 0, failed: 0 }
  try {
    const receipt = await deps.host.dropProjectionCache(ids)
    if (receipt.failed > 0) {
      console.warn(`[dsh-session-delete] 投影缓存清理部分失败：已清 ${receipt.removed} 条、未清 ${receipt.failed} 条`)
    }
    return receipt
  } catch (error) {
    console.warn(`[dsh-session-delete] 投影缓存清理失败：${ids.length} 条`, error)
    return { removed: 0, failed: ids.length }
  }
}

/**
 * 永久删除的逐会话收尾：**这一条会话删掉了，就删这一条的缓存**。
 *
 * 只由 `executeRemoval` 在某个成员的目录/清册行确实处理完之后调用；不按计划名单批量扫，也不碰
 * 这一趟没删成的会话。缓存 key 按 `sessionIdShapes` 覆盖两代写法（`session-x` / `x` 是同一个
 * 会话；只删原写法会漏掉另一代的记录）。缓存是派生数据：删除失败只留 warning，不把已经完成的
 * 会话删除翻成失败；漏掉的记录由维护卡下一次检查兜住。
 */
export async function dropDeletedSessionCache(
  deps: Pick<RemovalDeps, 'host'>,
  sessionId: string,
): Promise<void> {
  try {
    const receipt = await deps.host.dropProjectionCache(sessionIdShapes(sessionId))
    if (receipt.failed > 0) {
      console.warn(`[dsh-session-delete] 投影缓存清理部分失败（会话已删除）：${sessionId}，未清 ${receipt.failed} 条`)
    }
  } catch (error) {
    console.warn(`[dsh-session-delete] 投影缓存清理失败（会话已删除）：${sessionId}`, error)
  }
}