import { describe, expect, it } from 'vitest'
import { captureAgentHandles } from '../src/ports/agent-handles.js'

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

  it('installs each wrapper once even when the service proxy returns a new function on read', async () => {
    const writes: string[] = []
    const raw = { resume: async () => ({ agent: { id: 's1' }, dispose: async () => {} }), create: async () => ({ agent: { id: 's2' }, dispose: async () => {} }) }
    const traced = new Proxy(raw, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? new Proxy(value, { apply: (fn, thisArg, args) => Reflect.apply(fn, thisArg, args) }) : value
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
    install!({ get: (name) => name === 'agents' ? agents : undefined })
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
})
