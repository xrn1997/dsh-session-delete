/**
 * 会话闭包（session closure）的唯一实现：`session-` 前缀归一 + 传递闭包 + 首见去重。
 *
 * 为什么是零依赖纯部件：这三件事在仓里曾有两份闭包实现（端口的分层 BFS、无主子会话的整表 BFS）
 * 与三处手写去重，同一口径靠注释担保——注释不会替代码挡漂移，所以把口径收进这里，一份实现；
 * 端口与动词只做接线（逐层问宿主、SessionIdentity 映射留在各自那层，见各自的头注）。
 * 不碰盘、不碰端口类型：本文件一个 import 都不许有。
 */

/** 闭包里的一个节点：本部件只认这两个字段；端口的后代记录与语料的 SessionIdentity 都满足它。 */
export interface ClosureNode {
  readonly sessionId: string
  readonly projectDir: string
}

/** 会话 id 去掉 `session-` 前缀后的形状：同一个会话在两代宿主里写法不同（v3 代 id 不带前缀、
 *  现行代带），归堆、成组、去重一律按这个形状比——两边都归一，不赌调用方传的是哪一代写法。 */
export function bareSessionId(id: string): string {
  return id.startsWith('session-') ? id.slice('session-'.length) : id
}

/** 一个 id 的全部可能写法，原写法在前：`session-x` → `[session-x, x]`；`x` → `[x, session-x]`。
 *  逐层问宿主时按这些写法问：宿主那支按 `header.parentSession` 原文比，不替我们归一。 */
export function sessionIdShapes(id: string): string[] {
  const bare = bareSessionId(id)
  return [...new Set([id, bare, `session-${bare}`])]
}

/** parent(bare) 到 children 索引上的传递闭包：深度不设上限、防环、首见去重（都按 bare 归一后比）。
 *  根的两种写法都认（内部归一次）；结果不含根自己。数据里真出现环时代价是「少数一条」，
 *  不是把清单读挂死——环本来不该出现（parentSession 是一条有向边），出现就是手工改过日志或宿主 bug。 */
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

/** 同一条记录两代写法只认第一次出现（保原序）。全局去重只有这一处实现：谁要按 bare 去重，
 *  交一条列表进来，别在调用点再手写一个 seen 集合。 */
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

/**
 * 整表语料 → 根闭包组：`parentSessionId` 不在 `known` 里的那些 subagent 各自成一组。`known` 两侧都
 * 归一后再比（传原始 id 即可）。「已知父为什么排除在外」是调用方的领域判据（住
 * `src/verbs/orphan-subagents.ts` 与 `CONTEXT.md` 的「无主子会话」），这一层不替它复述。
 *
 * 组内的后代仍走 `closureOf` 那一份闭包，只是多一条跨组的 `claimed`：一条记录只归第一个认领它的根。
 * 已被前一组收走的那条，连同它整支子树都不再出现在这一组里——后代在那一组已被全部认领，所以
 * 「丢掉已认领的」与「不走进已认领的那支」交回的是同一个集合。环上的代价是「少数一条」，
 * 不是把一次扫描挂死。组序与成员序都按语料原序。
 */
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
