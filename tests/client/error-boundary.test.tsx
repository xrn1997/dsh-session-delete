/**
 * 槽位条目的错误边界（`src/client/ui/ErrorBoundary.tsx`）。
 *
 * 钉三件事：① 渲染期抛错的贡献只画本地化占位、不再往上炸（宿主那一格不被连坐成空白）；
 * ② 原文与组件栈留在 `console.error`（诊断不吞）；③ `withErrorBoundary` 包出来的组件
 * 正常时原样透传、`displayName` 能认出被隔离过的那颗（注册处的自检靠它）。
 */
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary, withErrorBoundary } from '../../src/client/ui/ErrorBoundary.js'

const FALLBACK = '这一块暂时显示不出来（其余部分照常）'

function Bomb(): never {
  throw new Error('组件炸了')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ErrorBoundary', () => {
  it('子组件渲染期抛错：只画本地化占位，不把异常继续抛给宿主', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // 修复前没有边界：React 的默认错误处理会把整棵根卸载（测试里直接抛出）。
    render(
      <ErrorBoundary fallback={FALLBACK}>
        <Bomb />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(FALLBACK)
    expect(error.mock.calls.some((call) => String(call[0]).includes('客户端条目渲染失败'))).toBe(true)
    expect(error.mock.calls.some((call) => call[1] instanceof Error)).toBe(true)
  })

  it('没有崩溃时原样渲染子节点，不插占位', () => {
    render(
      <ErrorBoundary fallback={FALLBACK}>
        <span>正常内容</span>
      </ErrorBoundary>,
    )
    expect(screen.getByText('正常内容')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('withErrorBoundary（注册处的包装）', () => {
  it('包出来的组件带 displayName（优先显式名，其次函数/类名），正常渲染透传 props', () => {
    const Inner = ({ label }: { label: string }) => <span>{label}</span>
    const Guarded = withErrorBoundary(Inner, FALLBACK)
    expect(Guarded.displayName).toBe('withErrorBoundary(Inner)')
    render(<Guarded label="透传的标签" />)
    expect(screen.getByText('透传的标签')).toBeInTheDocument()
  })

  it('包出来的组件崩溃时同样只收起自己那一块', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const Guarded = withErrorBoundary(Bomb as unknown as (props: Record<string, never>) => never, FALLBACK)
    render(<Guarded />)
    expect(screen.getByRole('alert')).toHaveTextContent(FALLBACK)
  })
})