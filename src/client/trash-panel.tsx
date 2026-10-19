/**
 * 回收站清单面板（设计稿 §7 状态 ④⑤ + 2026-10-15 §2 的两栏形态）——**中央面板的本体**（`main` 槽的占用者）。
 *
 * 面板自带页面骨架（标题 / 条数与合计 / 工具排 / 内容区 / 页脚），因为宿主给中央列的那个盒子
 * （`AppFrame` 的 `.centerCol`）只有背景与圆角，**没有 padding、也不是滚动容器**——asar 里那条
 * `.BynINW_centerCol{background:var(--dsw-alias-bg-base);border-radius:…;corner-shape:round}` 逐字
 * 如此。回收站可以很长（本机 125 个会话合计 85M），不自己收滚动就会把整列顶长。
 *
 * **2026-10-15 形态改版：居中一列 → 清单在左、单条详情在右。**三条决定摆在这里（判据全在
 * `docs/design/2026-10-15-trash-detail-design.md` §6，本节只记结论；**现行界面规格住 `docs/design/
 * 2026-09-30-session-delete-design.md` §7**——那份是批次日志，§7 之后各批会改写它）：
 * ① 动机：一条只有一个标题，判断不了该恢复还是该彻底删除 ⇒ 详情要摆出这条会话自己日志里的元信息
 *   与正文，而详情只能我们自己画（宿主读不到回收站目录里的文件）；
 * ② 断点 900px（盒子宽，不是窗口宽）：中央列宽由 `usePanelWidth`（ResizeObserver）观测，**只听
 *   window.resize 会漏**——宿主侧栏折叠/展开也改中央列宽，而且量的是面板自己那块的 **border-box 宽**。
 *   窄于此走下钻（详情铺满 + 返回），因为 2026-10-01 真机在 520px 窗量过中央列只有 405px，两栏在那
 *   儿两栏都读不了；900 这个数是按两栏各自要读得开算出来的（见 `SPLIT_MIN_WIDTH` 处）；
 * ③ **动作留在清单行右侧**（2026-10-15 试过"退出行、住进详情"，按真机反馈回到 2026-10-01 的形状）：
 *   那一版左栏为了只放标题被压到 316px，用户第一眼就是"左侧太窄"。详情只负责看，失败原文也跟着
 *   动作留在它自己那一行。
 *
 * **卡片配色沿用 2026-10-01 那批**（宿主设置面卡片的底层 token，不是随包发布的 settings 别名）：
 * `background:var(--dsw-alias-bg-layer-2)` + `border:.5px solid var(--dsw-alias-border-l4)` +
 * `border-radius:var(--dsw-radius-lg)`（20px 的 `xl` 会把 60px 上下的行吹成胶囊）。
 * 选中态换一枚 token（2026-10-15 从 asar 的 `dsh-client-ui-theme/lib/client.js` 逐字读出）：
 * `--dsw-alias-button-ghost-active-fill`（浅 `#ebeef2` / 深 `#43454a`）配
 * `--dsw-alias-button-ghost-active-border`（`#979da6` / `#81858c`）——宿主自己侧栏选中项用的
 * `--dsw-specific-sidebar-nav-item-active` 与前者取值逐字相同，所以这是宿主"选中"那一档，不是我挑的。
 *
 * 时间分桶走 `relativeTime`（逐字抄自官方，见 `ui/format.ts`），项目名从宿主 `projectKey` 反推
 * （`unescapeProjectKey`，两半共用），组头 `title` 给完整原串。**行分隔**交给卡片自己的边框。
 *
 * 三条界面规则没有因为改版让路：
 * - **空态**：`回收站是空的`，且底部**不出现**「清空回收站…」（没有东西可清）。
 * - **失败写在出事的那一块上**：清单读不到 ⇒ 单独一块摆原文 + 重试（不是空态，"读不到"与"空的"是
 *   两件事）；某条会话的正文读不到 ⇒ 只在详情那块说，清单照常可选；恢复/彻底删除失败 ⇒ 原因留在
 *   **清单那一行**（按条目 id 存，切走再回来还在）；无主子会话的检查/清理读不到 ⇒ 面板顶端那块摆原文 + 重试
 *   （那是"没能回答有多少残留"，与"没有残留"是两件事，不许折成空报告）；清理发现"这一组已经不在了" ⇒
 *   单独一条中性提示，不计入失败。这些失败块都标 `role="status"`——但**插入即播报并不保证**
 *   （`aria-live` 看的是"已在场的区域发生了变更"），要稳得常驻一个只给读屏看的播报台，本机没有 AT
 *   可验，所以留在这里当已知边界，不写成已经做到。
 * - **危险层级**：整页只有一块实心红（页脚「清空回收站…」，确认框里那块是它的后续）；行与详情里的
 *   「彻底删除…」是**安静的红**——只写 `color:--dsw-alias-state-error-primary`、**不写 background**
 *   （作者态内联 `background` 永远赢过类规则，而 `ui.css` 里 `.sd-button-ghost:hover` / `:active` 都是
 *   普通类 ⇒ 铺了底的动作在点错之前不给任何视觉回应）。批量与确认框那款实心红的写法（`variant="primary"`
 *   + 就地覆盖 `--dsw-alias-button-primary-fill` / `-hover`）照抄宿主插件管理页 @21658274。
 *
 * 布局只用**结构**内联样式，**配色与圆角一律走 token**，**字号是字面量 px**（宿主同类面也这么写）。
 * 结构与层级归设计稿 §7 与 2026-10-15 §2，皮肤只由 token 决定。控件样式住在 `src/client/ui/ui.css`，
 * 由 `ui/styles.ts` 在浏览器半模块物化时挂成一个 `<style>`——这是宿主给客户端插件的一等公民通道。
 *
 * **浅色主题已在真机看过（2026-10-01）**：浅色下 `bg-base` 与 `bg-layer-2` 同值（都是 `bluish-00`）
 * ⇒ 卡片只剩一根 `border-l4` 描边与页面分隔，分组靠组头 + 间距站住。**选中态在两档下都要另量**
 * （浅 `#fff` → `#ebeef2`、深 `#2c2c2e` → `#43454a`），量法见 2026-10-15 §4 第 5 条。
 */
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { TRASH_DIR_LABEL } from '../shared/wire.js'
import { absoluteText, splitOn, unitWord, zhTranslate, type Translate } from './copy.js'
import { applyOne, callRemote, type ApplyOutcome, type SessionDeleteRemote, type TrashDetailLike, type TrashEntryLike } from './remote.js'
import { useTrashRevision } from './trash-store.js'
import { TrashDetail, type TrashDetailState } from './trash-detail.js'
import { useColumnResize } from './use-column-resize.js'
import { usePanelWidth } from './use-panel-width.js'
import { Button } from './ui/Button.js'
import { Checkbox } from './ui/Checkbox.js'
import { fileSizeText, relativeTime } from './ui/format.js'
import {
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconTrashOutlineRegular,
  IconWarningOutlineRegular,
} from './ui/icons.js'
import { ELLIPSIS, QUIET_DANGER } from './ui/recipe.js'
import { Tooltip } from './ui/Tooltip.js'
import { OrphanConfirm, TrashConfirm, type PendingAction } from './trash-confirm.js'
import { useTrashQuery } from './use-trash-query.js'
import { useTrashSelection } from './use-trash-selection.js'
import { BULK_DANGER, CARD, CARD_SELECTED, groupByProject } from './trash-view.js'

/** 面板的依赖面：三个读（`list` / `detail` / `scanOrphans`）+ **一段 `apply`** + 清空。
 *  **没有第二条路**（架构复核候选 6）：「恢复一条」也走 `apply`（N=1），面板不再同时吃
 *  `applyOutcomes` 与一个便捷的 `restore`。 `scanOrphans` 是回收站之外那批无主子会话的纯读报告。 */
export type TrashPanelDeps = Pick<
  SessionDeleteRemote,
  'list' | 'detail' | 'applyOutcomes' | 'emptyTrash' | 'scanOrphans'
>

export interface TrashPanelProps {
  deps: TrashPanelDeps
  /** 文案（缺省 = 内置 zh，见 `copy.ts`：这不是"忘了传"，而是"这次没有 locale 服务"）。 */
  t?: Translate
}

/** 回收站相对宿主**数据根**的位置。**不写 `~/.dsh/`**：数据根可以是 `$DSH_HOME` 指的别处。
 *  字面量住 `shared/wire.ts`（`TRASH_DIR_LABEL`）——Node 半拼的就是同一个名字（ADR-0003）。 */
const TRASH_DIR = TRASH_DIR_LABEL

/**
 * 断点：面板盒子宽 ≥ 此值走两栏，窄于此走下钻（设计稿 2026-10-15 §2.1，2026-10-15 真机后定值）。
 *
 * 为什么是 900 而不是当初那个 760：760 是从"正文列限宽"那条关心得搬来的，**不是两栏所需宽度**。
 * 两栏要成立，详情那一栏得真的读得下去：那一格固定要吃掉 90（两道 gap 32 + 把手 10 + 页内边距 48），
 * 详情至少要 399 ⇒ 地板 489，剩下的给清单。窄于此与其挤成两条读不了的柱子，不如下钻。
 * 900 这一档清单被夹到 411（比默认窄 9px），是 2026-10-15 按真 Chromium 量过之后定的：当时按"分隔 1px"
 * 算成 420 + 32 + 1 + 399 + 48，实际那格是 10px，于是清单让 9px 给详情，两边的可读下限都守住。
 */
const SPLIT_MIN_WIDTH = 900
/**
 * 左栏的**默认**宽（2026-10-15 起可拖，见下面 `LIST_COLUMN_MIN` / `DETAIL_RESERVE`）。
 * 这个数是**为"行内有动作"设计的**（2026-10-15 真机反馈后定）：两颗按钮（「恢复」描边 +
 * 「彻底删除…」安静的红）连 gap 约 152px，卡片左右内边距 28px，剩下 ~240px 给标题与
 * 「删除于 … · 大小」那一行——316 是"只放标题"那一版的宽度，动作搬回来之后它就不成立了。
 */
const LIST_COLUMN_DEFAULT = 420
/**
 * 左栏下限。**量出来的，不是算出来的**（2026-10-15，真 Chromium 上按 10px 一档扫 240→420）：
 * 两颗按钮从来不会被挤掉——它们 `flex:none`，再窄也是**文字列**缩，所以"放得下按钮"根本不是约束
 * （我第一版按这个算出 280，是错的）。真正的下沿是「删除于 … · 224KB」那一行什么时候不再被省略号
 * 截断：280 差 50px、320 差 10px、**330 归零**。定在 330。
 */
const LIST_COLUMN_MIN = 330
/**
 * 拖到最右时给详情那一侧留的地板：正文可读最小宽 399 + 那一格的 90（两道 gap 32、把手 10、页内边距 48）。
 * 于是 `900 − 489 = 411`——断点下沿那一档**清单抢不动宽度**（而且它比默认 420 还窄 9px），这是对的：
 * 那一档两栏刚好塞满，再让清单抢宽就是把详情挤回"读不开"的样子（上一轮"右侧没有渲染"就是这么来的）。
 */
const DETAIL_RESERVE = 489
/** 分隔线键盘一格的像素数（←→）。 */
const HANDLE_STEP = 20
/** 详情正文的收口宽度：中央列再宽也不把文字拉成长线（原来那条"整列限宽 760"的关心得换成只限正文）。 */
const DETAIL_TEXT_MAX_WIDTH = 860

/**
 * 页面骨架：撑满中央列（`height:100%` 落在 `.centerCol` 这个有定高的网格项上），自收滚动。
 *
 * `boxSizing:'border-box'` **不是装饰**：宿主文档没有全局 border-box reset（220 处 `box-sizing`
 * 声明全是组件自己带的），默认是 content-box ⇒ `height:100%` 再加 20px 上边距会溢出 20px，
 * 把页脚整块推到中央列底边之外（真机浅色截图上页脚贴着窗口下缘就是这个）。
 */
const PAGE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  height: '100%',
  minWidth: 0,
  padding: '20px 24px 12px',
}

/** 两栏/下钻那一行（页脚之上，自收滚动）。 */
const BODY: CSSProperties = {
  display: 'flex',
  flex: '1 1 auto',
  gap: 16,
  minHeight: 0,
  minWidth: 0,
}

/**
 * 清单那一栏的**外壳**（宽与 `flex` 不在这里——由调用点在渲染时现给：两栏时是可拖的定宽，
 * 单列时 `flex:'1 1 auto'` 铺满）。两栏不成立时（窄档，或宽档但清单为空/读不到）同一个配方
 * 直接铺满：**不再限宽 760 居中**，那条关心得只适用于正文（见 `DETAIL_TEXT_MAX_WIDTH`）。
 *
 * **滚动条不用注入任何 CSS 就已经是宿主的**：宿主在 `body` 上给出一组量（`--dsh-scrollbar-width:5px`
 * 等），再用全局 `::-webkit-scrollbar*` 规则消费它们（asar @45064180 起）⇒ 这里一个 `overflow:auto`
 * 拿到的就是 5px 圆角 token 条。下面把 thumb 提到 `-l2` 那一档，与宿主自己的长滚动面同档。
 */
const LIST_COLUMN = {
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  gap: 7,
  minWidth: 0,
  minHeight: 0,
  overflow: 'auto',
  paddingRight: 10,
  paddingBottom: 8,
  // 自定义属性不在 csstype 的属性表里，走断言（与 `BULK_DANGER` 同一处写法）
  '--dsh-scrollbar-thumb': 'var(--dsw-alias-scrollbar-bg-l2)',
  '--dsh-scrollbar-thumb-hover': 'var(--dsw-alias-scrollbar-hover-l2)',
} as CSSProperties

/** 详情那一栏的外壳（滚动归它自己，正文限宽在内部）。 */
const DETAIL_COLUMN = {
  display: 'flex',
  flex: '1 1 auto',
  minWidth: 0,
  minHeight: 0,
  overflow: 'auto',
  paddingRight: 10,
  paddingBottom: 8,
  '--dsh-scrollbar-thumb': 'var(--dsw-alias-scrollbar-bg-l2)',
  '--dsh-scrollbar-thumb-hover': 'var(--dsw-alias-scrollbar-hover-l2)',
} as CSSProperties

const DETAIL_INNER: CSSProperties = { minWidth: 0, maxWidth: DETAIL_TEXT_MAX_WIDTH, width: '100%' }

/**
 * 那一排视图开关（全部折叠 / 全部展开、多选；「刷新」图标 2026-10-16 已删，见 `toolbar` 那处注释）。
 * 它**住在面板体顶端、不在清单列里**：原先在滚动容器内，长清单滚到底会把开关滚走（2026-10-15
 * 真机反馈后搬出来的理由，与已经删掉的「整条左栏收起」无关）。宽度上限由用它的地方现给——两栏时
 * 跟着可拖的清单列宽，单列时不设上限。
 */
const TOOLBAR: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flex: 'none',
  minWidth: 0,
  width: '100%',
  paddingBottom: 8,
}

/**
 * 行那句「删除于 3小时前」：整句模板住在字典里（两种语言各自钉语序），单位词与绝对串走 `copy.ts`
 * 那一处——详情那格要的是同一份，别抄成两本账。`now` 桶不套模板："删除于 刚刚前"不是话。
 */
function deletedAgo(at: number, now: number, t: Translate): string {
  const { unit, n } = relativeTime(at, now)
  return unit === 'now'
    ? t('trash.row.deletedNow')
    : t('trash.row.deletedAgo', { n, unit: unitWord(unit, t) })
}

/* 「这一次彻底删除会释放多少」**不在这里算**（架构复核候选 8）：它是存储侧的事实（本行 + 跟着进来的孩子
 * + 盘上还留着的后代，彻底删除删的正是这三样），由 Node 半算一次、`releaseBytes` 过线。浏览器半照单念——
 * 头部合计与单条确认卡片都读它，于是同一屏不可能有两套口径，也就不再有"两行都算到同一个后代"那种偏差。 */

export function TrashPanel({ deps, t = zhTranslate }: TrashPanelProps) {
  /** 一枚全局闸：写动作在飞时按住这一排按钮（清单行那颗按 `busy` 置灰），并挡住"旧清单那一拍再点一次"。 */
  const [busy, setBusy] = useState(false)
  const around = useCallback(async <T,>(task: () => Promise<T>): Promise<T> => {
    setBusy(true)
    try {
      return await task()
    } finally {
      setBusy(false)
    }
  }, [])

  // 取数与扫描编排、以及孤儿清理那一条写动作，整块住在 `use-trash-query.ts`（候选 3 的第二道 seam）。
  const query = useTrashQuery({ deps, t, around })
  const {
    entries, listFailure,
    orphanReport, orphanFailure, orphanNotice, orphanConfirm, setOrphanConfirm,
    refresh,
  } = query

  /** 恢复/彻底删除 的失败原文，按条目 id 存：切走再回来还在，不是一次性的。 */
  const [actionFailure, setActionFailure] = useState<Readonly<Record<string, string>>>({})
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [detailFailure, setDetailFailure] = useState<{ entryId: string; message: string } | null>(null)
  const [drilled, setDrilled] = useState(false)
  /** 面板存活期内每条只读一次（本机量级：最大一条 135ms，125 条全读 2.0s ⇒ 不预读、也不重复读）。 */
  const detailCache = useRef(new Map<string, TrashDetailLike>())
  const listRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const width = usePanelWidth(rootRef)
  const wide = width >= SPLIT_MIN_WIDTH
  /**
   * 真走两栏的条件：盒子够宽 **且清单里有东西可看**。空态与读数失败时右栏不出现——那一栏既没有
   * 可选项也没有动作，白占一半宽度（设计稿 2026-10-15 §2.3 第 1 条）。失败那块自己的「重试」
   * 负责把清单读回来，读回来之后右栏跟着回来。
   */
  const split = wide && entries !== null && entries.length > 0
  /** 两栏之间那根可拖的把手（窄档不渲染它，但 hook 照样得在——不能在条件里调）。 */
  const resize = useColumnResize({
    panelWidth: width,
    defaultValue: LIST_COLUMN_DEFAULT,
    min: LIST_COLUMN_MIN,
    reserve: DETAIL_RESERVE,
    step: HANDLE_STEP,
    label: t('trash.divider.label'),
  })
  // 别处动过回收站（侧栏菜单里删了一条、或撤销了另一条）时，这一拍就把清单重读一遍。
  const revision = useTrashRevision()

  useEffect(() => {
    void refresh()
  }, [refresh, revision])

  /**
   * 选一条：命中缓存就直接摆，没命中才去读那条会话自己的日志。
   * `drill` 是窄档的第二步语义（点行 = 选中并下钻；方向键 = 只移动选中）。
   */
  const select = useCallback(
    async (entry: TrashEntryLike, options: { drill?: boolean } = {}): Promise<void> => {
      setSelectedId(entry.id)
      if (options.drill === true) setDrilled(true)
      if (detailCache.current.has(entry.id)) {
        setLoadingId(null)
        setDetailFailure(null)
        return
      }
      setLoadingId(entry.id)
      setDetailFailure(null)
      const outcome = await callRemote(() => deps.detail(entry.id))
      setLoadingId((current) => (current === entry.id ? null : current))
      if (outcome.ok) detailCache.current.set(entry.id, outcome.value)
      else setDetailFailure({ entryId: entry.id, message: outcome.failure.message })
    },
    [deps],
  )

  const groups = useMemo(() => groupByProject(entries ?? [], t), [entries, t])
  // 选择面（多选 / 折叠 / 勾选与它们派生的三样只读）整块住在 `use-trash-selection.ts`（候选 3 的第三道 seam）。
  const selection = useTrashSelection({ entries, groups })
  const {
    selectMode, checked, checkedIds, ordered, allCollapsed,
    isCollapsed, enterSelect, exitSelect, toggleGroup, toggleAllGroups,
    toggleCheck, toggleGroupCheck, groupFullyChecked, groupPartiallyChecked,
  } = selection

  // 清单换了（别处删了一条、恢复成功、彻底删除成功）：选中那条已经不在了就让位，并把它的缓存丢掉。
  useEffect(() => {
    if (entries === null || selectedId === null) return
    if (entries.some((entry) => entry.id === selectedId)) return
    detailCache.current.delete(selectedId)
    setSelectedId(null)
    setDrilled(false)
  }, [entries, selectedId])

  // 宽档首读完成后自动选中第一条：右栏空着比多一次点击更怪（窄档不自动下钻）。
  useEffect(() => {
    if (split && selectedId === null && ordered.length > 0) void select(ordered[0]!)
  }, [split, selectedId, ordered, select])

  const focusRow = useCallback((entryId: string): void => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-entry-id="${entryId}"]`)
    node?.focus()
  }, [])

  /**
   * 下钻里按 Esc 退回清单（设计稿 2026-10-15 §2.4）。
   *
   * 监听挂在 `document` 而不是清单容器：窄档下钻时清单**不在 DOM 里**，挂在容器上的 Esc 是一条
   * 永远收不到的死路径。退回后焦点交还给选中的那一行（行还没进 DOM，所以记一笔等这一拍渲染完再做）。
   */
  const refocusRow = useRef<string | null>(null)
  useEffect(() => {
    if (!drilled) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      refocusRow.current = selectedId
      setDrilled(false)
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [drilled, selectedId])

  useEffect(() => {
    if (drilled || refocusRow.current === null) return
    focusRow(refocusRow.current)
    refocusRow.current = null
  }, [drilled, focusRow])

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (ordered.length === 0) return
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
      if (index < 0) return
      event.preventDefault()
      // 多选态下 Enter/Space 说的是"勾上/取消这一条"，光标仍由 ↑↓ 移动（listbox 的常规分工）。
      if (selectMode) {
        toggleCheck(ordered[index]!.id)
        return
      }
      void select(ordered[index]!, { drill: true })
    }
  }

  const failRow = (entryId: string, message: string): void => {
    setActionFailure((current) => ({ ...current, [entryId]: message }))
  }

  const restore = async (entry: TrashEntryLike): Promise<void> => {
    setActionFailure((current) => {
      const next = { ...current }
      delete next[entry.id]
      return next
    })
    await around(async () => {
      const outcome = await callRemote(() => applyOne(deps, 'restore', entry.id).then((item) => item.value))
      if (!outcome.ok) {
        failRow(entry.id, outcome.failure.message)
        return
      }
      detailCache.current.delete(entry.id)
      // `around` 把 `busy` 保持到 refresh 结束：否则这一拍旧清单还在屏上，同一个动作能被再点一次。
      await refresh()
    })
  }

  /** 一段批量 → 组件状态：成功的丢详情缓存，失败的原文落回它自己那一行。整批一次上屏、一次重读。 */
  const settleOutcomes = (outcomes: readonly ApplyOutcome[]): void => {
    const failures: Array<{ id: string; message: string }> = []
    for (const outcome of outcomes) {
      if (outcome.ok) detailCache.current.delete(outcome.id)
      else failures.push({ id: outcome.id, message: outcome.error.message })
    }
    if (failures.length > 0) {
      setActionFailure((current) => {
        const next = { ...current }
        for (const failure of failures) next[failure.id] = failure.message
        return next
      })
    }
  }

  /**
   * 批量彻底删除 / 批量恢复**共用这一条**（2026-10-17 批量重构）：一次 `apply` 把整批交给 Node 半，
   * 逐条成败住在 `ApplyOutcome` 里 ⇒ 组件不再自己拼循环、也不再"每条一次全量重读"。
   */
  const confirmApply = async (action: 'purge' | 'restore', ids: readonly string[]): Promise<void> => {
    await around(async () => {
      const outcome = await callRemote(() => deps.applyOutcomes(action, ids))
      setPending(null)
      if (!outcome.ok) {
        // 整次调用没办成（路由自检 / 通道断）：这批一条都没落地 ⇒ 原文摆到每一行，别让清单看起来"删成功了"
        for (const id of ids) failRow(id, outcome.failure.message)
      } else {
        settleOutcomes(outcome.value)
      }
      await refresh()
    })
  }

  const confirmPurge = async (): Promise<void> => {
    const target = pending
    if (target === null) return
    if (target.kind === 'entries') return confirmApply('purge', target.ids)
    if (target.kind === 'restore') return confirmApply('restore', target.ids)
    if (target.kind === 'entry') return confirmApply('purge', [target.entry.id])
    // 清空：聚合回执、不按条回，所以它不走 `apply`（形状不同，不是偷懒）。
    // 失败落在"清单读不到"那一格、成功就把详情缓存清空——两件都由 `useTrashQuery.emptyTrash` 之外的这里定。
    const emptied = await query.emptyTrash()
    setPending(null)
    if (emptied) detailCache.current.clear()
  }

  /** 清理那批无主子会话：整块住在 `useTrashQuery.cleanOrphans`（扫描的报告、两种失败的分流、先刷新后落提示
   *  都在那一条里）；这里只负责把确认框收起来。 */
  const confirmOrphans = async (): Promise<void> => {
    await query.cleanOrphans()
  }
  /**
   * 详细信息那块的选中集合：确认框要把"这一批有哪些、要去哪"摆出来，靠的全量条目是从勾选 id 反查
   * （顺序已经是"清单从上往下"）——清单里找不到的 id 是别的窗口刚动过，滤掉不等于丢动作
   * （重读会把它从勾选里也剔掉）。
   */
  const byIdEntries = useMemo(() => new Map((entries ?? []).map((entry) => [entry.id, entry])), [entries])
  const restoreEntries = pending?.kind === 'restore'
    ? pending.ids.map((id) => byIdEntries.get(id)).filter((entry): entry is TrashEntryLike => entry !== undefined)
    : []

  // 头部合计要把组里孩子与盘上后代的字节都算上：它们不单独列行，只加父那一格就会少报（少报的就是那 74.6 MB 那一类）
  const totalBytes = (entries ?? []).reduce((sum, entry) => sum + entry.releaseBytes, 0)
  // 分桶在**每次渲染**时按当前时刻算，但本面板**没有计时器**：一条"59分钟"可以挂到下次重读、
  // 交互或失效通告为止（桶最细到分钟，而回收站不是盯着看的界面）。这是取舍，不是"不会停在旧读数"。
  const now = Date.now()
  const hasEntries = entries !== null && entries.length > 0
  /**
   * 页脚那句在两种模式（清理 / 多选）下用同一份：多选态现在能删也能恢复，"选中的 N 条不可恢复"
   * 在准备批量恢复时是假话——那类具体警告归各自的确认框，这里只留两件事：回收站在哪、不自动过期。
   */
  const noteParts = splitOn(t('trash.footer.note', { dir: TRASH_DIR }), TRASH_DIR)
  /**
   * 选中那条从**全量条目**里找，不从 `ordered`（只含展开的组）里找：把选中那条所在的组折叠起来
   * 只是把那一列收掉，右栏那条不该跟着消失——详情读的是这条会话，跟清单怎么分段无关。
   */
  const selected = (entries ?? []).find((entry) => entry.id === selectedId) ?? null
  /** `aria-activedescendant` 只能指向**在 DOM 里**的那一行：折叠起来之后它就是不存在，指过去是假引用。 */
  const activeDescendantId = ordered.some((entry) => entry.id === selectedId) ? selectedId : null
  /**
   * 清单里那个唯一的 tab 落点（roving tabindex）。它必须**永远有一行拿着**：窄档不自动选中，
   * 只按"选中那行拿 0"来给的话，一次没点过时全行都是 `-1`，键盘根本进不来清单。
   * 落点与 `aria-activedescendant` 同一条可见性规则——选中那行被折叠起来时落到第一条可见行。
   */
  const tabStopId = activeDescendantId ?? ordered[0]?.id ?? null

  const detailState: TrashDetailState = useMemo(() => {
    if (selected === null) return { kind: 'idle' }
    if (loadingId === selected.id) return { kind: 'loading', entry: selected }
    const cached = detailCache.current.get(selected.id)
    if (cached !== undefined) return { kind: 'ready', entry: selected, detail: cached }
    if (detailFailure?.entryId === selected.id) return { kind: 'failed', entry: selected, message: detailFailure.message }
    return { kind: 'loading', entry: selected }
  }, [selected, loadingId, detailFailure])

  /**
   * 清单容器（roving tabindex 那个唯一的 tab 巢）。`flex:'1 1 auto'` 是**空态居中链**的一节：
   * 空态块自己有 `flex:1` + `justifyContent:center`，但要有**有高度的**父链才居得起来——本层是
   * 两栏改造（2026-10-15）新插进来的 div，缺这条 flex 就把链断在"内容高"上、空态图标贴左上角
   * （2026-10-16 真机反馈）。长清单不受影响：`min-height:auto` 把它钉在内容高，滚动照旧归外层。
   */
  const list = (
    <div
      ref={listRef}
      data-dsh-session-delete="trash-list"
      role="listbox"
      aria-label={t('detail.list.label')}
      aria-activedescendant={activeDescendantId === null ? undefined : `sd-trash-${activeDescendantId}`}
      aria-multiselectable={selectMode ? true : undefined}
      tabIndex={-1}
      onKeyDown={onListKeyDown}
      style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: '1 1 auto', minWidth: 0 }}
    >
      {listFailure !== null ? (
        <div role="status" style={{ ...CARD, alignItems: 'flex-start', gap: 12, padding: '14px' }}>
          <span
            style={{ display: 'inline-flex', flex: 'none', paddingTop: 2, color: 'var(--dsw-alias-state-error-primary)' }}
            aria-hidden="true"
          >
            <IconWarningOutlineRegular size={16} />
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 auto', minWidth: 0 }}>
            <div style={{ fontSize: 13, lineHeight: '19px' }}>{t('trash.readFailed')}</div>
            <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-word' }}>
              {listFailure}
            </div>
          </div>
          <Button variant="outline" size="sm" style={{ flex: 'none' }} onClick={() => void refresh()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : entries === null ? (
        <div style={{ padding: '20px 2px', fontSize: 12.5, color: 'var(--dsw-alias-label-tertiary)' }}>{t('trash.loading')}</div>
      ) : entries.length === 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            flex: '1 1 auto',
            padding: '24px',
            textAlign: 'center',
          }}
        >
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 46,
              height: 46,
              flex: 'none',
              borderRadius: 999,
              background: 'var(--dsw-alias-bg-layer-2)',
              color: 'var(--dsw-alias-label-tertiary)',
            }}
            aria-hidden="true"
          >
            <IconTrashOutlineRegular size={20} />
          </span>
          <div style={{ fontSize: 13.5, color: 'var(--dsw-alias-label-secondary)' }}>{t('trash.empty.title')}</div>
          <div style={{ maxWidth: 340, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }}>
            {t('trash.empty.hint')}
          </div>
        </div>
      ) : (
        groups.map((group) => (
          <section
            key={group.projectDir}
            data-dsh-session-delete="trash-group"
            aria-label={group.label}
            style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}
          >
            {/* 折叠头抄宿主的 `DisclosureRow`（`ui.css` 里那一段）：前导一枚官方 chevron 说
                "展开中/已折叠"，`aria-expanded` 给读屏。组头本身**不跟着收掉**——收掉就没有
                再点开的地方了。计数留在组头上，所以折叠之后"这个项目还有几条"仍然看得见。
                两处与宿主那份的必要差别：① 我们这一行的可点部分是 `<button>`，UA 的
                `text-align:center` 会渗进里面的文字（真机上项目名整个居中就是这个），显式压成 `start`；
                ② 多选态下勾选框住在按钮**外面**——`<input>` 是交互内容，不能嵌进 `<button>`。 */}
            <div
              data-dsh-session-delete="trash-group-row"
              style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}
            >
              {selectMode ? (
                <Checkbox
                  checked={groupFullyChecked(group)}
                  indeterminate={groupPartiallyChecked(group)}
                  label={t('trash.select.group', { project: group.label, count: group.entries.length })}
                  onChange={() => { toggleGroupCheck(group) }}
                />
              ) : null}
              <button
                type="button"
                className="sd-disclosure-row"
                data-dsh-session-delete="trash-group-head"
                data-expandable=""
                aria-expanded={!isCollapsed(group.projectDir)}
                onClick={() => { toggleGroup(group.projectDir) }}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  font: 'inherit',
                  textAlign: 'start',
                  flex: '1 1 auto',
                  gap: 6,
                }}
              >
                <span className="sd-disclosure-leading" aria-hidden="true">
                  {isCollapsed(group.projectDir)
                    ? <IconChevronRightOutlineRegular size={14} />
                    : <IconChevronDownOutlineRegular size={14} />}
                </span>
                <span style={{ display: 'inline-flex', flex: 'none', color: 'var(--dsw-alias-label-tertiary)' }} aria-hidden="true">
                  <IconFolderOpenOutlineRegular size={13} />
                </span>
                <span
                  className="sd-disclosure-title"
                  style={{ ...ELLIPSIS, minWidth: 0, flex: '1 1 auto', fontWeight: 500 }}
                  title={group.projectDir}
                >
                  {group.label}
                </span>
                <span style={{ marginLeft: 'auto', flex: 'none', fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)' }}>
                  {t('trash.group.count', { count: group.entries.length })}
                </span>
              </button>
            </div>

            {isCollapsed(group.projectDir) ? null : group.entries.map((entry) => {
              const isSelected = entry.id === selectedId
              const isChecked = checked.has(entry.id)
              const title = entry.title === '' ? t('common.untitled') : entry.title
              const kids = entry.subagentCount ?? 0
              const stranded = entry.strandedSubagents ?? 0
              return (
                <div
                  key={entry.id}
                  id={`sd-trash-${entry.id}`}
                  role="option"
                  aria-selected={selectMode ? isChecked : isSelected}
                  tabIndex={entry.id === tabStopId ? 0 : -1}
                  data-dsh-session-delete="trash-row"
                  data-entry-id={entry.id}
                  style={isSelected ? CARD_SELECTED : CARD}
                  onClick={() => {
                    // 多选态下点行说的是"勾上/取消这一条"，不再切换详情：两套语义同时活在一次点击里
                    // 一定有一套是错的（设计稿 §7 状态④）。
                    if (selectMode) {
                      toggleCheck(entry.id)
                      return
                    }
                    void select(entry, { drill: !split })
                  }}
                >
                  {/* 勾选框在**标题左侧**（照用户给的参考图那一版布局）。两颗动作按钮这时整排退场：
                      一次只给一种动作语义，不会在批量确认框旁边再手滑点到单条「彻底删除…」。 */}
                  {selectMode ? (
                    <Checkbox
                      checked={isChecked}
                      label={t('trash.select.row', { title })}
                      onChange={() => { toggleCheck(entry.id) }}
                    />
                  ) : null}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flex: '1 1 auto', minWidth: 0 }}>
                    <div style={{ ...ELLIPSIS, fontSize: 14, lineHeight: '20px' }} title={entry.title === '' ? undefined : entry.title}>
                      {title}
                    </div>
                    <div
                      style={{ ...ELLIPSIS, fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}
                      title={absoluteText(entry.deletedAt)}
                    >
                      {[
                        deletedAgo(entry.deletedAt, now, t),
                        fileSizeText(entry.sizeBytes),
                        // 两个数各说各的：进了回收站的说"含"，还在盘上的说"还剩"——混成一个就是假话
                        kids > 0 ? t('trash.row.subagents', { n: kids }) : '',
                        stranded > 0 ? t('trash.row.strandedSubagents', { n: stranded }) : '',
                      ].filter(Boolean).join(' · ')}
                    </div>
                    {/* 原工作区已被删掉（宿主的「删除工作区」只删注册、保留日志）：恢复照样能回盘，
                        但会落在「未分组」。**点之前**就告诉用户它要去哪——这条不在行右侧的失败位，
                        它是这一条的属性，不是某次动作的结果。 */}
                    {entry.workspaceMissing === true ? (
                      <div
                        data-dsh-session-delete="trash-row-workspace-gone"
                        style={{ fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}
                      >
                        {t('trash.row.workspaceGone')}
                      </div>
                    ) : null}
                    {/* 恢复/彻底删除 的失败原文留在这条记录上（2026-10-15 真机反馈：动作回到行内，
                        失败也就跟着回行内——"动作与它的原因在同一行"这条从 §7 沿下来，没换地方）。 */}
                    {actionFailure[entry.id] === undefined ? null : (
                      <div
                        role="status"
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 6,
                          paddingTop: 3,
                          fontSize: 12,
                          lineHeight: '16px',
                          color: 'var(--dsw-alias-state-error-primary)',
                        }}
                      >
                        <span style={{ display: 'inline-flex', flex: 'none' }} aria-hidden="true">
                          <IconWarningOutlineRegular size={13} />
                        </span>
                        <span>{actionFailure[entry.id]}</span>
                      </div>
                    )}
                  </div>
                  {/* 两颗动作按钮住在行右侧（与 2026-10-01 那版同形）。选中态只改变卡片底色与描边，
                      不抢动作的位置——动作一直在，看详情才需要点整行。多选态整排退场。 */}
                  {selectMode ? null : (
                    <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => void restore(entry)}>
                        {t('trash.row.restore')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        style={QUIET_DANGER}
                        icon={<IconTrashOutlineRegular size={13} />}
                        disabled={busy}
                        onClick={() => setPending({ kind: 'entry', entry })}
                      >
                        {t('trash.row.purge')}
                      </Button>
                    </div>
                  )}
                </div>
              )
            })}
          </section>
        ))
      )}
    </div>
  )

  const detailPane = (
    <div data-dsh-session-delete="trash-detail" style={DETAIL_COLUMN}>
      <div style={DETAIL_INNER}>
        <TrashDetail
          state={detailState}
          busy={busy}
          wide={split}
          onRetry={() => {
            if (selected !== null) void select(selected)
          }}
          onBack={() => setDrilled(false)}
          t={t}
        />
      </div>
    </div>
  )

  /**
   * 那一排**常驻面板体顶端**，不住清单列里：它原先在滚动容器内，长清单滚到底会把开关滚走。
   * 宽度上限跟着清单列走，所以它在视觉上仍然"属于清单"。
   *
   * 这里曾有一颗「刷新」图标（2026-10-15 第三批收进那一排、第四批降级成图标，**2026-10-16
   * 按用户裁定删除**）：清单现在是"每次读都对账"（见 `reconcile.ts`），开面板、切走再切回、
   * 重启——任何一次读都会先同步，那颗按钮不再承担别人替代不了的活。
   */
  const toolbar = (
    <div
      style={{ ...TOOLBAR, maxWidth: split ? resize.listWidth : 'none' }}
      data-dsh-session-delete="trash-toolbar"
    >
      <Button variant="ghost" size="sm" onClick={toggleAllGroups} disabled={!hasEntries}>
        {allCollapsed ? t('trash.toolbar.expandAll') : t('trash.toolbar.collapseAll')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={!hasEntries}
        aria-pressed={selectMode}
        onClick={() => {
          if (selectMode) exitSelect()
          else enterSelect()
        }}
      >
        {selectMode ? t('trash.toolbar.selectExit') : t('trash.toolbar.select')}
      </Button>
    </div>
  )

  /** 清单列：宽档定宽（可拖）、窄档铺满。 */
  const listPane = (style: CSSProperties) => <div style={style}>{list}</div>

  return (
    <div
      ref={rootRef}
      data-dsh-session-delete="trash-panel"
      className={resize.resizing ? 'sd-resizing' : undefined}
      style={PAGE}
    >
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, paddingBottom: 14 }}>
        <div style={{ ...ELLIPSIS, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600, lineHeight: '24px' }}>{t('trash.title')}</div>
          {selectMode ? (
            // 多选态下头部这一行说的是"勾了几条"——合计占用那一句这时候不是主角，勾选数才是。
            <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)' }}>
              {t('trash.select.count', { count: checkedIds.length })}
            </div>
          ) : hasEntries ? (
            <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)' }}>
              {t('trash.summary', { count: entries.length, size: fileSizeText(totalBytes) })}
            </div>
          ) : null}
        </div>
      </div>

      {/* 回收站之外的无主子会话（2026-10-19）。**只在报告非空时出现**——"检查过了，什么都没有"不是
          要给用户看的东西，而那份报告读不到时走下面那块失败（不是这里，更不是"零条"）。
          层级沿用页面上那一条：警告色的图标 + 一句话 + 一颗描边动作，实心红仍然只归「清空回收站…」
          （确认框里那块是它的后续，与彻底删除同一个规矩）。 */}
      {orphanReport !== null && orphanReport.totalSessions > 0 ? (
        <div
          data-dsh-session-delete="orphan-banner"
          style={{ ...CARD, alignItems: 'flex-start', gap: 12, marginBottom: 10 }}
        >
          <span style={{ display: 'inline-flex', flex: 'none', paddingTop: 2, color: 'var(--dsw-alias-state-warn-primary)' }} aria-hidden="true">
            <IconWarningOutlineRegular size={16} />
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 auto', minWidth: 0 }}>
            <div style={{ fontSize: 13, lineHeight: '19px' }}>
              {t('trash.orphans.banner', { count: orphanReport.totalSessions })}
            </div>
            <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}>
              {t('trash.orphans.meta', {
                size: fileSizeText(orphanReport.totalBytes),
                parents: orphanReport.missingParents,
              })}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            style={{ flex: 'none' }}
            disabled={busy}
            onClick={() => {
              if (busy) return
              query.openOrphanPreview()
            }}
          >
            {t('trash.orphans.open')}
          </Button>
        </div>
      ) : null}

      {/* 检查/清理自己失败：这是"我们没能回答有多少残留"，与"没有残留"是两件事 ⇒ 原位上屏 + 重试，
          绝不静默折成一条都不出现（Task 4 交下来的那条判据）。 */}
      {orphanFailure !== null ? (
        <div role="status" style={{ ...CARD, alignItems: 'flex-start', gap: 10, marginBottom: 10, padding: '10px 12px' }}>
          <span style={{ display: 'inline-flex', flex: 'none', color: 'var(--dsw-alias-state-error-primary)' }} aria-hidden="true">
            <IconWarningOutlineRegular size={15} />
          </span>
          <span style={{ flex: '1 1 auto', minWidth: 0, wordBreak: 'break-word', fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-state-error-primary)' }}>
            {orphanFailure}
          </span>
          <Button variant="outline" size="sm" style={{ flex: 'none' }} disabled={busy} onClick={() => void refresh()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : null}

      {/* 「已经不在」不是失败：别处清掉或父已回到清册。中性一条，下次扫描/刷新时自然消失。 */}
      {orphanNotice !== null ? (
        <div
          data-dsh-session-delete="orphan-notice"
          role="status"
          style={{ ...CARD, alignItems: 'flex-start', gap: 10, marginBottom: 10, padding: '10px 12px' }}
        >
          <span style={{ display: 'inline-flex', flex: 'none', paddingTop: 2, color: 'var(--dsw-alias-label-tertiary)' }} aria-hidden="true">
            <IconWarningOutlineRegular size={15} />
          </span>
          <span style={{ flex: '1 1 auto', minWidth: 0, wordBreak: 'break-word', fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-label-secondary)' }}>
            {orphanNotice}
          </span>
        </div>
      ) : null}

      {toolbar}

      <div style={BODY}>
        {split ? (
          <>
            {listPane({ ...LIST_COLUMN, flex: `0 0 ${resize.listWidth}px`, width: resize.listWidth })}
            <span className="sd-width-handle" {...resize.handleProps} />
            {detailPane}
          </>
        ) : drilled && selected !== null ? (
          detailPane
        ) : (
          // 单列时铺满 BODY：不给 flex，这一栏会按内容宽缩在行的左边（空态时约 390px）
          listPane({ ...LIST_COLUMN, flex: '1 1 auto' })
        )}
      </div>

      {hasEntries ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 2px',
            borderTop: '0.5px solid var(--dsw-alias-border-l2)',
          }}
        >
          {/* 这句里「不自动过期」是**必须看得见**的告警，所以别处都用 ELLIPSIS、这一处不用：
              520px 窗（正文列 405）量到这句 `scrollWidth 360 > clientWidth 280` ⇒ 套上省略号就被截断。
              句子整体一个 key（`trash.footer.note`，占位符 `{dir}`），渲染时按 `dir` 的值切一刀、把那一截
              包成 code——不拆成前后两段翻译，免得两种语言各钉一次语序。多选态共用这一份：动作专属的
              警告（"不可恢复"）归各自的确认框，2026-10-17 起这句不再分两版。 */}
          <span style={{ minWidth: 0, fontSize: 11.5, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}>
            {noteParts[0]}
            <span style={{ fontFamily: 'var(--ds-font-family-code)', fontSize: 11 }}>{noteParts[1]}</span>
            {noteParts[2]}
          </span>
          <span style={{ marginLeft: 'auto', flex: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* 多选态下这里住两颗：**恢复 N 条**（描边款，无确认框的单行「恢复」的批量版——它带确认框，
                因为一批条目多、去向是各自的旧项目目录）与**彻底删除 N 条**（实心红）。危险那颗位置不换：
                §7 那句"整页唯一一块实心红"靠"它永远是这一排的最后一个"来守。
                一条没勾时两颗都置灰，原因走 Tooltip——置灰的按钮自己不吃 hover，anchor 用一层 span，
                与 `delete-menu-item` 那处运行中置灰是同一个路子。 */}
            {selectMode ? (
              <>
                <Tooltip label={t('trash.select.needOne')} side="top" portal disabled={checkedIds.length > 0}>
                  <span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={checkedIds.length === 0 || busy}
                      onClick={() => setPending({ kind: 'restore', ids: checkedIds })}
                    >
                      {t('trash.select.restore', { count: checkedIds.length })}
                    </Button>
                  </span>
                </Tooltip>
                <Tooltip label={t('trash.select.needOne')} side="top" portal disabled={checkedIds.length > 0}>
                  <span>
                    <Button
                      variant="primary"
                      size="sm"
                      style={BULK_DANGER}
                      icon={<IconTrashOutlineRegular size={13} />}
                      disabled={checkedIds.length === 0 || busy}
                      onClick={() => setPending({ kind: 'entries', ids: checkedIds })}
                    >
                      {t('trash.select.purge', { count: checkedIds.length })}
                    </Button>
                  </span>
                </Tooltip>
              </>
            ) : (
              <Button
                variant="primary"
                size="sm"
                style={BULK_DANGER}
                icon={<IconTrashOutlineRegular size={13} />}
                disabled={busy}
                onClick={() => setPending({ kind: 'all' })}
              >
                {t('trash.emptyAll')}
              </Button>
            )}
          </span>
        </div>
      ) : null}

      {pending === null ? null : (
        <TrashConfirm
          pending={pending}
          restoreEntries={restoreEntries}
          busy={busy}
          t={t}
          onCancel={() => setPending(null)}
          onConfirmPurge={() => void confirmPurge()}
          onConfirmRestore={(ids) => void confirmApply('restore', ids)}
        />
      )}

      {orphanConfirm && orphanReport !== null ? (
        <OrphanConfirm
          report={orphanReport}
          busy={busy}
          t={t}
          onCancel={() => setOrphanConfirm(false)}
          onConfirm={() => void confirmOrphans()}
        />
      ) : null}
    </div>
  )
}
