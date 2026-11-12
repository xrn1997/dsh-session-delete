/**
 * 回收站界面共用的**视图词汇**：卡片配方、清单行、危险红、项目名与分组的念法。
 *
 * 它从 `trash-panel.tsx` 拆出来，因为清单面板与两个确认框（`trash-confirm.tsx`）都要用这几样——
 * 拆之前它们同住一个文件、只能靠"同一个文件里的常量"共享。拆之后两处读的是同一份，不是两份抄写。
 *
 * **配色与圆角一律走 token，字号是字面量 px**（宿主同类面也这么写）：卡片用宿主设置面的底层 token
 * （`bg-layer-2` + `border-l4` + `radius-lg`），清单行不铺底不描边、选中态只换宿主"选中"那一档底色。
 */
import type { CSSProperties } from 'react'
import { NO_CWD_PROJECT_DIR, unescapeProjectKey } from '../shared/project-key.js'
import type { Translate } from './copy.js'

/** 卡片配方：宿主设置面的 fill/stroke 底层 token + 官方 `lg` 圆角。 */
export const CARD: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  minWidth: 0,
  padding: '9px 14px',
  background: 'var(--dsw-alias-bg-layer-2)',
  border: '0.5px solid var(--sd-border-l4)',
  borderRadius: 'var(--sd-radius-lg)',
}

/**
 * 清单条目行：与 `CARD` 同族但**不铺底、不描边**。
 *
 * 为什么和 `CARD` 分成两份而不改 `CARD`：`CARD` 还被读数失败块与附件回执块借用（`trash-panel.tsx`
 * 的 `role="status"`、`attachment-view.tsx`），那一类是"要打断你视线的一块"，带底色和边框才对；
 * 清单行是"一列可以扫的东西"，边框叠出来就是 2010 年代后台面板的长相。
 *
 * 悬停底色与动作列的低强调/提亮住在 `ui/layout.css`：inline style 表达不了 `:hover` /
 * `:focus-within`，而 `ui.css` 是照宿主明文逐字抄的对照表，混进自造规则会把保真复核弄脏
 * （同 `forms.css` 文件头给的理由）。
 */
export const ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  minWidth: 0,
  padding: '8px 10px',
  borderRadius: 'var(--sd-radius-lg)',
}

/**
 * 选中行：底色用 inline style **故意压在** `layout.css` 的悬停底色之上——元素上的声明优先于
 * 样式表里的 `:hover` 规则，选中与悬停同时成立时看到的是选中那一档，不会闪。
 */
export const ROW_SELECTED: CSSProperties = {
  ...ROW,
  background: 'var(--sd-button-ghost-active-fill)',
}

/**
 * **整页唯一那块实心红**的写法：`variant="primary"` + 在元素上覆盖 primary 那对填充 token。
 * 宿主插件管理页的 danger 按钮就是这个写法（asar @21658274），所以 hover 仍走 `.primary:hover` 类。
 *
 * 覆盖的是**本插件别名层**（`--sd-*`，见 `ui.css` 头注）而不是宿主私有 token：别名在 `body` 上
 * 就把 `var(--dsw-…, 兜底)` 算完并继承下来了，元素上再覆盖底层私有 token 已经传不进继承值。
 */
export const BULK_DANGER = {
  '--sd-button-primary-fill': 'var(--dsw-alias-state-error-primary)',
  '--sd-button-primary-hover': 'var(--dsw-alias-state-error-primary)',
} as CSSProperties

/**
 * 项目名怎么念：宿主的 `projectKey` 把 cwd 里的 `/`、`\`、`:` 全折成**一个** `-` ⇒ 分隔符那部分有损、
 * 拆不回真实路径；但**非分隔符那部分可逆**（`~XXXX` 十六进制码元，字面 `~` 编成 `~007E`）。
 * 摘掉 `--…--` 裹边、还原这些转义，剩下的原样摆出来，完整串交给组头 `title`。
 * 字母表只有一份：还原走 `src/shared/project-key.ts` 的 `unescapeProjectKey`；无 cwd 的目录名
 * 也认同一个共享字面量（`NO_CWD_PROJECT_DIR`），不在浏览器半另写一份 `_no-cwd`。
 */
export function projectLabel(projectDir: string, t: Translate): string {
  const bare = unescapeProjectKey(projectDir.replace(/^--/, '').replace(/--$/, ''))
  return bare === '' || bare === NO_CWD_PROJECT_DIR ? t('trash.project.unknown') : bare
}

/** 清单上的一个项目组（组头 + 组内的行，组内按时间键倒序）。两档共用：行类型是参数。 */
export interface ProjectGroup<R> {
  projectDir: string
  label: string
  /** 组头悬停的全文：未分组组用组名，其余用有损的原始 `projectDir`。 */
  title: string
  /** 「未分组」组：只有回收站档有（工作区已不在账本里的条目）；归档档不传 `ungroupedOf` ⇒ 恒 false。 */
  ungrouped: boolean
  /** 组内最新一条的时间键——组间排序的键。 */
  latest: number
  rows: readonly R[]
}

/**
 * 「未分组」组的键：工作区已从宿主账本删掉（`workspaceMissing`）的条目都归这里。
 * 哨兵值不与真实 `projectDir` 同形——空 cwd 已经由 `projectLabel` 念成「未记录项目」，
 * 两者不是同一件事，不能撞键。
 */
export const UNGROUPED_PROJECT_DIR = '__dsh-session-delete__ungrouped'

/** 分组键：回收站传删除时间 + workspaceMissing⇒未分组；归档传 `updatedAt`、不传 `ungroupedOf`。 */
export interface GroupKeys<R> {
  /** 排序时间键（trash: `deletedAt`；archive: `updatedAt`）。组内、组间都按它倒序。 */
  timeOf: (row: R) => number
  projectDirOf: (row: R) => string
  /** 只有回收站档传：命中 ⇒ 归「未分组」组（永远沉底）。 */
  ungroupedOf?: (row: R) => boolean
}

/** 按项目分组：组内按时间键倒序，组间按各组最新一条倒序；「未分组」组（若有）永远沉底。 */
export function groupByProject<R>(rows: readonly R[], t: Translate, keys: GroupKeys<R>): ProjectGroup<R>[] {
  const byProject = new Map<string, R[]>()
  for (const row of [...rows].sort((a, b) => keys.timeOf(b) - keys.timeOf(a))) {
    const key = keys.ungroupedOf?.(row) === true ? UNGROUPED_PROJECT_DIR : keys.projectDirOf(row)
    const list = byProject.get(key)
    if (list === undefined) byProject.set(key, [row])
    else list.push(row)
  }
  return [...byProject]
    // 进这条循环前整体按时间键倒序排过、且每组只由 push 建出来 ⇒ 每组第一条必在。
    // 显式判空（`noUncheckedIndexedAccess`）而不是非空断言：真缺了就不产生这一组，不伪造读数。
    .flatMap(([projectDir, list]) => {
      const first = list[0]
      if (first === undefined) return []
      const ungrouped = projectDir === UNGROUPED_PROJECT_DIR
      const label = ungrouped ? t('list.group.ungrouped') : projectLabel(projectDir, t)
      return [{
        projectDir,
        label,
        title: ungrouped ? label : projectDir,
        ungrouped,
        latest: keys.timeOf(first),
        rows: list,
      }]
    })
    .sort((a, b) => {
      if (a.ungrouped !== b.ungrouped) return a.ungrouped ? 1 : -1
      return b.latest - a.latest
    })
}

/** 显示名次序的前两格（ADR-0058）：`label` 非空优先，否则日志标题 `title`；都空回 `''`。
 *  **次序只有这一份**；兜底那句归调用方——子会话行念「(无标题会话)」、归档行念「未命名 · <短 id>」，
 *  那不是同一句话，但谁先谁后不许各拼一遍。 */
export function preferredNameOf(row: { readonly label?: string; readonly title: string }): string {
  return row.label !== undefined && row.label !== '' ? row.label : row.title
}

/** 归档行的显示名：次序走 `preferredNameOf`，都空回落「未命名 · <短 id>」。
 *  清单行、详情标题、删除确认框共用这一条（不许各拼一份）。 */
export function displayNameOf(row: { label?: string; title: string; sessionId: string }, t: Translate): string {
  const name = preferredNameOf(row)
  return name === '' ? t('archive.unnamed', { id: row.sessionId.slice(0, 8) }) : name
}

/** 详情标题排的显示名次序（两档共用）：行 label → 详情自己的 label → 行标题 → 日志标题 →
 *  调用方兜底。详情自己的 label 补的是没有父行可兜的独立子会话（ADR-0058）；行 label 是
 *  父日志 `subagent/catalog` 那一格。次序只住这里，两档各自算会漂。 */
export function detailNameOf(
  row: { readonly label?: string; readonly title: string },
  detail: { readonly label?: string; readonly logTitle: string } | undefined,
  fallback: string,
): string {
  if (row.label !== undefined && row.label !== '') return row.label
  if (detail !== undefined && detail.label !== undefined && detail.label !== '') return detail.label
  if (row.title !== '') return row.title
  if (detail !== undefined && detail.logTitle !== '') return detail.logTitle
  return fallback
}
