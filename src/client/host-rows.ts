/**
 * 宿主会话行的适配：**可见行由槽位组件登记**；选择动作与模式内整行点击守卫住 `batch-pick.ts`。
 *
 * 选中集（模式 + 名单）只住 `batch-selection-store.ts`；本文件只回答页面上的「当前有哪些可勾选的
 * 会话行」：行槽位开关的挂载登记、渲染快照与按 id 的行查找。「这一行可不可勾」的 live 判据
 * 也只住这里（`pickableRowOf` / `readVisibleSelectableRows`）。DOM 只用于守卫认行，且那处 DOM
 * 读取随守卫住在 `batch-pick.ts`（ADR-0034 记下的受约束偏离）。
 *
 * 为什么不再扫 DOM：宿主的行槽位只在行可见时挂载，行首/行尾两颗开关（`BatchPickCheckbox` /
 * `BatchPickButton`）都会登记 `{title, live}`；挂载/卸载就是「这一行在不在可见集合」的契约，
 * 不需要 MutationObserver。
 *
 * 形状：**可实例化的现场**（`createHostRowsScene`）——登记表与懒读快照都在实例里，由
 * `scene.ts` 的 `ClientScene` 聚合；自由函数委托默认场景（兼容旧调用点与测试），两个 hook 走
 * `useClientScene()`（生产 Provider 实例；测试无 Provider 回退默认）。
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { PickItem } from './batch-selection-store.js'
import { getDefaultClientScene, useClientScene } from './scene.js'
import { createLazyStore } from './store.js'

export interface HostRowInfo {
  /** 槽位宿主投影的标题（`PickLeadingRow` / `PickRow` 从 root hook 读）；守卫只读登记，不读 DOM 文本。 */
  readonly title: string
  /** 在跑的行点整行也不选：与置灰的勾选框同口径（级联遇在跑成员整组拒绝）。 */
  readonly live: boolean
}

/** 一条登记：它是什么 + 此刻有几颗行槽位开关在用它；标题/运行态变化就地更新，不重排。 */
interface HostRowRegistration {
  info: HostRowInfo
  owners: number
}

const EMPTY_ROWS: readonly PickItem[] = []
const EMPTY_ROW_INFO: HostRowInfo = { title: '', live: false }

/** 一台可见行登记现场：登记 / 查找 / 渲染快照 / 两个 hook / 收场。 */
export interface HostRowsScene {
  /** 行槽位开关登记一行：模式内与模式外都要登记（守卫进模式的那一帧就得有标题）。 */
  register(sessionId: string, info?: HostRowInfo): void
  /** 标题/运行态变了就地更新：**不注销、不重登记**，否则这一行会被挪到登记序末尾（ADR-0034 决定 2）。 */
  update(sessionId: string, info: HostRowInfo): void
  /** 行槽位开关卸载时调用：那一行已经离开渲染树，登记跟着走（多实例按 owners 计数）。 */
  unregister(sessionId: string): void
  /** 守卫与全选共用的一行读数：可勾选时交回登记；未登记或在跑回 `undefined`。 */
  pickable(sessionId: string): HostRowInfo | undefined
  /** 只看「登记过没有」，不看跑不跑（模式内整行点击守卫用它判吞不吞这一下）。 */
  registered(sessionId: string): HostRowInfo | undefined
  /** 当场读「当前可见」的可选行（事件路径与测试用）。 */
  readVisible(): PickItem[]
  /** 渲染侧快照（脏了才重读登记；干净时回同一引用）。 */
  snapshot(): readonly PickItem[]
  /** 渲染侧只读快照 + 订阅；`enabled === false` 不订阅也不读登记。 */
  useVisible(enabled: boolean): readonly PickItem[]
  /** 槽位组件共用的登记生命周期：挂载登记、卸载注销；标题/运行态变化只走更新口。 */
  useRegistration(sessionId: string, info: HostRowInfo): void
  /** 场景收场：登记表清空并标脏。 */
  reset(): void
}

export function createHostRowsScene(): HostRowsScene {
  /** 可见行的事实源（ADR-0034）：按挂载实例计数，同一会话的重复行各挂一组开关。 */
  const rowInfo = new Map<string, HostRowRegistration>()
  const visibleRows = createLazyStore<readonly PickItem[]>(EMPTY_ROWS, () => readVisibleRows())

  /** `live` 行不可勾：与置灰的勾选框、守卫拦下的整行点击同一条判据。 */
  function isPickable(info: HostRowInfo): boolean {
    return !info.live
  }

  function registerRow(sessionId: string, info?: HostRowInfo): void {
    const current = rowInfo.get(sessionId)
    if (current === undefined) {
      rowInfo.set(sessionId, { info: info ?? EMPTY_ROW_INFO, owners: 1 })
      visibleRows.invalidate()
      return
    }
    current.owners += 1
    if (info !== undefined && (current.info.title !== info.title || current.info.live !== info.live)) {
      current.info = info
      visibleRows.invalidate()
    }
  }

  function updateRow(sessionId: string, info: HostRowInfo): void {
    const current = rowInfo.get(sessionId)
    if (current === undefined) return
    // 同一行有两颗槽位开关（行首 / 行尾）：空标题可能只是其中一颗还没读到 root hook 的值，
    // 不能让它抹掉另一颗已登记的名字；非空值之间以最后落地的为准。
    const title = info.title === '' ? current.info.title : info.title
    if (current.info.title === title && current.info.live === info.live) return
    current.info = { title, live: info.live }
    visibleRows.invalidate()
  }

  function unregisterRow(sessionId: string): void {
    const current = rowInfo.get(sessionId)
    if (current === undefined) return
    if (current.owners > 1) {
      current.owners -= 1
      return
    }
    rowInfo.delete(sessionId)
    visibleRows.invalidate()
  }

  function readVisibleRows(): PickItem[] {
    const rows: PickItem[] = []
    for (const [sessionId, entry] of rowInfo) {
      if (!isPickable(entry.info)) continue
      rows.push({ sessionId, title: entry.info.title })
    }
    return rows
  }

  /** `enabled === false` 时的稳定替身：同一个空表、不订阅、不读登记。 */
  function getEmptyRowsSnapshot(): readonly PickItem[] {
    return EMPTY_ROWS
  }

  function noopSubscribe(): () => void {
    return () => {}
  }

  const scene: HostRowsScene = {
    register: registerRow,
    update: updateRow,
    unregister: unregisterRow,
    pickable(sessionId: string): HostRowInfo | undefined {
      const entry = rowInfo.get(sessionId)
      return entry === undefined || !isPickable(entry.info) ? undefined : entry.info
    },
    registered(sessionId: string): HostRowInfo | undefined {
      return rowInfo.get(sessionId)?.info
    },
    readVisible: readVisibleRows,
    snapshot: (): readonly PickItem[] => visibleRows.get(),
    useVisible(enabled: boolean): readonly PickItem[] {
      return useSyncExternalStore(
        enabled ? visibleRows.subscribe : noopSubscribe,
        enabled ? visibleRows.get : getEmptyRowsSnapshot,
        enabled ? visibleRows.get : getEmptyRowsSnapshot,
      )
    },
    useRegistration(sessionId: string, info: HostRowInfo): void {
      useEffect(() => {
        registerRow(sessionId)
        return () => { unregisterRow(sessionId) }
      }, [sessionId])
      const { title, live } = info
      useEffect(() => {
        updateRow(sessionId, { title, live })
      }, [sessionId, title, live])
    },
    reset(): void {
      rowInfo.clear()
      visibleRows.invalidate()
    },
  }
  return scene
}

/* ── 兼容自由函数（旧调用点与测试）：委托默认场景的实例 ────────────────────────── */

export function registerHostRowInfo(sessionId: string, info?: HostRowInfo): void {
  getDefaultClientScene().hostRows.register(sessionId, info)
}

export function updateHostRowInfo(sessionId: string, info: HostRowInfo): void {
  getDefaultClientScene().hostRows.update(sessionId, info)
}

export function unregisterHostRowInfo(sessionId: string): void {
  getDefaultClientScene().hostRows.unregister(sessionId)
}

/** 守卫与全选共用的一行读数（默认场景）。 */
export function pickableRowOf(sessionId: string): HostRowInfo | undefined {
  return getDefaultClientScene().hostRows.pickable(sessionId)
}

/** 模式内整行点击守卫用它判「吞不吞这一下」（默认场景）。 */
export function registeredHostRowOf(sessionId: string): HostRowInfo | undefined {
  return getDefaultClientScene().hostRows.registered(sessionId)
}

/** 当场读「当前可见」的可选行（默认场景）。 */
export function readVisibleSelectableRows(): PickItem[] {
  return getDefaultClientScene().hostRows.readVisible()
}

/** 渲染侧快照（默认场景）。 */
export function getVisibleSelectableRowsSnapshot(): readonly PickItem[] {
  return getDefaultClientScene().hostRows.snapshot()
}

/** 渲染侧只读快照 + 登记订阅（生产走 Provider 的那一份；测试无 Provider 回退默认场景）。 */
export function useVisibleSelectableRows(enabled: boolean): readonly PickItem[] {
  return useClientScene().hostRows.useVisible(enabled)
}

/** 槽位组件共用的登记生命周期（生产写进 Provider 的那一份；测试无 Provider 回退默认场景）。 */
export function useHostRowRegistration(sessionId: string, info: HostRowInfo): void {
  useClientScene().hostRows.useRegistration(sessionId, info)
}
