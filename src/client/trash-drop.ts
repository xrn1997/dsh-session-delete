/**
 * 拖放判定（2026-11-25，issue #9）：宿主会话行的原生拖拽把 session id 写进 `text/plain`
 * （宿主 `Rows.tsx` 的 `onDragStart`），落到侧栏「回收站」入口时由本模块把 payload 判成计划，
 * 入口组件只负责画投放高亮与执行。判据只读默认场景的自由函数（host-rows 登记表 + 批量选中集），
 * 不引 React、不碰 DOM。
 *
 * 判定序（语义裁决，ADR-0071）：
 * 1. payload 空 / 未登记 ⇒ `ignore`——随手拖一段文字绝不许变成删除；
 * 2. 登记但运行中 ⇒ `refuse-live`（勾选框与守卫同口径：在跑的行不可删）；
 * 3. 多选态且拖的行在勾选集里 ⇒ `batch`（一拖删整集，items = 当前勾选集）；
 * 4. 其余 ⇒ `single`。
 */
import { getPicks, getSelection, type PickItem } from './batch-selection-store.js'
import { pickableRowOf, registeredHostRowOf } from './host-rows.js'

export type DropPlan =
  /** 未登记 id / 空 payload：什么都不做。 */
  | { kind: 'ignore' }
  /** 登记但运行中：不删，上屏说原因（原因文案是通用短句，不带条目标题）。 */
  | { kind: 'refuse-live' }
  /** 单删一条。 */
  | { kind: 'single'; item: PickItem }
  /** 拖的行在勾选集里：整集一起删。 */
  | { kind: 'batch'; items: readonly PickItem[] }

export function resolveDropPlan(payload: string | null): DropPlan {
  const sessionId = payload === null ? '' : payload
  if (sessionId === '') return { kind: 'ignore' }
  const registered = registeredHostRowOf(sessionId)
  if (registered === undefined) return { kind: 'ignore' }
  const pickable = pickableRowOf(sessionId)
  if (pickable === undefined) return { kind: 'refuse-live' }
  const item = { sessionId, title: pickable.title }
  const selection = getSelection()
  if (selection.selecting && selection.picks.some((candidate) => candidate.sessionId === sessionId)) {
    return { kind: 'batch', items: getPicks() }
  }
  return { kind: 'single', item }
}
