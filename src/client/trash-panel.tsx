/**
 * 回收站清单面板（设计稿 §7 状态 ④⑤）——**中央面板的本体**（`main` 槽的占用者）。
 *
 * 面板自带页面骨架（标题 / 条数与合计 / 刷新 / 滚动区 / 页脚），因为宿主给中央列的那个盒子
 * （`AppFrame` 的 `.centerCol`）只有背景与圆角，**没有 padding、也不是滚动容器**——asar 里那条
 * `.BynINW_centerCol{background:var(--dsw-alias-bg-base);border-radius:…;corner-shape:round}` 逐字
 * 如此。回收站可以很长（本机 85 个会话合计 15M），不自己收滚动就会把整列顶长。
 *
 * **2026-10-01 视觉改版：四列表格 → 按项目分组的卡片列表。**三条真机读数决定的：
 * ① 「原项目」那一列摆的是宿主的 `projectKey`（`--D-develop-GitHub-…--`），96px 的列宽只够露出驱动器
 *   和半截路径，等于没有信息；② 「删除时间」96px 装不下 `toLocaleString()` ⇒ 折成两行，行高在
 *   40/56px 之间抖；③ 表格没有行分隔，条数一多就读成一面墙。现在项目名做**组头**（一个项目只出现
 *   一次，整条给得下），时间走 `relativeTime` 的分桶（**函数是从官方 `primitives` 逐字抄进
 *   `ui/format.ts` 的**，与宿主侧栏同一套桶；措辞按该模块的约定留在 `copy.ts`），大小并到第二行
 *   元信息里，行与行的分隔交给卡片自己的边框。
 *
 * 卡片的底色/描边照抄宿主设置面自己的卡片配方（asar @28440420 逐字
 * `border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);
 * border-radius:var(--dsw-radius-xl)`，而 `body` 上这两个别名就解析成 `--dsw-alias-bg-layer-2` 与
 * `--dsw-alias-border-l4`）。这里**直接写这两个底层 token**而不是那两个 settings 别名：别名挂在宿主
 * 应用的 `body` 上、不是随包发布的组件面的一部分，底层那两个才是官方组件 CSS 自己在用的。圆角取
 * `--dsw-radius-lg`（16px）而不是卡片面的 `xl`（20px）——行高只有 60px 上下，20px 会把卡片吹成胶囊。
 *
 * 三条界面规则没有因为改版让路：
 * - **空态**：`回收站是空的`，且底部**不出现**「清空回收站…」（没有东西可清）。
 * - **失败写在行上**：恢复/彻底删除失败的原因留在那一行（卡片第二行下方，error 色 + 警示 glyph），
 *   不弹全局错误、不静默跳过；行不消失，按钮可以再点。清单本身读不到时不再是一枚胶囊——单独一块
 *   把原文摆出来并给「重试」；那时不是空态（"读不到"与"空的"是两件事）。两块失败都标了
 *   `role="status"`：读屏走到那里会把它当状态消息念，但**插入即播报并不保证**（`aria-live` 的播报看的是
 *   "已在场的区域里发生了变更"，而这两块是连着内容一起冒出来的）。要稳得常驻一个只给读屏看的播报台，
 *   那件事本机没有 AT 可验，所以留在这里当已知边界，不写成已经做到。
 * - **彻底删除要二次确认**：单条与清空走同一个确认框，正文明写「之后没有任何副本可以恢复」。
 *   **红色没有 danger 按钮变体**（官方那套 `Button` 只有 primary/ghost/outline/toolbar——我们抄来的
 *   `ui.css` 同样只这三档，宿主主题的 `--dsw-alias-button-*` 里也没有 danger 家族），所以两档危险
 *   各自照抄宿主自己组红色的两条配方：
 *   - **行内 = 安静的红**：只写 `color:--dsw-alias-state-error-primary`、**不写 background**——宿主设置面
 *     的行内 danger 按钮 @28442232 逐字就是 `color:…-error-primary;background:0 0;border:none`。不写底
 *     还有一层硬理由：作者态内联 `background` 永远赢过类规则，而 `ui.css` 里 `.sd-button-ghost:hover` /
 *     `.sd-button-ghost:active` 都是普通类、无 `!important` ⇒ 铺了内联底的按钮**在点错之前不给任何视觉回应**。
 *   - **批量与确认框 = 实心红**：`variant="primary"` 并在元素上就地覆盖 `--dsw-alias-button-primary-fill`
 *     与 `--dsw-alias-button-primary-hover` 为 `--dsw-alias-state-error-primary`（宿主插件管理页的 danger
 *     按钮 @21658274 逐字就这么干）。`.sd-button-primary:hover` 的类规则照常生效，红也是主题自洽的实心红。
 *   **层级**：整页只有一块实心红（「清空回收站…」，确认框里那块是它的后续），行内是安静的红——一次
 *   点错只损失一条，清空才是整页级的损失。（`--dsw-alias-interactive-bg-hover-danger` 是**hover 态**的
 *   透明红（浅色 5% / 深色 15% alpha；宿主拿它当底的是 @21305622 那条 error **块** `wq12jW_error`，
 *   不是芯片——`Tag[data-tone='danger']` 的底是 `color-mix(… 10%, transparent)`），当常置底既撑不起
 *   "实心"也不是它的用途，所以这里两处都不用它。）
 *
 * 布局只用**结构**内联样式（display/flex/gap/padding/overflow/max-width），**配色与圆角一律走 token**；
 * **字号是字面量 px**、取宿主同类面的读数（它也这么写，如 `fO69Vq_crumb{font-size:12.5px}`）。结构与
 * 层级归设计稿 §7（本仓不另存像素稿），皮肤只由 token 决定。控件样式住在 `src/client/ui/ui.css`
 * （照官方明文 CSS 抄的），由 `ui/styles.ts` 在浏览器半模块物化时挂成一个 `<style>`——**这是宿主给
 * 客户端插件的一等公民通道**（模块表会认领工厂物化时注入的 `<style>` 并在卸载/HMR 时摘掉），
 * 详见那里与设计稿 §10。
 *
 * **浅色主题已在真机看过（2026-10-01，用户截图：3 条 / 2 组）**：浅色下 `--dsw-alias-bg-base` 与
 * `--dsw-alias-bg-layer-2` 是同一个值（都解析成 `bluish-00`；深色才分 `950` / `850`）⇒ 卡片确实只剩
 * `border-l4` 一根描边与页面分隔，分组靠组头 + 间距站住——读得下来，但比深色薄。宿主自己的 `rowCard`
 * 是同一配方，所以这是宿主的取舍、不是本面板的偏差。**深色下的新版还没看过**（同一批 token，风险低）。
 */
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react'
import { unescapeProjectKey } from '../shared/wire.js'
import { splitOn, zhTranslate, type CopyKey, type Translate } from './copy.js'
import { callRemote, type SessionDeleteRemote, type TrashEntryLike } from './remote.js'
import { useTrashRevision } from './trash-store.js'
import { Button } from './ui/Button.js'
import { fileSizeText, relativeTime, type RelativeTimeUnit } from './ui/format.js'
import {
  IconFolderOpenOutlineRegular,
  IconRefreshOutlineRegular,
  IconTrashOutlineRegular,
  IconWarningOutlineRegular,
} from './ui/icons.js'
import { Modal } from './ui/Modal.js'

export type TrashPanelDeps = Pick<SessionDeleteRemote, 'list' | 'restore' | 'purge'>

export interface TrashPanelProps {
  deps: TrashPanelDeps
  /** 文案（缺省 = 内置 zh，见 `copy.ts`：这不是"忘了传"，而是"这次没有 locale 服务"）。 */
  t?: Translate
}

/** 待确认的彻底删除：一条记录，或整个回收站（`entryId` 缺省 = 清空）。 */
type PendingPurge = { kind: 'entry'; entry: TrashEntryLike } | { kind: 'all' }

/**
 * 行内的危险动作：只有字色，没有底（见头注——铺内联底会把 `.ghost:hover` 打死）。
 * 配 `variant="ghost"` 用。
 */
const ROW_DANGER = { color: 'var(--dsw-alias-state-error-primary)' } as const

/**
 * 整页那唯一一块实心红：`variant="primary"` + 在元素上覆盖 primary 那对填充 token。
 * 宿主插件管理页的 danger 按钮就是这个写法（asar @21658274），所以 hover 仍走 `.primary:hover` 类。
 */
const BULK_DANGER = {
  '--dsw-alias-button-primary-fill': 'var(--dsw-alias-state-error-primary)',
  '--dsw-alias-button-primary-hover': 'var(--dsw-alias-state-error-primary)',
} as CSSProperties

/** 回收站相对宿主**数据根**的位置。**不写 `~/.dsh/`**：数据根可以是 `$DSH_HOME` 指的别处
 *  （隔离宿主就是这么起的），写死会让这条页脚文案在那些环境下说谎。也是页脚那句里的 `{dir}`。 */
const TRASH_DIR = 'session-trash/'

/** 中央列在宽屏上就是整个对话区的宽度；清单不限宽会拉成一条横向的空。 */
const COLUMN_MAX_WIDTH = 760

/**
 * 页面骨架：撑满中央列（`height:100%` 落在 `.centerCol` 这个有定高的网格项上），自收滚动。
 *
 * `boxSizing:'border-box'` **不是装饰**：宿主文档没有全局 border-box reset（220 处 `box-sizing`
 * 声明全是组件自己带的，如 `.P2izSq_card *`），默认是 content-box ⇒ `height:100%` 再加 20px 上边距
 * 会溢出 20px，把页脚整块推到中央列底边之外（真机浅色截图上页脚那行贴着窗口下缘就是这个）。
 */
const PAGE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  height: '100%',
  minWidth: 0,
  padding: '20px 24px 12px',
}

/** 限宽的正文列（`margin:'0 auto'` 居中，滚动区在它内部）。 */
const COLUMN: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minHeight: 0,
  width: '100%',
  maxWidth: COLUMN_MAX_WIDTH,
  margin: '0 auto',
}

/**
 * 滚动区。
 *
 * **滚动条不需要注入任何 CSS 就已经是宿主的**：宿主在 `body` 上给出一组量（`--dsh-scrollbar-width:5px`、
 * thumb 圆角 999、色走 `--dsh-scrollbar-thumb`，默认 `--dsw-alias-scrollbar-bg-l1`），再用**全局**
 * `::-webkit-scrollbar*` 规则消费它们（asar @45064180 起，`ui-theme/src/styles/scrollbar.css`）
 * ⇒ 插件这里一个 `overflow:auto` 拿到的就是 5px 圆角 token 条，不是 Windows 默认的 15px 灰条。
 * 下面把 thumb 提到 `-l2` 那一档，与宿主自己的长滚动面同档（CodeCard、PopupSelectView 逐字设这两个
 * 自定义属性）。右内边距 10px 只是余量，不是修 bug。
 */
const SCROLLER = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  flex: '1 1 auto',
  minHeight: 0,
  overflow: 'auto',
  paddingRight: 10,
  paddingBottom: 16,
  // 自定义属性不在 csstype 的属性表里，走断言（与 `BULK_DANGER` 同一处写法）
  '--dsh-scrollbar-thumb': 'var(--dsw-alias-scrollbar-bg-l2)',
  '--dsh-scrollbar-thumb-hover': 'var(--dsw-alias-scrollbar-hover-l2)',
} as CSSProperties

/** 卡片配方：宿主设置面的 fill/stroke 底层 token + 官方 `lg` 圆角。 */
const CARD: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  minWidth: 0,
  padding: '9px 14px',
  background: 'var(--dsw-alias-bg-layer-2)',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 'var(--dsw-radius-lg)',
}

const ELLIPSIS: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/**
 * `relativeTime`（`ui/format.ts`，逐字抄自官方）只交回桶与量（`{unit, n}`），措辞按它自己的约定留在本面——现在那份措辞住
 * `copy.ts` 的字典里（单位词与宿主 zh 字典逐字对齐：`time.minutes="{n}分钟"`…
 * **数字与单位之间不空格**是它的写法）。`now` 桶不套模板——"删除于 刚刚前"不是话。
 */
const BUCKET_KEY: Record<Exclude<RelativeTimeUnit, 'now'>, CopyKey> = {
  minutes: 'trash.unit.minutes',
  hours: 'trash.unit.hours',
  days: 'trash.unit.days',
  months: 'trash.unit.months',
  years: 'trash.unit.years',
}

function deletedAtText(at: number): string {
  return new Date(at).toLocaleString()
}

/** 卡片第二行的时间短语；绝对时间另给 `title`。 */
function deletedAgo(at: number, now: number, t: Translate): string {
  const { unit, n } = relativeTime(at, now)
  return unit === 'now'
    ? t('trash.row.deletedNow')
    : t('trash.row.deletedAgo', { n, unit: t(BUCKET_KEY[unit]) })
}

/**
 * 宿主的 `projectKey`（逐字镜像见 `src/ports/host-port.ts`）把 cwd 里的 `/`、`\`、`:` 全折成**一个**
 * `-` ⇒ **分隔符那部分有损**：拆不回真实路径，也没法可靠认出哪几段是项目文件夹
 * （`dsh-session-delete` 自己就带连字符）。但**非分隔符那部分可逆**：不在 `[A-Za-z0-9._-]` 里、又不是
 * `~` 的字符编码成 `~` + 4 位大写十六进制码元，而字面 `~` 自己也被编成 `~007E` ⇒ 串里的 `~XXXX` 不含
 * 歧义（代理对拆成两个码元，逐个还原再拼起来仍是原字符）。所以中文目录能从 `D-develop-~-4E2D-6587`
 * 还原成 `D-develop-中文`。摘掉 `--…--` 裹边、还原这些转义，剩下的原样摆出来，完整串交给组头 `title`。
 * **字母表只有一份**：还原走 `shared/wire.ts` 的 `unescapeProjectKey`（编码那半在 Node 侧）。
 */
function projectLabel(projectDir: string, t: Translate): string {
  const bare = unescapeProjectKey(projectDir.replace(/^--/, '').replace(/--$/, ''))
  return bare === '' || bare === '_no-cwd' ? t('trash.project.unknown') : bare
}

interface ProjectGroup {
  projectDir: string
  label: string
  /** 组内最新一条的删除时间——组间排序的键。 */
  latest: number
  entries: readonly TrashEntryLike[]
}

/** 按项目分组：组内按删除时间倒序，组间按各组最新一条倒序（刚删掉的那个项目排在最上面）。 */
function groupByProject(entries: readonly TrashEntryLike[], t: Translate): ProjectGroup[] {
  const byProject = new Map<string, TrashEntryLike[]>()
  for (const entry of [...entries].sort((a, b) => b.deletedAt - a.deletedAt)) {
    const list = byProject.get(entry.projectDir)
    if (list === undefined) byProject.set(entry.projectDir, [entry])
    else list.push(entry)
  }
  return [...byProject]
    // 进这条循环前整体按 `deletedAt` 倒序排过 ⇒ 每组的第一条就是该组最新的一条，组必非空。
    .map(([projectDir, list]) => ({
      projectDir,
      label: projectLabel(projectDir, t),
      latest: list[0].deletedAt,
      entries: list,
    }))
    .sort((a, b) => b.latest - a.latest)
}

export function TrashPanel({ deps, t = zhTranslate }: TrashPanelProps) {
  const [entries, setEntries] = useState<readonly TrashEntryLike[] | null>(null)
  const [listFailure, setListFailure] = useState<string | null>(null)
  const [rowFailure, setRowFailure] = useState<Readonly<Record<string, string>>>({})
  const [pending, setPending] = useState<PendingPurge | null>(null)
  const [busy, setBusy] = useState(false)
  // 别处动过回收站（侧栏菜单里删了一条、或撤销了另一条）时，这一拍就把清单重读一遍，
  // 不用用户切走再切回来（失效通告台见 trash-store.ts 的头注）。
  const revision = useTrashRevision()

  const reload = useCallback(async (): Promise<void> => {
    const outcome = await callRemote(() => deps.list())
    if (!outcome.ok) {
      setListFailure(outcome.failure.message)
      setEntries(null)
      return
    }
    setListFailure(null)
    setEntries(outcome.value)
  }, [deps])

  useEffect(() => {
    void reload()
  }, [reload, revision])

  const failRow = (entryId: string, message: string): void => {
    setRowFailure((current) => ({ ...current, [entryId]: message }))
  }

  const restore = async (entry: TrashEntryLike): Promise<void> => {
    setRowFailure((current) => {
      const next = { ...current }
      delete next[entry.id]
      return next
    })
    const outcome = await callRemote(() => deps.restore(entry.id))
    if (!outcome.ok) {
      failRow(entry.id, outcome.failure.message)
      return
    }
    await reload()
  }

  const confirmPurge = async (): Promise<void> => {
    const target = pending
    if (target === null) return
    setBusy(true)
    const outcome = await callRemote(() =>
      target.kind === 'entry' ? deps.purge(target.entry.id) : deps.purge(undefined),
    )
    setBusy(false)
    if (!outcome.ok) {
      setPending(null)
      if (target.kind === 'entry') failRow(target.entry.id, outcome.failure.message)
      else setListFailure(outcome.failure.message)
      return
    }
    setPending(null)
    await reload()
  }

  const groups = useMemo(() => groupByProject(entries ?? [], t), [entries, t])
  const totalBytes = (entries ?? []).reduce((sum, entry) => sum + entry.sizeBytes, 0)
  // 分桶在**每次渲染**时按当前时刻算，但本面板**没有计时器**：一条"59分钟"可以挂到下次重读、
  // 交互或失效通告为止（桶最细到分钟，而回收站不是盯着看的界面）。这是取舍，不是"不会停在旧读数"。
  const now = Date.now()
  const hasEntries = entries !== null && entries.length > 0
  const noteParts = splitOn(t('trash.footer.note', { dir: TRASH_DIR }), TRASH_DIR)

  return (
    <div data-dsh-session-delete="trash-panel" style={PAGE}>
      <div style={COLUMN}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, paddingBottom: 14 }}>
          <div style={{ ...ELLIPSIS, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, lineHeight: '24px' }}>{t('trash.title')}</div>
            {hasEntries ? (
              <div
                style={{
                  fontSize: 12,
                  lineHeight: '17px',
                  color: 'var(--dsw-alias-label-tertiary)',
                }}
              >
                {t('trash.summary', { count: entries.length, size: fileSizeText(totalBytes) })}
              </div>
            ) : null}
          </div>
          <span style={{ marginLeft: 'auto', flex: 'none' }}>
            <Button
              variant="ghost"
              size="sm"
              icon={<IconRefreshOutlineRegular size={14} />}
              onClick={() => void reload()}
            >
              {t('common.refresh')}
            </Button>
          </span>
        </div>

        <div style={SCROLLER}>
          {listFailure !== null ? (
            <div role="status" style={{ ...CARD, alignItems: 'flex-start', gap: 12, padding: '14px' }}>
              <span
                style={{
                  display: 'inline-flex',
                  flex: 'none',
                  paddingTop: 2,
                  color: 'var(--dsw-alias-state-error-primary)',
                }}
                aria-hidden="true"
              >
                <IconWarningOutlineRegular size={16} />
              </span>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                  flex: '1 1 auto',
                  minWidth: 0,
                }}
              >
                <div style={{ fontSize: 13, lineHeight: '19px' }}>{t('trash.readFailed')}</div>
                <div
                  style={{
                    fontSize: 12,
                    lineHeight: '17px',
                    color: 'var(--dsw-alias-label-tertiary)',
                    wordBreak: 'break-word',
                  }}
                >
                  {listFailure}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                style={{ flex: 'none' }}
                onClick={() => void reload()}
              >
                {t('common.retry')}
              </Button>
            </div>
          ) : entries === null ? (
            <div
              style={{
                padding: '20px 2px',
                fontSize: 12.5,
                color: 'var(--dsw-alias-label-tertiary)',
              }}
            >
              {t('trash.loading')}
            </div>
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
              <div style={{ fontSize: 13.5, color: 'var(--dsw-alias-label-secondary)' }}>
                {t('trash.empty.title')}
              </div>
              <div
                style={{
                  maxWidth: 340,
                  fontSize: 12,
                  lineHeight: '18px',
                  color: 'var(--dsw-alias-label-tertiary)',
                }}
              >
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span
                    style={{
                      display: 'inline-flex',
                      flex: 'none',
                      color: 'var(--dsw-alias-label-tertiary)',
                    }}
                    aria-hidden="true"
                  >
                    <IconFolderOpenOutlineRegular size={13} />
                  </span>
                  <span
                    style={{
                      ...ELLIPSIS,
                      fontSize: 12,
                      fontWeight: 500,
                      color: 'var(--dsw-alias-label-secondary)',
                    }}
                    title={group.projectDir}
                  >
                    {group.label}
                  </span>
                  <span
                    style={{
                      marginLeft: 'auto',
                      flex: 'none',
                      fontSize: 11.5,
                      color: 'var(--dsw-alias-label-tertiary)',
                    }}
                  >
                    {t('trash.group.count', { count: group.entries.length })}
                  </span>
                </div>

                {group.entries.map((entry) => (
                  <div
                    key={entry.id}
                    data-dsh-session-delete="trash-row"
                    data-entry-id={entry.id}
                    style={CARD}
                  >
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 1,
                        flex: '1 1 auto',
                        minWidth: 0,
                      }}
                    >
                      <div
                        style={{ ...ELLIPSIS, fontSize: 14, lineHeight: '20px' }}
                        title={entry.title === '' ? undefined : entry.title}
                      >
                        {entry.title === '' ? t('common.untitled') : entry.title}
                      </div>
                      <div
                        style={{
                          ...ELLIPSIS,
                          fontSize: 12,
                          lineHeight: '16px',
                          color: 'var(--dsw-alias-label-tertiary)',
                        }}
                        title={deletedAtText(entry.deletedAt)}
                      >
                        {`${deletedAgo(entry.deletedAt, now, t)} · ${fileSizeText(entry.sizeBytes)}`}
                      </div>
                      {rowFailure[entry.id] === undefined ? null : (
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
                          <span>{rowFailure[entry.id]}</span>
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
                      <Button variant="outline" size="sm" onClick={() => void restore(entry)}>
                        {t('trash.row.restore')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        style={ROW_DANGER}
                        icon={<IconTrashOutlineRegular size={13} />}
                        onClick={() => setPending({ kind: 'entry', entry })}
                      >
                        {t('trash.row.purge')}
                      </Button>
                    </div>
                  </div>
                ))}
              </section>
            ))
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
            {/* 这句里的「清空后不可恢复」是**必须看得见**的告警，所以别处都用 ELLIPSIS、这一处不用：
                520px 窗（正文列 405）量到这句 `scrollWidth 360 > clientWidth 280` ⇒ 套上省略号它就被截断，
                窄幅下改成换行，尾巴不再取决于列宽。
                句子整体一个 key（`trash.footer.note`，占位符 `{dir}`），渲染时按 `dir` 的值切一刀、
                把那一截包成 code——**不拆成前后两段翻译**，免得两种语言各钉一次语序。 */}
            <span
              style={{
                minWidth: 0,
                fontSize: 11.5,
                lineHeight: '16px',
                color: 'var(--dsw-alias-label-tertiary)',
              }}
            >
              {noteParts[0]}
              <span style={{ fontFamily: 'var(--ds-font-family-code)', fontSize: 11 }}>
                {noteParts[1]}
              </span>
              {noteParts[2]}
            </span>
            <span style={{ marginLeft: 'auto', flex: 'none' }}>
              <Button
                variant="primary"
                size="sm"
                style={BULK_DANGER}
                icon={<IconTrashOutlineRegular size={13} />}
                onClick={() => setPending({ kind: 'all' })}
              >
                {t('trash.emptyAll')}
              </Button>
            </span>
          </div>
        ) : null}
      </div>

      {pending === null ? null : (
        <TrashPurgeConfirm
          pending={pending}
          busy={busy}
          t={t}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirmPurge()}
        />
      )}
    </div>
  )
}

function TrashPurgeConfirm({
  pending,
  busy,
  t,
  onCancel,
  onConfirm,
}: {
  pending: PendingPurge
  busy: boolean
  t: Translate
  onCancel: () => void
  onConfirm: () => void
}) {
  const title = pending.kind === 'all' ? t('trash.confirm.all') : t('trash.confirm.one')
  const strong = t('trash.confirm.body.strong')
  const body = splitOn(t('trash.confirm.body', { strong }), strong)
  return (
    <Modal
      open
      onClose={onCancel}
      title={title}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="outline" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" style={BULK_DANGER} disabled={busy} onClick={onConfirm}>
            {t('trash.confirm.purge')}
          </Button>
        </>
      }
    >
      {pending.kind === 'entry' ? (
        <div
          style={{
            ...CARD,
            flexDirection: 'column',
            alignItems: 'stretch',
            gap: 2,
            padding: '10px 12px',
            marginBlockEnd: 10,
          }}
        >
          <div style={{ ...ELLIPSIS, fontSize: 13.5, lineHeight: '19px' }}>
            {pending.entry.title === '' ? t('common.untitled') : pending.entry.title}
          </div>
          <div
            style={{
              ...ELLIPSIS,
              fontSize: 12,
              lineHeight: '16px',
              color: 'var(--dsw-alias-label-tertiary)',
            }}
          >
            {t('trash.confirm.one.meta', {
              project: projectLabel(pending.entry.projectDir, t),
              at: deletedAtText(pending.entry.deletedAt),
              size: fileSizeText(pending.entry.sizeBytes),
            })}
          </div>
        </div>
      ) : null}
      <p>
        {body[0]}
        <b style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{body[1]}</b>
        {body[2]}
      </p>
    </Modal>
  )
}
