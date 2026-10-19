import { trashDirOf, type TrashEntry } from '../trash/entry.js'
import { groupOf } from '../trash/groups.js'
import { bareSessionId } from '../ports/host-port.js'
import type { DeleteDeps } from './delete-session.js'
import { verbError } from './errors.js'
import { createJournal, type JournalStep } from './member-journal.js'
import { planMemberRemovals, type MemberRemovalPlan } from './orphan-subagents.js'

/**
 * 彻底删除：从回收站里**真的**抹掉一条（或整组、或整站），并连带那些"还留在盘上、没被带走"的后代。
 *
 * 与另外两个动词的关系（ADR-0002）：它的 interface 只有"一个条目 id（或缺席 = 清空）"，
 * 批量的快照与"已被同批前一条带走"的判据不在这里（归 `verbs/batch.ts`）。
 *
 * **这条动词不做回滚**：目录删掉就没有"退回去"这回事（设计稿第十七批：删到一半失败时已删目录不回滚；
 * 带部分计数的 `details` 回执只属于 `orphan-clean`，purge 的 `removed` / `freedBytes` 仍只在成功回执里给）。
 * 所以它的 journal 只有正向步骤、没有 `undo`——顺序仍由 journal 统一表达，不再是手写的四段 `try/catch`。
 */
export function purgeTrash(deps: DeleteDeps) {
  return async function purgeTrash(
    entryId?: string,
    /** **只读**清册快照：批量层已经读过一次就递下来（ADR-0002）；收缩归批量层，动词不碰它。 */
    snapshot?: readonly TrashEntry[],
  ): Promise<{ removed: number; freedBytes: number }> {
    const all = snapshot ?? await deps.manifest.list()
    // 点的是父那一行 ⇒ **整组**一起清（孩子是跟着父进来的，不该在父被彻底删除后单独留在回收站里）；
    // 点的是孩子那一行（清单不单独列它，只有手工/降级路径会走到）⇒ 只清它这一棵（含它的盘上后代）。
    // 「这一组有谁」读 `trash/groups.ts`（ADR-0001）——与 `/list` 的装配、与恢复、与批量幂等判据同一条判据。
    const targets: readonly TrashEntry[] = entryId === undefined ? all : groupOf(all, entryId)
    if (entryId !== undefined && targets.length === 0) throw verbError('trash-empty', `回收站里没有这一条：${entryId}`)

    // 级联落地前删掉的父：孩子在盘上还剩着（10-15 稿 §10 那个「盘上还剩 M 个」）。彻底删除是这条存量
    // 唯一的收尾路——不连带它们，用户"彻底删除"之后盘上就真留下一堆点不到的目录。
    // 去重两边都去 `session-` 前缀（同一个会话在两代宿主里写法不同，见 `bareSessionId` 的来历）：
    // 清册里已有的行（跟着父一起进来的孩子）不按"盘上后代"再删一遍；一个父多层时也只计划一次。
    const manifestIds = new Set(targets.map(entry => bareSessionId(entry.sessionId)))
    // `sessionQuery` 缺席时端口回 `{}`（与 delete 的降级一致）：这次只清清册里的那部分，
    // 盘上残留留给 `GET /orphans` 兜底；不把一次能完成的对账/彻底删除折成失败。
    const membersByParent = await deps.host.subagentMembersBatch(targets.map(entry => entry.sessionId))
    const seenDisk = new Set<string>()
    /** 先只做准入与去重（全部是读），整组通过后再量目录/账本——任一成员在跑时一件计划都还没做。 */
    const candidates: Array<{ sessionId: string; projectDir: string }> = []

    for (const entry of targets) {
      for (const member of membersByParent[entry.sessionId] ?? []) {
        const bare = bareSessionId(member.sessionId)
        if (manifestIds.has(bare) || seenDisk.has(bare)) continue
        seenDisk.add(bare)
        // live 准入在**一切写之前**：任一后代在跑就整条拒绝、零副作用（与删除/孤儿清理同一口径）。
        if (await deps.host.isLive(member.sessionId)) {
          throw verbError('live', `会话正在运行：${member.sessionId}`)
        }
        candidates.push(member)
      }
    }
    const diskPlans: MemberRemovalPlan[] = await planMemberRemovals(deps, candidates)

    let freedBytes = 0
    let removed = 0

    /**
     * 步骤顺序承重：**归档集先摘**（失败时目录还在，重试还能清）→ 再摘盘上后代的账本 → 最后删目录与清册行。
     * 每一条"删 + 摘行 + 摘活体 + 通告"合一步：它们的失败形状是同一个 `io`，而部分成功会经由下面的
     * 计数器如实交回（`removed` / `freedBytes`）。
     */
    const steps: JournalStep[] = [
      {
        label: '取消归档失败',
        run: async () => {
          for (const entry of targets) await deps.host.unarchive(entry.sessionId)
          for (const plan of diskPlans) await deps.host.unarchive(plan.sessionId)
        },
      },
      {
        label: '摘账本失败',
        run: async () => {
          for (const plan of diskPlans) {
            if (plan.workspaceId !== undefined) await deps.host.detach(plan.sessionId, plan.workspaceId)
          }
        },
      },
      {
        label: '删除回收站目录失败',
        run: async () => {
          for (const entry of targets) {
            const dir = trashDirOf(entry.id, deps.home)
            // 目录可能已被手工删掉：那就不再有字节可释放，但仍要摘清单行（否则回收站永远多一条点不开的）
            if (await deps.fs.exists(dir)) {
              freedBytes += await deps.fs.sizeOfDir(dir)
              await deps.fs.removeDir(dir)
            }
            await deps.manifest.remove(entry.id)
            removed += 1
            // 彻底删除也要把宿主内存里那一份请掉、并如实通告客户端（清单里可能是修复前删的，或它又活了过来）。
            // 同样不抛、不影响"已彻底删除"这个结果；只有知道宿主列表已经干净时才通告。
            const eviction = await deps.host.evictLive(entry.sessionId)
            if (eviction !== 'unknown') await deps.host.announceRemoved(entry.sessionId)
          }
        },
      },
      {
        label: '删除盘上后代目录失败',
        run: async () => {
          for (const plan of diskPlans) {
            await deps.fs.removeDir(plan.dir)
            removed += 1
            freedBytes += plan.bytes
            const eviction = await deps.host.evictLive(plan.sessionId)
            if (eviction !== 'unknown') await deps.host.announceRemoved(plan.sessionId)
          }
        },
      },
    ]

    const journal = createJournal(steps)
    // 部分成功不回滚、也不包装：调用方拿到的就是那一步的失败（`io` + 原文），已删掉的那些由它自己
    // 按"宁可重试一遍"处理——`removed` / `freedBytes` 仍只经成功回执交回。
    await journal.run()
    return { removed, freedBytes }
  }
}
