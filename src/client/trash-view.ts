/**
 * 回收站界面共用的**视图词汇**：卡片配方、危险红、项目名的念法。
 *
 * 它从 `trash-panel.tsx` 拆出来，因为清单面板与两个确认框（`trash-confirm.tsx`）都要用这几样——
 * 拆之前它们同住一个文件、只能靠"同一个文件里的常量"共享。拆之后两处读的是同一份，不是两份抄写。
 *
 * **配色与圆角一律走 token，字号是字面量 px**（宿主同类面也这么写）：卡片用宿主设置面的底层 token
 * （`bg-layer-2` + `border-l4` + `radius-lg`），选中态换宿主"选中"那一档（见 `trash-panel.tsx` 头注）。
 */
import type { CSSProperties } from 'react'
import { unescapeProjectKey } from '../shared/wire.js'
import type { Translate } from './copy.js'
import type { TrashEntryLike } from './remote.js'

/** 卡片配方：宿主设置面的 fill/stroke 底层 token + 官方 `lg` 圆角。 */
export const CARD: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  minWidth: 0,
  padding: '9px 14px',
  background: 'var(--dsw-alias-bg-layer-2)',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 'var(--dsw-radius-lg)',
}

/** 选中行：底色与描边都换成宿主"选中"那一档（`trash-panel.tsx` 头注里有这两枚 token 的实测取值）。 */
export const CARD_SELECTED: CSSProperties = {
  ...CARD,
  background: 'var(--dsw-alias-button-ghost-active-fill)',
  border: '0.5px solid var(--dsw-alias-button-ghost-active-border)',
}

/**
 * **整页唯一那块实心红**的写法：`variant="primary"` + 在元素上覆盖 primary 那对填充 token。
 * 宿主插件管理页的 danger 按钮就是这个写法（asar @21658274），所以 hover 仍走 `.primary:hover` 类。
 */
export const BULK_DANGER = {
  '--dsw-alias-button-primary-fill': 'var(--dsw-alias-state-error-primary)',
  '--dsw-alias-button-primary-hover': 'var(--dsw-alias-state-error-primary)',
} as CSSProperties

/**
 * 项目名怎么念：宿主的 `projectKey` 把 cwd 里的 `/`、`\`、`:` 全折成**一个** `-` ⇒ 分隔符那部分有损、
 * 拆不回真实路径；但**非分隔符那部分可逆**（`~XXXX` 十六进制码元，字面 `~` 编成 `~007E`）。
 * 摘掉 `--…--` 裹边、还原这些转义，剩下的原样摆出来，完整串交给组头 `title`。
 * 字母表只有一份：还原走 `shared/wire.ts`。
 */
export function projectLabel(projectDir: string, t: Translate): string {
  const bare = unescapeProjectKey(projectDir.replace(/^--/, '').replace(/--$/, ''))
  return bare === '' || bare === '_no-cwd' ? t('trash.project.unknown') : bare
}

/** 清单上的一个项目组（组头 + 组内的条目，组内按删除时间倒序）。 */
export interface ProjectGroup {
  projectDir: string
  label: string
  /** 组内最新一条的删除时间——组间排序的键。 */
  latest: number
  entries: readonly TrashEntryLike[]
}

/** 按项目分组：组内按删除时间倒序，组间按各组最新一条倒序（刚删掉的那个项目排在最上面）。 */
export function groupByProject(entries: readonly TrashEntryLike[], t: Translate): ProjectGroup[] {
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
      latest: list[0]!.deletedAt,
      entries: list,
    }))
    .sort((a, b) => b.latest - a.latest)
}