// @vitest-environment jsdom
/**
 * `plugins.bundle.config` 的占用者（`settings-cards.tsx`）：槽位视图守卫与两张卡的先后。
 *
 * 两张卡各自的呈现与动作归 `config-settings.test.tsx` 与 `maintenance-settings.test.tsx`；这里只钉
 * 占用者那三件事：`summary` 什么都不画、`page` 上「可调项」在「维护」之上、替身只带维护四件时不硬造渲染。
 */
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SettingsCards } from '../../src/client/settings-cards.js'
import type { MaintenanceDeps } from '../../src/client/use-maintenance.js'
import { createFakeRemote, type FakeRemote } from './support/fake-remote.js'

/** 只带维护四件：可调项那两件缺席，占用者不该替它编一次假渲染。 */
function maintenanceOnly(deps: FakeRemote): MaintenanceDeps {
  const { scanOrphans, applyOutcomes, scanAttachmentOrphans, cleanAttachmentOrphans } = deps
  return { scanOrphans, applyOutcomes, scanAttachmentOrphans, cleanAttachmentOrphans }
}

const CARD_NAMES = new Set(['config-card', 'maintenance-card'])

function cardOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-dsh-session-delete]'))
    .map((node) => node.getAttribute('data-dsh-session-delete') ?? '')
    .filter((name) => CARD_NAMES.has(name))
}

describe('设置页占用者 · 槽位视图与两张卡', () => {
  // 槽位契约给占用者两个视图：详情页 `page` 与插件列表行的 `summary`。两张卡都是整页卡片，
  // 只认 `page`；`summary` 必须什么都不画，否则列表行会被整张卡顶掉。
  it('summary 视图不渲染任何东西', () => {
    const { container } = render(<SettingsCards deps={createFakeRemote()} view="summary" />)
    expect(container.firstChild).toBeNull()
  })

  it('page 视图渲染两张卡，「可调项」在「维护」之上；不传 view 的调用方（更早的代次）同样', () => {
    const page = render(<SettingsCards deps={createFakeRemote()} view="page" />)
    expect(cardOrder(page.container)).toEqual(['config-card', 'maintenance-card'])
    page.unmount()

    const plain = render(<SettingsCards deps={createFakeRemote()} />)
    expect(cardOrder(plain.container)).toEqual(['config-card', 'maintenance-card'])
  })

  it('deps 只带维护四件：只剩「维护」卡，不出现一张空的可调项卡', () => {
    const { container } = render(<SettingsCards deps={maintenanceOnly(createFakeRemote())} />)
    expect(cardOrder(container)).toEqual(['maintenance-card'])
  })
})
