/**
 * 回收站界面共用的**视图词汇**：卡片配方、清单行、危险红、项目名与分组的念法（面板与两个确认框共用）。
 * **配色与圆角一律走 token，字号是字面量 px**：卡片用宿主设置面的底层 token，清单行不铺底不描边。
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

/** 清单条目行：与 `CARD` 同族但不铺底、不描边——`CARD` 借给读数失败块与附件回执块（要打断视线），
 *  清单行是"一列可以扫的东西"。悬停底色住在 `ui/layout.css`：inline style 表达不了 `:hover`。 */
export const ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  minWidth: 0,
  padding: '8px 10px',
  borderRadius: 'var(--sd-radius-lg)',
}

/** 选中行：底色用 inline style 故意压在 `layout.css` 的悬停底色之上——元素声明优先于 `:hover`，
 *  选中与悬停同时成立时看到选中那一档。 */
export const ROW_SELECTED: CSSProperties = {
  ...ROW,
  background: 'var(--sd-button-ghost-active-fill)',
}

/** **整页唯一那块实心红**：`variant="primary"` + 在元素上覆盖 primary 那对填充 token（宿主插件管理页的
 *  danger 按钮同写法，asar @21658274，所以 hover 仍走 `.primary:hover`）。
 *  覆盖的是**本插件别名层**（`--sd-*`）：别名在 `body` 上已把 `var(--dsw-…)` 算完，元素上再覆盖
 *  底层私有 token 传不进继承值。 */
export const BULK_DANGER = {
  '--sd-button-primary-fill': 'var(--dsw-alias-state-error-primary)',
  '--sd-button-primary-hover': 'var(--dsw-alias-state-error-primary)',
} as CSSProperties

/** 项目名怎么念：宿主 `projectKey` 把分隔符折成一个 `-`（有损），非分隔符部分可逆（`~XXXX` 码元）。
 *  摘掉 `--…--` 裹边并还原转义；还原走 `src/shared/project-key.ts` 的 `unescapeProjectKey`，无 cwd
 *  也认同一个共享字面量 `NO_CWD_PROJECT_DIR`，不在浏览器半另写一份。 */
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

/** 「未分组」组的键：工作区已删（`workspaceMissing`）的条目归这里；哨兵不与真实 `projectDir` 同形
 *  （空 cwd 念「未记录项目」，两者不能撞键）。 */
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
    // 进循环前整体按时间键倒序、每组只由 push 建出来 ⇒ 每组第一条必在；显式判空而不是非空断言，
    // 真缺了就不产生这一组，不伪造读数。
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

/** 显示名次序前两格（ADR-0058）：`label` 非空优先，否则 `title`；兜底那句归调用方。次序只有这一份。 */
export function preferredNameOf(row: { readonly label?: string; readonly title: string }): string {
  return row.label !== undefined && row.label !== '' ? row.label : row.title
}

/** 归档行显示名：都空回落「未命名 · <短 id>」；清单行、详情标题、删除确认框共用这一条。 */
export function displayNameOf(row: { label?: string; title: string; sessionId: string }, t: Translate): string {
  const name = preferredNameOf(row)
  return name === '' ? t('archive.unnamed', { id: row.sessionId.slice(0, 8) }) : name
}

/** 详情标题排的显示名次序（两档共用）：行 label → 详情 label → 行标题 → 日志标题 → 调用方兜底；
 *  详情 label 补的是没有父行可兜的独立子会话（ADR-0058）。次序只住这里。 */
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
