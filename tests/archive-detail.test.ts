/**
 * 归档详情读路（`POST /archive-detail`）：寻址边界（自己已归档，或已归档根的 subagent
 * 闭包成员）、header 合成（`readSession` 的事件流不含 `session` 头记录）、失败折码
 * （`SESSION_QUERY_SESSION_NOT_FOUND` → `sessiondelete/not-found`，其余 → `io`）与分页沿用。
 *
 * 红线：客户端只传 id，路径形字符串在这里只是"不在归档集/闭包里的一个 id"——它永远到不了文件系统。
 */
import { expect, it } from 'vitest'
import { readArchiveDetail } from '../src/trash/archive-detail.js'
import { createFakeDeps, type FakeDepsOptions } from './support/fake-deps.js'
import type { CorpusLogRead } from '../src/ports/host-port.js'

const userLine = (time: number, text: string) => ({
  type: 'user/message', time, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const asstLine = (time: number, text: string) => ({
  type: 'assistant/message', time, data: { message: { content: [{ type: 'text', text }] } },
})

function world(log: CorpusLogRead | undefined, over: FakeDepsOptions = {}) {
  const made = createFakeDeps({
    archived: true,
    ...(log === undefined ? {} : { logs: { 'session-a': log } }),
    ...over,
  })
  return { made, read: readArchiveDetail(made.deps) }
}

it('header 合成：readSession 的 session 头喂出 cwd/createdAt/parentSession（fork 子会话 label 兜底）', async () => {
  // 事件流里**没有** `session` 记录——项目/创建时间/子会话判定全靠合成那一条。
  const { made, read } = world({
    session: { createdAt: 10, cwd: 'C:/p', parentSession: 'session-p' },
    events: [
      { type: 'session/title', time: 1, data: { title: '自己的标题' } },
      userLine(2, '先看改动'),
    ],
  })
  const wire = await read('session-a')
  expect(wire).toMatchObject({
    sessionId: 'session-a',
    archived: true,
    cwd: 'C:/p',
    createdAt: 10,
    logTitle: '自己的标题',
    // fork 子会话没有 descriptor：自己的日志标题就是显示名（ADR-0058 的兜底链）。
    label: '自己的标题',
  })
  expect(wire.blocks.map((block) => block.kind)).toEqual(['user'])
  // 只读红线（ADR-0061 决定 2）：详情读路不碰生命周期与归档写面。
  expect(made.host.archive).not.toHaveBeenCalled()
  expect(made.host.unarchive).not.toHaveBeenCalled()
  expect(made.host.evictLive).not.toHaveBeenCalled()
  expect(made.host.announceRemoved).not.toHaveBeenCalled()
  expect(made.host.announceRestored).not.toHaveBeenCalled()
})

it('分页游标：before 取更早一页，prompts 只在首次读出现', async () => {
  const log: CorpusLogRead = {
    session: { createdAt: 10, cwd: 'C:/p' },
    events: [userLine(2, '先看改动'), asstLine(3, '改动分四层'), userLine(4, '再看一层')],
  }
  const { read } = world(log)
  const first = await read('session-a')
  expect(first.prompts).toHaveLength(2)
  expect(first.olderCursor).toBeNull()

  const older = await read('session-a', 1)
  expect(older.prompts).toBeUndefined()
  expect(older.blocks).toHaveLength(1)
})

it('不在归档集的 id ⇒ not-found；路径形字符串同理（不进文件系统寻址）', async () => {
  const { read } = world({ session: { createdAt: 10 }, events: [] }, { archived: false })
  await expect(read('session-a')).rejects.toMatchObject({ code: 'sessiondelete/not-found' })
  await expect(read('C:/evil/path/../../etc')).rejects.toMatchObject({ code: 'sessiondelete/not-found' })
})

it('未归档子会话：已归档根的闭包成员 ⇒ 只读放行；闭包外 ⇒ not-found', async () => {
  const made = createFakeDeps({
    archived: (sessionId) => sessionId === 'session-a',
    logs: {
      'session-a': { session: { createdAt: 10 }, events: [] },
      'kid-1': { session: { createdAt: 20, parentSession: 'session-a' }, events: [userLine(21, '孩子正文')] },
      'kid-2': { session: { createdAt: 22, parentSession: 'session-a' }, events: [] },
    },
    members: {
      'session-a': [{ sessionId: 'kid-1', projectDir: '--p--' }],
    },
  })
  const read = readArchiveDetail(made.deps)
  await expect(read('kid-1', undefined, 'session-a')).resolves.toMatchObject({
    sessionId: 'kid-1',
    archived: false,
    blocks: [{ kind: 'user', text: '孩子正文' }],
  })
  await expect(read('kid-2', undefined, 'session-a')).rejects.toMatchObject({ code: 'sessiondelete/not-found' })
  // 根未归档 ⇒ 也不能借它放行。
  await expect(read('kid-1', undefined, 'session-b')).rejects.toMatchObject({ code: 'sessiondelete/not-found' })
  // 路径形 id 在闭包证明里同样没门。
  await expect(read('C:/evil/path/../../etc', undefined, 'session-a')).rejects.toMatchObject({
    code: 'sessiondelete/not-found',
  })
})

it('目标自己已归档时不需要根；根是否归档不影响这一条', async () => {
  const made = createFakeDeps({
    archived: (sessionId) => sessionId === 'kid-1',
    logs: { 'kid-1': { session: { createdAt: 20 }, events: [] } },
  })
  await expect(readArchiveDetail(made.deps)('kid-1', undefined, 'session-unknown')).resolves.toMatchObject({
    sessionId: 'kid-1',
    archived: true,
  })
})

it('仅凭根放行 ⇒ 不装配子会话段（孩子视图单级不画它，不付第二次闭包与行读数）', async () => {
  const made = createFakeDeps({
    archived: (sessionId) => sessionId === 'session-a',
    logs: {
      'session-a': { session: { createdAt: 10 }, events: [] },
      'kid-1': { session: { createdAt: 20, parentSession: 'session-a' }, events: [userLine(21, '孩子正文')] },
    },
    // 孩子自己也有闭包：装配它就得再跑一次 `subagentMembersOf` + 逐孩子行读数——这一趟不该碰。
    members: {
      'session-a': [{ sessionId: 'kid-1', projectDir: '--p--' }],
      'kid-1': [{ sessionId: 'kid-1-kid', projectDir: '--p--' }],
    },
    titles: { 'kid-1-kid': '孙辈' },
  })
  const wire = await readArchiveDetail(made.deps)('kid-1', undefined, 'session-a')
  expect(wire.blocks.map((block) => block.kind)).toEqual(['user'])
  expect(wire.subagents).toBeUndefined()
  expect(wire.subagentsTotal).toBeUndefined()
  expect(wire.subagentsSizeBytes).toBeUndefined()
  // 这一趟只付寻址校验本身那一次闭包 BFS：问的是根，不是目标自己。
  expect(made.host.subagentMembersOf.mock.calls).toEqual([[['session-a']]])
  expect(made.host.titleSnapshots).not.toHaveBeenCalled()
  // 闭包放行只是读路：不 archive / unarchive / 摘活体 / 发收尾事件（ADR-0061 决定 2）。
  expect(made.host.archive).not.toHaveBeenCalled()
  expect(made.host.unarchive).not.toHaveBeenCalled()
  expect(made.host.evictLive).not.toHaveBeenCalled()
  expect(made.host.announceRemoved).not.toHaveBeenCalled()
  expect(made.host.announceRestored).not.toHaveBeenCalled()
})

it('主体自己已归档：子会话段照常装配——根放行不放行都不减它的段', async () => {
  // 同一片世界反着读：目标换成已归档的 `session-a`（带着孩子段），装配与不带根时同形。
  const made = createFakeDeps({
    archived: true,
    logs: { 'session-a': { session: { createdAt: 10 }, events: [] } },
    members: { 'session-a': [{ sessionId: 'kid-1', projectDir: '--p--' }] },
    titles: { 'kid-1': '孩子一' },
  })
  const wire = await readArchiveDetail(made.deps)('session-a', undefined, 'session-a')
  expect(wire.subagents?.map((child) => child.sessionId)).toEqual(['kid-1'])
})

it('孩子归档态读不出 ⇒ 整段不画、正文照旧（不拿「未归档」冒充读不出）', async () => {
  const made = createFakeDeps({
    archived: true,
    logs: { 'session-a': { session: { createdAt: 10 }, events: [userLine(2, '正文')] } },
    members: { 'session-a': [{ sessionId: 'kid-1', projectDir: '--p--' }] },
  })
  // 第一拍（寻址校验：主体自己）照答；第二拍（逐孩子的归档态）读炸——段整块不画。
  made.host.isArchived.mockResolvedValueOnce(true)
  made.host.isArchived.mockRejectedValueOnce(new Error('归档集读炸'))
  const wire = await readArchiveDetail(made.deps)('session-a')
  expect(wire.blocks.map((block) => block.kind)).toEqual(['user'])
  expect(wire.subagents).toBeUndefined()
})

it('闭包读不出 ⇒ io（失败关闭，不把证明不了当成可读）', async () => {
  const made = createFakeDeps({
    archived: (sessionId) => sessionId === 'session-a',
    logs: { 'kid-1': { session: { createdAt: 20 }, events: [] } },
    membersAvailable: false,
  })
  await expect(readArchiveDetail(made.deps)('kid-1', undefined, 'session-a')).rejects.toMatchObject({
    code: 'sessiondelete/io',
  })
})

it('闭包读抛错 ⇒ io（与读不出同一条失败关闭，不折成 not-found）', async () => {
  const made = createFakeDeps({
    archived: (sessionId) => sessionId === 'session-a',
    logs: { 'kid-1': { session: { createdAt: 20 }, events: [] } },
  })
  made.host.subagentMembersOf.mockRejectedValue(new Error('闭包读炸了'))
  await expect(readArchiveDetail(made.deps)('kid-1', undefined, 'session-a')).rejects.toMatchObject({
    code: 'sessiondelete/io',
  })
})

it('readSession 抛 SESSION_QUERY_SESSION_NOT_FOUND ⇒ sessiondelete/not-found（不是 io）', async () => {
  const made = createFakeDeps({ archived: true })
  // 假 host 的缺省：logs 里没有的 id 抛 `SESSION_QUERY_SESSION_NOT_FOUND`（与宿主同码）。
  await expect(readArchiveDetail(made.deps)('session-ghost')).rejects.toMatchObject({
    code: 'sessiondelete/not-found',
  })
})

it('readSession 方法缺席 ⇒ io；日志损坏/持久化失败 ⇒ io', async () => {
  const made = createFakeDeps({ archived: true })
  const read = readArchiveDetail(made.deps)
  made.host.readSession.mockRejectedValue(new Error('session-delete: sessionQuery.readSession 缺席'))
  await expect(read('session-a')).rejects.toMatchObject({ code: 'sessiondelete/io' })
  made.host.readSession.mockRejectedValue(new Error('日志损坏'))
  await expect(read('session-a')).rejects.toMatchObject({ code: 'sessiondelete/io' })
})

it('子会话段：宿主闭包 + 标题/时间/大小/label 投影；时间缺席不造 0', async () => {
  const { read } = world(
    { session: { createdAt: 10 }, events: [] },
    {
      members: {
        'session-a': [
          { sessionId: 'kid-1', projectDir: '--p--' },
          { sessionId: 'kid-2', projectDir: '--p--' },
        ],
      },
      titles: { 'kid-1': '孩子一', 'kid-2': '孩子二' },
      activity: { 'kid-1': 50 },
      sizes: { 'kid-1': 10, 'kid-2': 20 },
      label: '子任务名',
    },
  )
  const wire = await read('session-a')
  expect(wire.subagents).toEqual([
    { sessionId: 'kid-1', archived: true, projectDir: '--p--', title: '孩子一', label: '子任务名', updatedAt: 50, updatedAtSource: 'prompt', sizeBytes: 10 },
    { sessionId: 'kid-2', archived: true, projectDir: '--p--', title: '孩子二', label: '子任务名', sizeBytes: 20 },
  ])
  expect(wire.subagentsSizeBytes).toBe(30)
  expect(wire.subagentsTotal).toBeUndefined()
})

it('子会话段：`archived` 认宿主归档集这条权威判据（id 原样），不拿清单在不在场推', async () => {
  const made = createFakeDeps({
    archived: (sessionId) => sessionId === 'session-a' || sessionId === 'kid-1',
    logs: { 'session-a': { session: { createdAt: 10 }, events: [] } },
    members: {
      'session-a': [
        { sessionId: 'kid-1', projectDir: '--p--' },
        { sessionId: 'kid-2', projectDir: '--p--' },
      ],
    },
    titles: { 'kid-1': '孩子一', 'kid-2': '孩子二' },
  })
  const wire = await readArchiveDetail(made.deps)('session-a')
  expect(wire.subagents?.map((child) => ({ sessionId: child.sessionId, archived: child.archived }))).toEqual([
    { sessionId: 'kid-1', archived: true },
    { sessionId: 'kid-2', archived: false },
  ])
})

it('子会话段：条数闸只列前 N 条并给总数；大小合计仍按全部已知孩子算', async () => {
  const made = createFakeDeps({
    archived: true,
    logs: { 'session-a': { session: { createdAt: 10 }, events: [] } },
    members: {
      'session-a': [
        { sessionId: 'kid-1', projectDir: '--p--' },
        { sessionId: 'kid-2', projectDir: '--p--' },
      ],
    },
    titles: { 'kid-1': '孩子一', 'kid-2': '孩子二' },
    sizes: { 'kid-1': 10, 'kid-2': 20 },
  })
  const wire = await readArchiveDetail(made.deps, { perBlockChars: 10_000, pageBlocks: 50, subagents: 1 })('session-a')
  expect(wire.subagents?.map((child) => child.sessionId)).toEqual(['kid-1'])
  expect(wire.subagentsTotal).toBe(2)
  expect(wire.subagentsSizeBytes).toBe(30)
})

it('子会话段：闭包缺席不拖垮正文；大小读失败逐行缺大小、合计缺席', async () => {
  const absent = world(
    { session: { createdAt: 10 }, events: [] },
    { membersAvailable: false },
  )
  await expect(absent.read('session-a')).resolves.toMatchObject({ sessionId: 'session-a', archived: true })

  const sizeFails = world(
    { session: { createdAt: 10 }, events: [] },
    {
      members: { 'session-a': [{ sessionId: 'kid-1', projectDir: '--p--' }] },
      titles: { 'kid-1': '孩子一' },
    },
  )
  sizeFails.made.host.persistedSizes.mockRejectedValue(new Error('boom'))
  const wire = await sizeFails.read('session-a')
  const child = wire.subagents?.[0]
  expect(child && Object.hasOwn(child, 'sizeBytes')).toBe(false)
  expect(wire.subagentsSizeBytes).toBeUndefined()
})

it('子会话段：只读显示行——250 个孩子只对前 200 个付逐行读与归档态，合计仍覆盖全部', async () => {
  const kidIds = Array.from({ length: 250 }, (_, i) => `session-a-member-${i}`)
  const made = createFakeDeps({
    archived: true,
    logs: { 'session-a': { session: { createdAt: 10 }, events: [] } },
    counts: { 'session-a': 250 },
    titles: Object.fromEntries(kidIds.map((id, i) => [id, `标题-${i}`])),
    activity: { 'session-a-member-0': 50, 'session-a-member-17': 77 },
    sizes: Object.fromEntries(kidIds.map((id, i) => [id, i + 1])),
    label: '子任务名',
  })
  const wire = await readArchiveDetail(made.deps)('session-a')
  // 行 = 显示的那 200 条，逐项照旧口径落格（提问时间有就有、没有不造 0）。
  expect(wire.subagents).toEqual(kidIds.slice(0, 200).map((sessionId, i) => ({
    sessionId,
    archived: true,
    projectDir: '--p--',
    title: `标题-${i}`,
    label: '子任务名',
    ...(i === 0 ? { updatedAt: 50, updatedAtSource: 'prompt' } : {}),
    ...(i === 17 ? { updatedAt: 77, updatedAtSource: 'prompt' } : {}),
    sizeBytes: i + 1,
  })))
  // 截断只报总数；摘要条的大小合计覆盖全部 250 个孩子（1 到 250 求和 = 31375）。
  expect(wire.subagentsTotal).toBe(250)
  expect(wire.subagentsSizeBytes).toBe(31375)
  // 显示外的孩子零逐行读：label / 标题 / 归档态都不读（寻址校验那次 isArchived 是主体自己）。
  expect(made.host.labelOf).toHaveBeenCalledTimes(200)
  expect(made.host.titleOf).not.toHaveBeenCalled()
  expect(made.host.titleSnapshots.mock.calls.map(([ids]) => ids)).toEqual([kidIds.slice(0, 200)])
  expect(made.host.isArchived.mock.calls.map(([id]) => id)).toEqual(['session-a', ...kidIds.slice(0, 200)])
})

it('子会话段：旧宿主标题回退也只读显示行——250 个孩子只问 200，全缺大小时合计格不出线', async () => {
  const kidIds = Array.from({ length: 250 }, (_, i) => `session-a-member-${i}`)
  const made = createFakeDeps({
    archived: true,
    logs: { 'session-a': { session: { createdAt: 10 }, events: [] } },
    counts: { 'session-a': 250 },
  })
  const wire = await readArchiveDetail(made.deps)('session-a')
  expect(made.host.titleOf.mock.calls.map(([id]) => id)).toEqual(kidIds.slice(0, 200))
  expect(wire.subagents?.map((row) => row.title)).toEqual(Array.from({ length: 200 }, () => '会话标题'))
  expect(wire.subagentsTotal).toBe(250)
  // 250 个孩子全缺大小 ⇒ 合计格不出线（不拿 0 冒充没有大小）。
  expect(wire.subagentsSizeBytes).toBeUndefined()
})
