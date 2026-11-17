/**
 * 模块环的**入口序回归**：`delete-confirm → scene → batch-confirm → delete-confirm`。
 *
 * 本文件**故意**先 import `delete-confirm.js`，复现不安全入口序（与 `delete-menu-item.test.tsx` 同序）。
 * 环内模块顶层若读另一环的绑定（例如批删目标卡在顶层展开 `TARGET_CARD`），这里拿到的是未初始化值：
 * 原生 ESM 是 TDZ，Vitest 的 SSR 变换下是 `undefined`——两种都意味着卡片配方静默缺格。
 *
 * 判据：从任一入口进入这张图，批删目标卡都必须带全单删卡的配方。
 */
import { TARGET_CARD } from '../../src/client/delete-confirm.js'
import { BatchConfirmHost, requestDeleteBatch } from '../../src/client/batch-confirm.js'
import { render } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { resetClientState } from '../../src/client/reset-client-state.js'
import { createFakeRemote, remoteOk } from './support/fake-remote.js'
import { countOutcomes } from './support/outcomes.js'

beforeEach(() => {
  resetClientState()
})

it('从 delete-confirm 入口进入模块环：批删目标卡仍带单删卡的完整配方', () => {
  const applyOutcomes = vi.fn(async (_action: string, ids: readonly string[]) => remoteOk(countOutcomes(ids)))
  requestDeleteBatch([{ sessionId: 's1', title: '标题' }])
  render(<BatchConfirmHost deps={createFakeRemote({ applyOutcomes })} />)

  const card = document.querySelector<HTMLElement>('[data-dsh-session-delete="batch-target-card"]')
  expect(card).not.toBeNull()
  expect(card?.style.padding).toBe(TARGET_CARD.padding)
  expect(card?.style.background).toBe(TARGET_CARD.background)
  expect(card?.style.borderRadius).toBe(TARGET_CARD.borderRadius)
  expect(card?.style.maxHeight).toBe('280px')
  expect(card?.style.overflow).toBe('auto')
})
