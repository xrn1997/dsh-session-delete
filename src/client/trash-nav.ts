/**
 * 清单的**键盘导航面**：方向键走环、Enter / Space 的双重语义、roving tabindex 的落点，
 * 以及窄档下钻里按 Esc 退回清单并把焦点交还给那一行。
 *
 * 为什么收回一处：这几条判据此前劈在 `trash-panel.tsx`（键盘分支与 `activeDescendantId` /
 * `tabStopId` 两枚只读）与 `use-trash-panel-controller.ts`（Esc 的两个 effect 与那笔焦点账）之间。
 * 它们说的其实是同一件事——"屏幕上从上到下的那一串行里，谁是光标、谁拿 tab 落点、Esc 之后焦点
 * 还给谁"——而那份顺序只在面板手里（`ordered` 只含展开的组）。收进一个 module 之后面板只交输入
 * 与四个动作，控制器不再知道焦点这回事。
 *
 * 它**不查自己的行、不认行选择器**：焦点动作由调用方注入 `focusRow`，行的 DOM 查询仍留在面板——
 * 行是在那儿渲染出来的，行选择器只在那儿有权威；唯一的文档查询是 Esc 让路判据（问
 * `ui/top-layer.ts` 当前有没有打开的 dialog / menu）。它只读事件的 `target` 来判断这一下该不该
 * 归清单：从行内按钮 / 勾选框起来的 Enter / Space 是人家的激活键，不是清单的下钻或勾选。
 *
 * 三条原样搬来的判据（界面现状住 `docs/ui-spec.md` 的「键盘」那条；这里只留「为什么这么定」）：
 * - **方向键走环**：未选中时 ↓ 落第一条、↑ 落最后一条；到端回卷，不是撞墙。
 * - **`aria-activedescendant` 只指向在 DOM 里的行**：选中那行被折叠起来时它就不存在，指过去是
 *   假引用。tab 落点（清单里唯一的 tab 巢）走同一条可见性规则，但**永远有一行拿着**——否则一次
 *   没点过时全行都是 `-1`，键盘根本进不来清单。焦点所在的行就是激活目标：选中行被折叠时，
 *   Enter / Space 落在拿 tab 落点的那一条上，而不是一声不响。
 * - **Esc 只在下钻期间生效**：监听挂 `document`，因为窄档下钻时清单**不在 DOM 里**；退回后把焦点
 *   交还选中那一行**一次**，交完就清账，后续重渲染不再重复抢焦点。最上层是确认框 / 菜单时
 *   **不接这一下**：Esc 先归它，否则 busy 时框不关、清单却退了，焦点还会被交还到遮罩后。
 */
import { useCallback, useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { TrashEntryLike } from './remote.js'
import { hasTopLayer } from './ui/top-layer.js'

/**
 * 导航要的面。`ordered` 是**屏幕上的顺序**（只含展开的组），由面板/选择面算好传进来——
 * 布局常量与本 module 无关。`drillEnabled` 是这一档支不支持整行下钻（窄档为真；宽档 Enter/Space
 * 只移动选中，与整行点击的 `{ drill: !split }` 同一条判据）。四个动作都由调用方注入：
 * `select` 只移动选中（带 `drill` 才下钻），`exitDrill` 是控制器那条「← 返回清单」的同一动作，
 * `focusRow` 把焦点交给某一行。
 */
export interface TrashNavInput {
  ordered: readonly TrashEntryLike[]
  selectedId: string | null
  selectMode: boolean
  drillEnabled: boolean
  drilled: boolean
  select(entry: TrashEntryLike, options?: { drill?: boolean }): Promise<void>
  toggleCheck(entryId: string): void
  exitDrill(): void
  focusRow(entryId: string): void
}

export interface TrashNav {
  /** `aria-activedescendant` 的那条 id：选中行不在 DOM 里时是 `null`。 */
  readonly activeDescendantId: string | null
  /** 清单里唯一拿着 `tabIndex=0` 的那一行；清单空时是 `null`。 */
  readonly tabStopId: string | null
  onListKeyDown(event: ReactKeyboardEvent<HTMLElement>): void
}

/** 事件是不是清单自己的：从行（`role="option"`）或容器起来才算；行内按钮 / 勾选框的 Enter / Space
 *  归它们自己。测试里的窄事件没有 `target`，按清单自己的处理。 */
function isListOwnedEvent(event: ReactKeyboardEvent<HTMLElement>): boolean {
  const target = event.target as HTMLElement | null | undefined
  if (target == null || target === event.currentTarget) return true
  return typeof target.getAttribute === 'function' && target.getAttribute('role') === 'option'
}

export function useTrashNav(input: TrashNavInput): TrashNav {
  const { ordered, selectedId, selectMode, drillEnabled, drilled, select, toggleCheck, exitDrill, focusRow } = input
  /** Esc 退出下钻后要交还焦点的那一行；等 `drilled` 落地、清单回到 DOM 之后再用一次。 */
  const refocusRow = useRef<string | null>(null)

  /** 折叠起来的组只是收掉那一列，选中的 id 还留着——所以这条可见性得逐条对账，不能只看非空。 */
  const activeDescendantId = ordered.some((entry) => entry.id === selectedId) ? selectedId : null
  const tabStopId = activeDescendantId ?? ordered[0]?.id ?? null

  const onListKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>): void => {
    if (ordered.length === 0 || !isListOwnedEvent(event)) return
    const index = ordered.findIndex((entry) => entry.id === selectedId)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = index < 0 ? (step > 0 ? 0 : ordered.length - 1) : (index + step + ordered.length) % ordered.length
      const target = ordered[next]!
      void select(target)
      focusRow(target.id)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      // 选中行被折叠时 `index` 是 -1；拿 tab 落点的那一条就是焦点所在，Enter / Space 该落在它上面。
      const target = ordered[index >= 0 ? index : 0]
      if (target === undefined) return
      event.preventDefault()
      // 多选态下 Enter/Space 说的是"勾上/取消这一条"，光标仍由 ↑↓ 移动（listbox 的常规分工）。
      if (selectMode) {
        toggleCheck(target.id)
        return
      }
      if (drillEnabled) void select(target, { drill: true })
      else void select(target)
    }
  }, [drillEnabled, focusRow, ordered, select, selectMode, selectedId, toggleCheck])

  // 监听挂 `document`：窄档下钻时清单不在 DOM 里，挂在容器上的 Esc 是一条永远收不到的死路径。
  // `drillEnabled` 也进条件：宽档里即使残留着 `drilled`（例如从窄档拖宽），Esc 也不归清单。
  // 最上层有 dialog / menu 时让路：那一层自己收 Esc；这里先退下钻会和它抢同一下按键。
  useEffect(() => {
    if (!drilled || !drillEnabled) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (hasTopLayer(document)) return
      refocusRow.current = selectedId
      exitDrill()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [drillEnabled, drilled, exitDrill, selectedId])

  // 只在下钻**刚刚退出**、且手里真的有 id 时交还一次焦点；交完就清账，后续重渲染不会重复抢焦点。
  useEffect(() => {
    if (drilled || refocusRow.current === null) return
    focusRow(refocusRow.current)
    refocusRow.current = null
  }, [drilled, focusRow])

  return { activeDescendantId, tabStopId, onListKeyDown }
}
