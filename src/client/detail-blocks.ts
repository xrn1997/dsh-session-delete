/**
 * 详情正文的**块视图词汇**：哪些块算过程内容、标准档怎么把连续过程块收成一组。
 * 折叠状态与分页不在这里——这里只回答「这一页的块怎么读」。
 */
import type {
  TrashDetailBlockWire,
  TrashDetailInjectionBlockWire,
  TrashDetailTextBlockWire,
  TrashDetailToolBlockWire,
} from '../shared/wire.js'

/** 除用户与助手之外的块：思考、工具、注入、系统消息、压缩摘要——详情按过程内容对待。
 *  文本块是一个 `kind` 联合的接口，`Exclude` 摘不掉其中两个成员；这里按 `kind` 收窄后并上另两种块。 */
export type DisclosureBlockWire =
  | (TrashDetailTextBlockWire & { kind: 'reasoning' | 'system' | 'compaction' })
  | TrashDetailInjectionBlockWire
  | TrashDetailToolBlockWire

export function isDisclosureBlock(block: TrashDetailBlockWire): block is DisclosureBlockWire {
  return block.kind !== 'user' && block.kind !== 'assistant'
}

/** 这一批块里有没有对话内容（用户或助手）；简洁档靠它决定还要不要继续往前翻。 */
export function hasDialogue(blocks: readonly TrashDetailBlockWire[]): boolean {
  return blocks.some((block) => !isDisclosureBlock(block))
}

/** 标准档的线程单元：对话块照原位；**连续的**过程块收成一组。
 *  组的 `id` 取它**后面那条对话块**的 id（没有对话块就 `after:end`）——prepend 更早一页只会
 *  往组头添过程块，组的结束边界不变，已展开的组不会因为合并而收回。 */
export type ThreadItem =
  | { readonly kind: 'block'; readonly block: TrashDetailBlockWire }
  | { readonly kind: 'process'; readonly id: string; readonly blocks: readonly DisclosureBlockWire[] }

export function threadItems(blocks: readonly TrashDetailBlockWire[]): ThreadItem[] {
  const items: ThreadItem[] = []
  let current: { kind: 'process'; id: string; blocks: DisclosureBlockWire[] } | null = null
  for (const block of blocks) {
    if (isDisclosureBlock(block)) {
      if (current === null) {
        current = { kind: 'process', id: 'after:end', blocks: [] }
        items.push(current)
      }
      current.blocks.push(block)
      continue
    }
    if (current !== null) current.id = `after:${block.id}`
    current = null
    items.push({ kind: 'block', block })
  }
  return items
}
