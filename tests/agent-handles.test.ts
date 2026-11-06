import { describe, expect, it, vi } from 'vitest'
import { captureAgentHandles } from '../src/ports/agent-handles.js'
import { must } from './support/fixture.js'

const HANDLES = Symbol.for('dsh-session-delete.captured-agent-handles')
const WRAPPERS = Symbol.for('dsh-session-delete.captured-agent-wrappers')

function ctxWithEffect(agents: unknown): {
  ctx: { get(name: string): unknown; effect(execute: () => () => unknown, label?: string): unknown }
  disposeAll(): Promise<void>
} {
  const cleanups: (() => unknown)[] = []
  return {
    ctx: {
      get: (name) => (name === 'agents' ? agents : undefined),
      effect: (execute) => { cleanups.push(execute()) },
    },
    async disposeAll() { for (const cleanup of cleanups.reverse()) await cleanup() },
  }
}

describe('captureAgentHandles', () => {
  it('captures resume/create handles by session id and disposes once', async () => {
    const disposed: string[] = []
    const handle = (id: string) => ({ agent: { id }, dispose: async () => { disposed.push(id) } })
    const agents = { resume: async () => handle('s1'), create: async () => handle('s2') }
    const store = captureAgentHandles({ get: (name) => name === 'agents' ? agents : undefined })
    await agents.resume()
    await agents.create()
    await store.dispose('s1')
    await store.dispose('s2')
    await store.dispose('s2')
    expect(disposed).toEqual(['s1', 's2'])
  })

  it('disposes with the handle as receiver（宿主 dispose 可能是类方法，摘下会丢 this）', async () => {
    const disposed: string[] = []
    class HostHandle {
      readonly agent: { id: string }
      constructor(agent: { id: string }) { this.agent = agent }
      async dispose(): Promise<void> { disposed.push(this.agent.id) }
    }
    const agents = {
      resume: async () => new HostHandle({ id: 's1' }),
      create: async () => new HostHandle({ id: 's2' }),
    }
    const store = captureAgentHandles({ get: (name) => name === 'agents' ? agents : undefined })
    await agents.resume()
    await store.dispose('s1')
    expect(disposed).toEqual(['s1'])
  })

  it('installs each wrapper once even when the service proxy returns a new function on read', async () => {
    const writes: string[] = []
    const raw = { resume: async () => ({ agent: { id: 's1' }, dispose: async () => {} }), create: async () => ({ agent: { id: 's2' }, dispose: async () => {} }) }
    const traced = new Proxy(raw, {
      // get 的返回值是 any：先收成 unknown 再按 typeof 分支；apply 处理器显式标参，
      // 不让 `any` 从 `Reflect.get/apply` 渗到 Proxy handler 以外。
      get(target, prop, receiver): unknown {
        const value: unknown = Reflect.get(target, prop, receiver)
        return typeof value === 'function'
          ? new Proxy(value, { apply: (fn, thisArg: unknown, args: unknown[]): unknown => Reflect.apply(fn, thisArg, args) })
          : value
      },
      set(target, prop, value, receiver) {
        writes.push(String(prop))
        return Reflect.set(target, prop, value, receiver)
      },
    })
    const ctx = { get: (name: string) => name === 'agents' ? traced : undefined }
    const first = captureAgentHandles(ctx)
    const second = captureAgentHandles(ctx)
    await traced.resume()
    await first.dispose('s1')
    await second.dispose('s1')
    expect(writes.filter((name) => name === 'resume')).toHaveLength(1)
    expect(writes.filter((name) => name === 'create')).toHaveLength(1)
  })

  // `restoreTo` 的钉：代理读回的 `original` 只是当次新包的影子，恢复写回的必须是目标自有的原函数。
  it('卸载恢复写回目标自有原函数，不把代理读回的函数留在服务上', async () => {
    const raw = {
      resume: async () => ({ agent: { id: 's1' }, dispose: async () => {} }),
      create: async () => ({ agent: { id: 's2' }, dispose: async () => {} }),
    }
    const rawResume = raw.resume
    const rawCreate = raw.create
    const traced = new Proxy(raw, {
      get(target, prop, receiver): unknown {
        const value: unknown = Reflect.get(target, prop, receiver)
        return typeof value === 'function'
          ? new Proxy(value, { apply: (fn, thisArg: unknown, args: unknown[]): unknown => Reflect.apply(fn, thisArg, args) })
          : value
      },
    })
    const cleanups: (() => unknown)[] = []
    captureAgentHandles({
      get: (name) => name === 'agents' ? traced : undefined,
      effect: (execute) => { cleanups.push(execute()) },
    })
    for (const cleanup of cleanups.reverse()) await cleanup()
    expect(Object.getOwnPropertyDescriptor(raw, 'resume')?.value).toBe(rawResume)
    expect(Object.getOwnPropertyDescriptor(raw, 'create')?.value).toBe(rawCreate)
  })

  it('waits for a late agents service via inject', async () => {
    let install: ((child: { get(name: string): unknown }) => void) | undefined
    const disposed: string[] = []
    const handle = { agent: { id: 's1' }, dispose: async () => { disposed.push('s1') } }
    const agents = { resume: async () => handle, create: async () => handle }
    const store = captureAgentHandles({
      get: () => undefined,
      inject: (_names, callback) => { install = callback },
    })
    expect(install).toBeDefined()
    must(install, 'inject 送来的 install 回调')({ get: (name) => name === 'agents' ? agents : undefined })
    await agents.resume()
    await store.dispose('s1')
    expect(disposed).toEqual(['s1'])
  })

  it('disposing an unknown session is a no-op', async () => {
    const store = captureAgentHandles({ get: () => undefined })
    await expect(store.dispose('ghost')).resolves.toBeUndefined()
  })

  it('propagates a dispose failure to the caller but forgets the entry', async () => {
    const failure = new Error('dispose failed')
    const agents = { resume: async () => ({ agent: { id: 's1' }, dispose: async () => { throw failure } }) }
    const store = captureAgentHandles({ get: (name) => name === 'agents' ? agents : undefined })
    await agents.resume()
    await expect(store.dispose('s1')).rejects.toBe(failure)
    await expect(store.dispose('s1')).resolves.toBeUndefined()
  })

  it('卸载时把 resume/create 恢复回原函数并摘掉 symbol 表', async () => {
    const originalResume = async () => ({ agent: { id: 's1' }, dispose: async () => {} })
    const originalCreate = async () => ({ agent: { id: 's2' }, dispose: async () => {} })
    const agents: Record<PropertyKey, unknown> = { resume: originalResume, create: originalCreate }
    const env = ctxWithEffect(agents)
    const store = captureAgentHandles(env.ctx)

    expect(Object.getOwnPropertyDescriptor(agents, 'resume')?.value).not.toBe(originalResume)
    await env.disposeAll()
    expect(Object.getOwnPropertyDescriptor(agents, 'resume')?.value).toBe(originalResume)
    expect(Object.getOwnPropertyDescriptor(agents, 'create')?.value).toBe(originalCreate)
    expect(Reflect.get(agents, HANDLES)).toBeUndefined()
    expect(Reflect.get(agents, WRAPPERS)).toBeUndefined()
    await expect(store.dispose('s1')).resolves.toBeUndefined()
  })

  it('双次安装不双层包装；清理后两条方法都恢复', async () => {
    const calls: string[] = []
    const originalResume = async () => { calls.push('resume'); return { agent: { id: 's1' }, dispose: async () => {} } }
    const agents = { resume: originalResume, create: async () => ({ agent: { id: 's2' }, dispose: async () => {} }) }
    const env = ctxWithEffect(agents)
    captureAgentHandles(env.ctx)
    captureAgentHandles(env.ctx)
    await agents.resume()
    expect(calls).toEqual(['resume'])
    await env.disposeAll()
    expect(Object.getOwnPropertyDescriptor(agents, 'resume')?.value).toBe(originalResume)
  })

  it('晚挂载的 agents 也走同一条清理', async () => {
    let install: ((child: { get(name: string): unknown }) => void) | undefined
    const cleanups: (() => unknown)[] = []
    const ctx = {
      get: () => undefined,
      inject: (_names: readonly string[], callback: (child: { get(name: string): unknown }) => void) => { install = callback },
      effect: (execute: () => () => unknown) => { cleanups.push(execute()) },
    }
    captureAgentHandles(ctx)
    const originalResume = async () => ({ agent: { id: 's1' }, dispose: async () => {} })
    const agents = { resume: originalResume, create: async () => ({ agent: { id: 's2' }, dispose: async () => {} }) }
    install?.({ get: () => agents })
    expect(Object.getOwnPropertyDescriptor(agents, 'resume')?.value).not.toBe(originalResume)
    for (const cleanup of cleanups.reverse()) await cleanup()
    expect(Object.getOwnPropertyDescriptor(agents, 'resume')?.value).toBe(originalResume)
  })

  // `restored` 闸的钉：清理后同一条 inject 回调再送新服务，不许给新服务再包一层。
  it('清理后 inject 再送新服务：旧服务已恢复，新服务不再安装', async () => {
    let install: ((child: { get(name: string): unknown }) => void) | undefined
    const cleanups: (() => unknown)[] = []
    captureAgentHandles({
      get: () => undefined,
      inject: (_names, callback) => { install = callback },
      effect: (execute) => { cleanups.push(execute()) },
    })
    const originalAResume = async () => ({ agent: { id: 's1' }, dispose: async () => {} })
    const originalACreate = async () => ({ agent: { id: 's2' }, dispose: async () => {} })
    const agentsA: Record<PropertyKey, unknown> = { resume: originalAResume, create: originalACreate }
    const notify = must(install, 'inject 送来的 install 回调')
    notify({ get: () => agentsA })
    const originalBResume = async () => ({ agent: { id: 's3' }, dispose: async () => {} })
    const originalBCreate = async () => ({ agent: { id: 's4' }, dispose: async () => {} })
    const agentsB: Record<PropertyKey, unknown> = { resume: originalBResume, create: originalBCreate }
    for (const cleanup of cleanups.reverse()) await cleanup()
    expect(Object.getOwnPropertyDescriptor(agentsA, 'resume')?.value).toBe(originalAResume)
    expect(Object.getOwnPropertyDescriptor(agentsA, 'create')?.value).toBe(originalACreate)
    notify({ get: () => agentsB })
    expect(Object.getOwnPropertyDescriptor(agentsB, 'resume')?.value).toBe(originalBResume)
    expect(Object.getOwnPropertyDescriptor(agentsB, 'create')?.value).toBe(originalBCreate)
  })

  // 恢复不依赖 best-effort 的 symbol 写入：symbol 一个都写不上时，闭包那份记录照样把方法写回。
  it('symbol 写不上时卸载恢复仍按闭包记录写回', async () => {
    const originalResume = async () => ({ agent: { id: 's1' }, dispose: async () => {} })
    const originalCreate = async () => ({ agent: { id: 's2' }, dispose: async () => {} })
    const raw: Record<PropertyKey, unknown> = { resume: originalResume, create: originalCreate }
    const traced = new Proxy(raw, {
      set(target, prop, value, receiver) {
        if (typeof prop === 'symbol') throw new TypeError('symbol 写入被拒')
        return Reflect.set(target, prop, value, receiver)
      },
    })
    const cleanups: (() => unknown)[] = []
    captureAgentHandles({
      get: (name) => name === 'agents' ? traced : undefined,
      effect: (execute) => { cleanups.push(execute()) },
    })
    expect(Reflect.get(raw, WRAPPERS)).toBeUndefined()
    for (const cleanup of cleanups.reverse()) await cleanup()
    expect(Object.getOwnPropertyDescriptor(raw, 'resume')?.value).toBe(originalResume)
    expect(Object.getOwnPropertyDescriptor(raw, 'create')?.value).toBe(originalCreate)
  })

  it('清理后落地的 resume 不再捕获 handle', async () => {
    let resolveResume!: (value: unknown) => void
    const pending = new Promise((resolve) => { resolveResume = resolve })
    const disposeSpy = vi.fn(async () => {})
    const agents = { resume: () => pending, create: async () => ({ agent: { id: 's2' }, dispose: disposeSpy }) }
    const env = ctxWithEffect(agents)
    const store = captureAgentHandles(env.ctx)
    const call = agents.resume()
    await env.disposeAll()
    resolveResume({ agent: { id: 's1' }, dispose: disposeSpy })
    await call
    await store.dispose('s1')
    expect(disposeSpy).not.toHaveBeenCalled()
  })

  // 身份守卫的读数钉：实现只要改成「无条件写回 / 无条件删 symbol」，这条就红。
  it('卸载恢复不覆盖别人后装的 wrapper，也不删别人换过的句柄表', async () => {
    const originalResume = async () => ({ agent: { id: 's1' }, dispose: async () => {} })
    const originalCreate = async () => ({ agent: { id: 's2' }, dispose: async () => {} })
    const agents: Record<PropertyKey, unknown> = { resume: originalResume, create: originalCreate }
    const env = ctxWithEffect(agents)
    captureAgentHandles(env.ctx)

    const foreignResume = async () => ({ agent: { id: 's3' }, dispose: async () => {} })
    const foreignHandles = new Map<string, () => Promise<void>>()
    agents.resume = foreignResume
    agents[HANDLES] = foreignHandles
    await env.disposeAll()

    expect(Object.getOwnPropertyDescriptor(agents, 'resume')?.value).toBe(foreignResume)
    expect(Reflect.get(agents, HANDLES)).toBe(foreignHandles)
    expect(Object.getOwnPropertyDescriptor(agents, 'create')?.value).toBe(originalCreate)
  })

  it('恢复挂在插件 effect 的固定标签上', async () => {
    const labels: string[] = []
    const cleanups: (() => unknown)[] = []
    const agents = {
      resume: async () => ({ agent: { id: 's1' }, dispose: async () => {} }),
      create: async () => ({ agent: { id: 's2' }, dispose: async () => {} }),
    }
    captureAgentHandles({
      get: (name) => (name === 'agents' ? agents : undefined),
      effect: (execute, label) => { labels.push(String(label)); cleanups.push(execute()) },
    })
    expect(labels).toEqual(['session-delete.agent-handles'])
    expect(cleanups).toHaveLength(1)
  })
})
