/** 会话闭包（session closure）的唯一实现：`session-` 前缀归一 + 传递闭包 + 首见去重。
 *  零依赖纯部件：不碰盘、不碰端口类型，一个 import 都不许有。 */

/** 闭包里的一个节点：本部件只认这两个字段；端口的后代记录与语料的 SessionIdentity 都满足它。 */
export interface ClosureNode {
  readonly sessionId: string
  readonly projectDir: string
}

/** 会话 id 去掉 `session-` 前缀后的形状：两代宿主写法不同，归堆 / 去重一律按它比。 */
export function bareSessionId(id: string): string {
  return id.startsWith('session-') ? id.slice('session-'.length) : id
}

/** 一个 id 的全部可能写法，原写法在前：逐层问宿主时按这些写法问，宿主不替我们归一。 */
export function sessionIdShapes(id: string): string[] {
  const bare = bareSessionId(id)
  return [...new Set([id, bare, `session-${bare}`])]
}

/** parent(bare) 的传递闭包：深度不限、防环、首见去重（都按 bare 比）；结果不含根自己。
 *  真出现环时代价是「少数一条」，不是把清单读挂死。 */
export function closureOf<N extends ClosureNode>(
  children: ReadonlyMap<string, readonly N[]>,
  root: string,
): N[] {
  const out: N[] = []
  const seen = new Set([bareSessionId(root)])
  let frontier = [...seen]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const bare of frontier) {
      for (const kid of children.get(bare) ?? []) {
        const kidBare = bareSessionId(kid.sessionId)
        if (seen.has(kidBare)) continue
        seen.add(kidBare)
        out.push(kid)
        next.push(kidBare)
      }
    }
    frontier = next
  }
  return out
}

/** 同一条记录两代写法只认第一次出现（保原序）；全局去重只有这一处实现。 */
export function firstByBare<N extends ClosureNode>(members: readonly N[]): N[] {
  const seen = new Set<string>()
  const out: N[] = []
  for (const member of members) {
    const bare = bareSessionId(member.sessionId)
    if (seen.has(bare)) continue
    seen.add(bare)
    out.push(member)
  }
  return out
}

/** 整表语料 → 根闭包组：`parentSessionId` 不在 `known` 里的 subagent 各自成一组。
 *  组内后代走 `closureOf`，`claimed` 让一条记录只归第一个认领它的根。
 *  后代也必须是 subagent 起源：普通 fork 的 `parentSession` 只是来源记录，不穿过它收孩子（否则会误删分支）。
 *  组序与成员序按语料原序；「已知父为什么排除」住 `verbs/orphan-subagents.ts`。 */
export function orphanRootsOf<N extends ClosureNode & { readonly parentSessionId?: string; readonly subagent: boolean }>(
  corpus: readonly N[],
  known: Iterable<string>,
): { root: N; parentSessionId: string; members: N[] }[] {
  const knownBares = new Set<string>()
  for (const id of known) knownBares.add(bareSessionId(id))

  const children = new Map<string, N[]>()
  for (const session of corpus) {
    const parent = session.parentSessionId
    if (parent === undefined) continue
    if (!session.subagent) continue
    const key = bareSessionId(parent)
    const list = children.get(key)
    if (list === undefined) children.set(key, [session])
    else list.push(session)
  }

  const claimed = new Set<string>()
  const groups: { root: N; parentSessionId: string; members: N[] }[] = []
  for (const session of corpus) {
    const parent = session.parentSessionId
    if (!session.subagent || parent === undefined) continue
    if (knownBares.has(bareSessionId(parent))) continue
    const rootBare = bareSessionId(session.sessionId)
    if (claimed.has(rootBare)) continue
    claimed.add(rootBare)
    const members: N[] = [session]
    for (const descendant of closureOf(children, rootBare)) {
      const bare = bareSessionId(descendant.sessionId)
      if (claimed.has(bare)) continue
      claimed.add(bare)
      members.push(descendant)
    }
    groups.push({ root: session, parentSessionId: parent, members })
  }
  return groups
}
