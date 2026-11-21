/**
 * `plugins.bundle.config` 槽位占用者：上「可调项」、下「维护」（ADR-0043 决定 4），只排两张卡的先后；
 * 呈现与状态机归 `config-settings.tsx` / `maintenance-settings.tsx`。
 */
import type { ReactElement } from 'react'
import { ConfigSettings } from './config-settings.js'
import { zhTranslate, type Translate } from './copy.js'
import { MaintenanceSettings } from './maintenance-settings.js'
import type { ConfigDeps } from './remote.js'
import type { MaintenanceDeps } from './use-maintenance.js'

export interface SettingsCardsProps {
  /** 维护六件 + 可调项两件；只造维护六件的测试替身会让「可调项」卡整体缺席。 */
  deps: MaintenanceDeps & Partial<ConfigDeps>
  t?: Translate
  /** 宿主 `plugins.bundle.config` 的视图：`summary` 是插件行的一行摘要，两张卡都只属于详情页。 */
  view?: 'summary' | 'page'
}

export function SettingsCards({ deps, t = zhTranslate, view }: SettingsCardsProps): ReactElement | null {
  // 摘要位放整页卡片会顶掉插件行、还会把保存/检查按钮带进列表；宿主当前只以 `page` 派发（ADR-0021），守卫是防线。
  if (view === 'summary') return null
  return (
    <>
      <ConfigSettings deps={deps} t={t} />
      <MaintenanceSettings deps={deps} t={t} />
    </>
  )
}
