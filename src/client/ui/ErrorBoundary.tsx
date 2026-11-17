/**
 * 槽位条目的**错误边界**：单个贡献在渲染期抛错时只画一块本地化占位，不把宿主那一格打空，
 * 更不让整棵槽位树跟着白屏。原错与组件栈留给 `console.error`（诊断不吞）。
 *
 * 为什么是 class：React 18 里只有 class 的 `getDerivedStateFromError` / `componentDidCatch`
 * 能接住渲染期异常，函数组件 + hook 没有等价物。
 *
 * 边界只包**渲染期**：事件处理器 / 异步回调里的抛错不经过它，那些地方各自有失败面（`RemoteOutcome`、
 * 行失败原文等）。也**不提供重试按钮**：一条贡献崩了通常是这一代宿主契约变了，原样重渲染只会再崩
 * 一次；刷新页面 / HMR 换代才是恢复路径。文案由注册处按 `t` 给（见 `copy.ts`）。
 */
import { Component, type ComponentType, type ErrorInfo, type ReactElement, type ReactNode } from 'react'
import { ClientSceneProvider, type ClientScene } from '../scene.js'

export interface ErrorBoundaryProps {
  /** 崩溃时上屏的本地化文案（注册处按 `t` 给）。 */
  fallback: string
  children: ReactNode
}

interface ErrorBoundaryState {
  failed: boolean
}

/** 占位块：与详情失败块同一套 token（不新造颜色；不铺满，只占这一格）。 */
const FALLBACK = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '12px 14px',
  background: 'var(--dsw-alias-bg-layer-2)',
  border: '0.5px solid var(--sd-border-l4)',
  borderRadius: 'var(--sd-radius-lg)',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--sd-label-tertiary)',
} as const

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[dsh-session-delete] 客户端条目渲染失败，已隔离：', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div role="alert" data-dsh-session-delete="error-boundary" style={FALLBACK}>
          {this.props.fallback}
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * 把一条槽位贡献包进边界：注册表里登记的组件就是这一层。`displayName` 带上来源，测试与
 * 宿主调试面板都能一眼看出这是被隔离过的那颗。
 */
export function withErrorBoundary<P extends object>(
  Wrapped: ComponentType<P>,
  fallback: string,
  scene?: ClientScene,
): ComponentType<P> {
  const Guarded = (props: P): ReactElement => (
    <ErrorBoundary fallback={fallback}>
      {/* 注册面把同一个场景实例交给每个贡献：跨槽位共享靠实例本身，不靠 React 树。
          生产传实例；测试/旧调用点省略 ⇒ 组件里的 `useClientScene()` 回退默认场景。 */}
      {scene === undefined
        ? <Wrapped {...props} />
        : <ClientSceneProvider scene={scene}><Wrapped {...props} /></ClientSceneProvider>}
    </ErrorBoundary>
  )
  // 先认显式 `displayName`，再认函数/类的名字（宿主调试面板与测试都靠它认出这是哪一颗被隔离过）。
  const named = Wrapped as { displayName?: string; name?: string }
  Guarded.displayName = `withErrorBoundary(${named.displayName ?? named.name ?? 'Component'})`
  return Guarded
}
