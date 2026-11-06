/**
 * `plugins.bundle.config` 的槽位占用者：上「可调项」、下「维护」（ADR-0043 决定 4）。
 *
 * 本文件只有两件事：按槽位契约守住视图（`summary` 不渲染，理由见 ADR-0021），以及排两张卡的先后。
 * 各自的呈现、状态机与读数仍归 `config-settings.tsx` 与 `maintenance-settings.tsx`。
 */
import type { ReactElement } from 'react'
import { ConfigSettings } from './config-settings.js'
import { zhTranslate, type Translate } from './copy.js'
import { MaintenanceSettings } from './maintenance-settings.js'
import type { ConfigDeps } from './remote.js'
import type { MaintenanceDeps } from './use-maintenance.js'

export interface SettingsCardsProps {
  /** 维护四件 + 可调项两件；只造维护四件的测试替身会让「可调项」卡整体缺席。 */
  deps: MaintenanceDeps & Partial<ConfigDeps>
  /** 文案（缺省 = 内置 zh；宿主 locale 服务缺席时也是它，见 `copy.ts`）。 */
  t?: Translate
  /** 宿主 `plugins.bundle.config` 的视图：`summary` 是插件行的一行摘要，两张卡都只属于详情页。 */
  view?: 'summary' | 'page'
}

export function SettingsCards({ deps, t = zhTranslate, view }: SettingsCardsProps): ReactElement | null {
  // 槽位契约给占用者两个视图：`page` 是插件详情页，`summary` 是插件列表行的一行摘要。
  // 两张卡都是整页卡片，放摘要位会顶掉那一行、还会把保存按钮与两个手动扫描按钮带进列表；所以只认 `page`。
  // 当前宿主只以 `page` 派发这个 key（ADR-0021），这条守卫是对契约的防线，不是死代码。
  if (view === 'summary') return null
  return (
    <>
      <ConfigSettings deps={deps} t={t} />
      <MaintenanceSettings deps={deps} t={t} />
    </>
  )
}
