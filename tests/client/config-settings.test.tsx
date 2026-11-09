// @vitest-environment jsdom
/**
 * 「可调项」卡：读当前值、回填、本地校验、保存与失败上屏。
 *
 * 这里只钉卡的呈现与动作；`/config` 那条路由的形状、400 / io 的落地归 `tests/api.test.ts`。
 * 保存后 Node 半这一行会重启，浏览器半的卡片不随卸载——所以"保存成功"只断言交出去的值与状态行，
 * 不假装页面完成了一次重新读取。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfigSettings } from '../../src/client/config-settings.js'
import type { RemoteOutcome } from '../../src/client/remote.js'
import { DEFAULT_CONFIG } from '../../src/config.js'
import type { SessionDeleteConfigWire } from '../../src/shared/wire.js'

function deps(over: Partial<{
  config: () => Promise<RemoteOutcome<SessionDeleteConfigWire>>
  saveConfig: (next: SessionDeleteConfigWire) => Promise<RemoteOutcome<SessionDeleteConfigWire>>
}> = {}) {
  return {
    config: vi.fn(async (): Promise<RemoteOutcome<SessionDeleteConfigWire>> => ({ ok: true, value: { ...DEFAULT_CONFIG } })),
    saveConfig: vi.fn(async (next: SessionDeleteConfigWire): Promise<RemoteOutcome<SessionDeleteConfigWire>> =>
      ({ ok: true, value: { ...next } })),
    ...over,
  }
}

function failure(message: string): RemoteOutcome<SessionDeleteConfigWire> {
  return { ok: false, failure: { code: 'client/unknown', message } }
}

describe('可调项卡', () => {
  it('缺 config / saveConfig 时整体缺席（维护卡的测试替身不造假渲染）', () => {
    const { container } = render(<ConfigSettings deps={{}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('读当前值回填；改一个字段后保存，交回整数而不是输入串', async () => {
    const d = deps()
    render(<ConfigSettings deps={d} />)

    const input = await screen.findByLabelText('孤儿附件预览条数')
    expect((input as HTMLInputElement).value).toBe(String(DEFAULT_CONFIG.orphanPreviewLimit))
    const save = screen.getByRole('button', { name: '保存' })
    expect(save).toBeDisabled()

    fireEvent.change(input, { target: { value: '300' } })
    await waitFor(() => { expect(save).toBeEnabled() })
    fireEvent.click(save)

    await waitFor(() => {
      expect(d.saveConfig).toHaveBeenCalledWith({ ...DEFAULT_CONFIG, orphanPreviewLimit: 300 })
    })
    expect(await screen.findByText(/已保存/)).toBeInTheDocument()
  })

  it('保存在飞时再提交一次不会发第二趟（回车与按钮共用这条路）', async () => {
    let release: ((value: SessionDeleteConfigWire) => void) | undefined
    const saveConfig = vi.fn((next: SessionDeleteConfigWire) => new Promise<RemoteOutcome<SessionDeleteConfigWire>>((resolve) => {
      release = () => resolve({ ok: true, value: { ...next } })
    }))
    render(<ConfigSettings deps={{ ...deps(), saveConfig }} />)

    const input = await screen.findByLabelText('孤儿附件预览条数')
    fireEvent.change(input, { target: { value: '300' } })
    const form = screen.getByRole('button', { name: '保存' }).closest('form')
    if (form === null) throw new Error('保存按钮不在表单里')
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(saveConfig).toHaveBeenCalledTimes(1)

    release?.({ ...DEFAULT_CONFIG, orphanPreviewLimit: 300 })
    expect(await screen.findByText(/已保存/)).toBeInTheDocument()
  })

  it('没有改动时表单回交也不写（回车绕得过禁用按钮）', async () => {
    const d = deps()
    render(<ConfigSettings deps={d} />)

    await screen.findByLabelText('孤儿附件预览条数')
    const form = screen.getByRole('button', { name: '保存' }).closest('form')
    if (form === null) throw new Error('保存按钮不在表单里')
    fireEvent.submit(form)
    expect(d.saveConfig).not.toHaveBeenCalled()
  })

  it('越界输入：报在哪一行、保存禁用、不调 saveConfig', async () => {
    const d = deps()
    render(<ConfigSettings deps={d} />)

    const input = await screen.findByLabelText('孤儿附件预览条数')
    fireEvent.change(input, { target: { value: '0' } })

    expect(screen.getByRole('alert')).toHaveTextContent('需为 1–10000 的整数')
    // 错误行在场时状态行不许说"没有改动"——那是另一句互相矛盾的结论。
    expect(screen.queryByText('没有改动')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    expect(d.saveConfig).not.toHaveBeenCalled()
  })

  it('读失败：原文上屏，重试再读一次', async () => {
    const config = vi.fn(async (): Promise<RemoteOutcome<SessionDeleteConfigWire>> => failure('打不通'))
    render(<ConfigSettings deps={{ config, saveConfig: vi.fn() }} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('读取失败：打不通')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(config).toHaveBeenCalledTimes(2) })
  })

  it('保存失败：状态行带出服务端原文', async () => {
    const saveConfig = vi.fn(async (): Promise<RemoteOutcome<SessionDeleteConfigWire>> => failure('被更高层覆盖'))
    render(<ConfigSettings deps={{ ...deps(), saveConfig }} />)

    const input = await screen.findByLabelText('孤儿附件预览条数')
    fireEvent.change(input, { target: { value: '300' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('保存失败：被更高层覆盖')).toBeInTheDocument()
  })
})
