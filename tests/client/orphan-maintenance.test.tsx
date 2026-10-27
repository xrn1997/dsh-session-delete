// 无主子会话的维护块（`src/client/orphan-maintenance.tsx`）——从面板里整块搬出来、现在由插件设置页
// 维护卡单独使用的那三段界面。
//
// 这一份只钉界面的三条判据与两条写动作的接线，不钉内部结构：
// ① 报告非空才出警告条（空报告与 `null` 都不出——"检查过了，什么都没有"不是要给用户看的东西，
//    而"还没扫到"更不是"零条"）；
// ② 读不到是**可见的失败**（原文 + 重试），"这一组已经不在了"是单独一块中性提示，两者不合并；
// ③ `confirm` 与报告同时在场才开预览框，取消 / 确认各调一个动作。
//
// 组件只吃**本地窄接口** `OrphanMaintenanceQuery`（报告 + 三条提示 + 四个动作），设置页的
// `useMaintenance` 与（历史上的）面板 query 都是它的实现方；这里按那个接口造替身。
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { zhTranslate } from '../../src/client/copy.js'
import {
  OrphanMaintenance,
  type OrphanMaintenanceQuery,
} from '../../src/client/orphan-maintenance.js'
import type { OrphanReportWire } from '../../src/client/remote.js'

/** 与面板测试同一份读数形状：`roots` 是每组"父没了"的 subagent 自己的 id，界面不重算。 */
const EMPTY: OrphanReportWire = { roots: [], totalSessions: 0, totalBytes: 0, missingParents: 0, groups: [] }
const REPORT: OrphanReportWire = {
  roots: ['session-root'], totalSessions: 2, totalBytes: 2048, missingParents: 1,
  groups: [{ projectDir: '--p--', sessions: 2, bytes: 2048 }],
}

type Query = OrphanMaintenanceQuery

/** 假 query：四个读数与四个动作都由用例现给；缺省是"还没扫到、也没有提示"。 */
function queryOf(over: Partial<Query> = {}): Query {
  return {
    orphanReport: null,
    orphanFailure: null,
    orphanNotice: null,
    orphanConfirm: false,
    setOrphanConfirm: vi.fn(),
    openOrphanPreview: vi.fn(),
    cleanOrphans: vi.fn(async () => {}),
    scanOrphans: vi.fn(async () => {}),
    ...over,
  }
}

describe('无主子会话维护块', () => {
  it('报告非空才出警告条；空报告与 null 都不出', () => {
    const openOrphanPreview = vi.fn()
    const view = render(
      <OrphanMaintenance query={queryOf({ orphanReport: REPORT, openOrphanPreview })} busy={false} t={zhTranslate} />,
    )
    expect(screen.getByText('回收站之外发现 2 个无主子会话')).toBeInTheDocument()
    // 官方 `fileSizeText` 的规则是"选中单位小于十带一位小数"⇒ 2048 字节念作 `2.0KB`。
    expect(screen.getByText('共 2.0KB，来自 1 个失踪的父会话')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看并清理' }))
    expect(openOrphanPreview).toHaveBeenCalledTimes(1)

    // 空报告：什么都没有（也不是失败）。
    view.unmount()
    const empty = render(<OrphanMaintenance query={queryOf({ orphanReport: EMPTY })} busy={false} t={zhTranslate} />)
    expect(screen.queryByText(/无主子会话/)).not.toBeInTheDocument()
    expect(screen.queryByText(/残留检查/)).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // `null` = 还没扫到：同样一个字都不出，不许折成"零条"的提示。
    empty.unmount()
    render(<OrphanMaintenance query={queryOf()} busy={false} t={zhTranslate} />)
    expect(screen.queryByText(/无主子会话/)).not.toBeInTheDocument()
    expect(screen.queryByText(/残留检查/)).not.toBeInTheDocument()
  })

  it('失败块摆原文 + 重试调 scanOrphans；中性提示单独一块', () => {
    const scanOrphans = vi.fn(async () => {})
    const notice = '有 1 组已不在了（可能已被别处清理，或父会话已恢复）'
    const view = render(
      <OrphanMaintenance
        query={queryOf({ orphanFailure: '残留检查/清理失败：sessionQuery 不在', orphanNotice: notice, scanOrphans })}
        busy={false}
        t={zhTranslate}
      />,
    )
    // 两条各摆各的：失败不是"没有残留"的另一种写法，提示也不是失败。
    expect(screen.getByText('残留检查/清理失败：sessionQuery 不在')).toBeInTheDocument()
    expect(screen.getByText(notice)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(scanOrphans).toHaveBeenCalledTimes(1)

    // 只有中性提示时：它不摆「重试」，也不冒充失败原文。
    view.unmount()
    render(<OrphanMaintenance query={queryOf({ orphanNotice: notice })} busy={false} t={zhTranslate} />)
    expect(screen.getByText(notice)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    expect(screen.queryByText(/残留检查\/清理失败/)).not.toBeInTheDocument()
  })

  it('confirm 且报告非空才开确认框；取消 / 确认各调对应动作', () => {
    // `confirm` 为真但报告为 `null`：没有可确认的报告 ⇒ 不出框。
    const orphan = render(<OrphanMaintenance query={queryOf({ orphanConfirm: true })} busy={false} t={zhTranslate} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    orphan.unmount()

    // 报告在、`confirm` 还关着：只有警告条，不弹框。
    const reported = render(<OrphanMaintenance query={queryOf({ orphanReport: REPORT })} busy={false} t={zhTranslate} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    reported.unmount()

    const setOrphanConfirm = vi.fn()
    const cleanOrphans = vi.fn(async () => {})
    render(
      <OrphanMaintenance
        query={queryOf({ orphanReport: REPORT, orphanConfirm: true, setOrphanConfirm, cleanOrphans })}
        busy={false}
        t={zhTranslate}
      />,
    )
    expect(screen.getByRole('dialog', { name: '清理 2 个无主子会话？' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(setOrphanConfirm).toHaveBeenCalledWith(false)
    expect(cleanOrphans).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '清理' }))
    expect(cleanOrphans).toHaveBeenCalledTimes(1)
  })

  it('busy 时按钮禁用', () => {
    render(
      <OrphanMaintenance
        query={queryOf({
          orphanReport: REPORT,
          orphanFailure: '残留检查/清理失败：sessionQuery 不在',
          orphanConfirm: true,
        })}
        busy
        t={zhTranslate}
      />,
    )
    expect(screen.getByRole('button', { name: '查看并清理' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '重试' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '清理' })).toBeDisabled()
  })
})
