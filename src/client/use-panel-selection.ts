/**
 * 清单上的**选中面**（通用；回收站档与归档档各一台实例，互不干扰）：选中行、清单换版清场、
 * 宽档自动选中第一条，以及按行落的动作失败原文。
 *
 * 三条承重规矩：
 * - **清场与自动选中同一帧收口**：两道都走 layout 阶段。passive 阶段会让「未选中」那一帧真的
 *   画上屏（ADR-0050 的首帧前提）。两条规矩住一处，两档就不可能各写成一种阶段。
 * - **清单未知（读数还没回来）不算「行没了」**：这一拍只是不知道，选中留着；读数回来再判。
 *   与「勾选剔除」同一条判据（`use-list-selection.ts`）。
 * - **失败原文只坏这一行**：进入动作时先清旧失败（再点一次不该还挂着上一次的），落地后按 id
 *   铺开；没有任何一行挂着失败时原样返回同一份引用，不触发多余的一拍。
 *
 * 行身份由 `idOf` 取（回收站 = 条目 id，归档 = 会话 id）。这一台只管"选中了哪一行、哪一行报失败"，
 * 详情读路与附属导航态（孩子视图、下钻、账本作废）留在调用方：这里只交出 `onPick` 与 `onGone`
 * 两个钩子，不把两档的差异搬进来变成第二套语义。
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLatest } from './store.js'

export interface PanelSelection<R> {
  readonly selectedId: string | null
  /** 选中那一行本身（从**全量行**里找，不从 `ordered` 找：折叠组只收掉清单那一列）。 */
  readonly selected: R | null
  /** 动作失败原文按行存（键 = 行身份）：切走再回来还在，别行的成败不串台。 */
  readonly actionFailure: Readonly<Record<string, string>>
  /** 把选中落到这一行，并把读路交回 `onPick`（自动选中与显式点行走同一条）。 */
  pick: (row: R) => Promise<void>
  /** 收起选中（窄档返回：详情槽交还给清单）。 */
  drop: () => void
  /** 一次动作进入时清掉这些行的旧失败。 */
  clearRowFailures: (ids: readonly string[]) => void
  /** 把这一趟的逐条失败铺回各行。 */
  setRowFailures: (failures: ReadonlyMap<string, string>) => void
}

export interface PanelSelectionInput<R> {
  /** 当前清单的行；`null` = 这一拍不知道，不算「行没了」。 */
  rows: readonly R[] | null
  /** 行身份（回收站 = 条目 id，归档 = 会话 id）。允许调用方内联传箭头。 */
  idOf: (row: R) => string
  /** 屏幕上的可见顺序（只含展开的组）：自动选中第一条走这一份。 */
  ordered: readonly R[]
  /** 这一档要不要自动选中：面板按布局给，这里不认断点。 */
  canAutoSelect: boolean
  /** 挂载续位的选中 id（首帧快照）；没有就留空。 */
  initialId?: string | null
  /** 选中落定后要跑的读路。 */
  onPick: (row: R) => void | Promise<void>
  /** 那一行被清单收走时调用方自己的清场（丢账本、作废在飞读数、收附属导航态）。 */
  onGone?: (id: string) => void
}

export function usePanelSelection<R>({
  rows,
  idOf,
  ordered,
  canAutoSelect,
  initialId = null,
  onPick,
  onGone,
}: PanelSelectionInput<R>): PanelSelection<R> {
  const [selectedId, setSelectedId] = useState<string | null>(initialId)
  const [actionFailure, setActionFailure] = useState<Readonly<Record<string, string>>>({})
  /** `idOf` 允许逐渲染换新引用：经 `useLatest` 归一（判据住 `store.ts`）。 */
  const idOfLatest = useLatest(idOf)
  const keyOf = useCallback((row: R): string => idOfLatest.current(row), [idOfLatest])
  /** 读路钩子同理恒稳：`pick` 进自动选中那道的依赖，钩子换身份不许让这一道再跑一遍。
   *  走 layout 阶段写回：自动选中本身就在 layout 里读它，passive 更新会慢一帧拿到旧钩子。 */
  const onPickRef = useRef(onPick)
  useLayoutEffect(() => { onPickRef.current = onPick })
  const onGoneRef = useRef(onGone)
  useLayoutEffect(() => { onGoneRef.current = onGone })

  const selected = useMemo(
    () => (rows ?? []).find((row) => keyOf(row) === selectedId) ?? null,
    [rows, selectedId, keyOf],
  )

  const pick = useCallback(async (row: R): Promise<void> => {
    setSelectedId(keyOf(row))
    await onPickRef.current(row)
  }, [keyOf])

  const drop = useCallback((): void => {
    setSelectedId(null)
  }, [])

  // 清单换版清场：选中那条被收走 ⇒ 丢掉它（调用方自己的账本/在飞/附属导航态由 `onGone` 收），
  // 再清选中。**layout 阶段**（ADR-0050）：下面那道自动选中以「有效选中」为门，两道同帧收口。
  useLayoutEffect(() => {
    if (rows === null || selectedId === null) return
    if (rows.some((row) => keyOf(row) === selectedId)) return
    onGoneRef.current?.(selectedId)
    setSelectedId(null)
  }, [rows, selectedId, keyOf])

  // 宽档首读完成后自动选中第一条：右栏空着比多一次点击更怪（窄档不自动下钻）。
  // `canAutoSelect` 由面板算（盒子够宽且清单里有东西）；门是**有效选中**而不是 `selectedId`，
  // 所以清场那一拍落地后这里直接接住新清单第一条。
  useLayoutEffect(() => {
    const first = ordered[0]
    if (canAutoSelect && selected === null && first !== undefined) void pick(first)
  }, [canAutoSelect, selected, ordered, pick])

  const clearRowFailures = useCallback((ids: readonly string[]): void => {
    setActionFailure((current) => {
      let changed = false
      const next = { ...current }
      for (const id of ids) {
        if (Object.hasOwn(next, id)) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- `next` 是本函数刚浅拷出来的本地副本，删的是自己的键；不存在共享对象/原型链问题。
          delete next[id]
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [])

  const setRowFailures = useCallback((failures: ReadonlyMap<string, string>): void => {
    if (failures.size === 0) return
    setActionFailure((current) => {
      const next = { ...current }
      for (const [id, message] of failures) next[id] = message
      return next
    })
  }, [])

  return { selectedId, selected, actionFailure, pick, drop, clearRowFailures, setRowFailures }
}
