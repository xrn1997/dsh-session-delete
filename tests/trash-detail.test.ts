// 回收站单条详情的策略层（`src/trash/detail.ts`）：块投影、分页游标、工具配对与载荷闸。
//
// 这里的判据都不是口味：注入/推理/工具都要进正文（用户要“全部”），但每块有闸、每页有界；
// 簿记事件不进正文；工具结果按 callId 回填到调用块，跨页也不许把“已完成”误报成“未完成”。
import zlib from 'node:zlib'
import { expect, it, vi } from 'vitest'
import { makeEntryId, type TrashEntry } from '../src/trash/entry.js'
import { createMemoryManifest } from './support/memory-manifest.js'
import {
  PAGE_BLOCK_LIMIT,
  PAGE_CHAR_LIMIT,
  PER_BLOCK_CHAR_CAP,
  readTrashDetail,
  type DetailDeps,
} from '../src/trash/detail.js'
import { trashEntry } from './support/world.js'

const DELETED_AT = Date.UTC(2026, 9, 14, 6, 56, 58)
const id = makeEntryId(DELETED_AT, 'session-x')
const rec = (o: unknown) => JSON.stringify(o)
/** 一帧 = 一次 append（真实日志就是这么长出来的） */
const frame = (...lines: string[]) =>
  zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))

const entry = (): TrashEntry =>
  trashEntry(id, { sessionId: 'session-x', workspaceId: 'ws', wasArchived: true, deletedAt: DELETED_AT, title: '清册标题', sizeBytes: 1234 })

function makeDeps(log: Buffer, over: { exists?: boolean; files?: string[] | null } = {}) {
  const fs = {
    exists: vi.fn(async () => over.exists ?? true),
    listFiles: vi.fn(async () => over.files ?? ['session.v4.jsonl.zstd']),
    readFile: vi.fn(async () => log),
  }
  // 详情认的是路由交来的 **raw 行**（`/detail` 是纯读，不对账）：假件照同一个 seam 造。
  const rows = createMemoryManifest([entry()])
  const deps: DetailDeps = { fs, rows: () => rows.list(), home: '/h' }
  return { deps, fs }
}

/** 带 header 的日志（其余记录追加在后面） */
const body = (...lines: Record<string, unknown>[]) =>
  frame(rec({ type: 'session', version: 4, id: 'session-x', createdAt: 10, cwd: 'C:/develop/x' }), ...lines.map(rec))

const userLine = (time: number, text: string) => ({
  type: 'user/message', time, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const injectionLine = (time: number, kind: string, text: string) => ({
  type: 'user/message', time, data: { source: { kind }, content: [{ type: 'text', text }] },
})
const asstLine = (time: number, content: unknown[], model?: string) => ({
  type: 'assistant/message',
  time,
  data: { message: { ...(model === undefined ? {} : { source: { provider: 'p', model } }), content } },
})
const toolCallLine = (time: number, callId: string, name: string, args: string) => ({
  type: 'tool/call', time, data: { callId, name, arguments: args },
})
const toolResultLine = (time: number, callId: string, text: string, isError = false, extra: unknown[] = []) => ({
  type: 'tool/result',
  time,
  data: { message: { toolCallId: callId, isError, content: [{ type: 'text', text }, ...extra] } },
})
const img = (n: number) => ({
  type: 'image',
  attachment: { attachmentId: `sha256:${n.toString(16).padStart(64, '0')}`, mediaType: 'image/png', bytes: 1 },
})

it('按清册定位目录，读出元信息；正文是按日志顺序排的块（user / assistant / tool）', async () => {
  const log = body(
    { type: 'session/title', time: 11, data: { title: '日志标题' } },
    { type: 'turn/start', time: 12 },
    userLine(13, '先看改动'),
    asstLine(14, [{ type: 'text', text: '改动分四层' }], 'm-1'),
    toolCallLine(15, 'c1', 'read', '{"file_path":"a.ts"}'),
  )
  const { deps, fs } = makeDeps(log)
  const detail = await readTrashDetail(deps)(id)

  expect(fs.readFile).toHaveBeenCalledWith(`/h/session-trash/${id}/session.v4.jsonl.zstd`)
  expect(detail).toMatchObject({
    entryId: id, cwd: 'C:/develop/x', createdAt: 10, lastActivity: 15, logTitle: '日志标题',
    turnCount: 1, userMessageCount: 1, assistantMessageCount: 1, toolCallCount: 1,
    injectedCount: 0, olderCursor: null,
  })
  expect(detail.models).toEqual(['m-1'])
  expect(detail.blocks.map((block) => block.kind)).toEqual(['user', 'assistant', 'tool'])
  expect(detail.blocks[0]).toMatchObject({ kind: 'user', text: '先看改动', truncated: false, attachments: [] })
  expect(detail.blocks[1]).toMatchObject({ kind: 'assistant', text: '改动分四层', truncated: false, attachments: [] })
  expect(detail.blocks[2]).toMatchObject({
    kind: 'tool', callId: 'c1', name: 'read', status: 'unfinished',
    args: '{"file_path":"a.ts"}', argsTruncated: false, result: '', resultTruncated: false,
  })
})

it('宿主注入成为可折叠的 injection 块，sourceKind 原样过线', async () => {
  const log = body(
    userLine(13, '真提问'),
    injectionLine(14, 'agent-instructions', '<system-reminder>…'),
    injectionLine(15, 'runtime-context', 'Current runtime context…'),
    injectionLine(16, 'skill-catalog', 'A skill is…'),
  )
  const detail = await readTrashDetail(makeDeps(log).deps)(id)

  expect(detail.blocks.map((block) => block.kind)).toEqual(['user', 'injection', 'injection', 'injection'])
  expect(detail.blocks[1]).toMatchObject({ kind: 'injection', sourceKind: 'agent-instructions', text: '<system-reminder>…' })
  expect(detail.blocks[2]).toMatchObject({ kind: 'injection', sourceKind: 'runtime-context' })
  expect(detail.blocks[3]).toMatchObject({ kind: 'injection', sourceKind: 'skill-catalog' })
  expect(detail.userMessageCount).toBe(1)
  expect(detail.injectedCount).toBe(3)
})

it('思考成为 reasoning 块；只含 reasoning + tool-call 的助手消息也计数', async () => {
  const log = body(
    asstLine(12, [{ type: 'reasoning', text: '想' }, { type: 'tool-call', name: 'pwsh' }]),
    toolCallLine(13, 'c1', 'pwsh', '{}'),
  )
  const detail = await readTrashDetail(makeDeps(log).deps)(id)

  expect(detail.blocks.map((block) => block.kind)).toEqual(['reasoning', 'tool'])
  expect(detail.blocks[0]).toMatchObject({ kind: 'reasoning', text: '想', truncated: false })
  expect(detail.assistantMessageCount).toBe(1)
  expect(detail.toolCallCount).toBe(1)
})

it('助手 content 按顺序拆块：文字 / 思考 / 文字各成一块，附件跟着它前面那段文字', async () => {
  const imgId = `sha256:${'a'.repeat(64)}`
  const log = body(
    asstLine(12, [
      { type: 'text', text: '前' },
      { type: 'reasoning', text: '想' },
      { type: 'text', text: '后' },
      { type: 'image', attachment: { attachmentId: imgId, mediaType: 'image/png', bytes: 3, width: 10, height: 20, name: 'reply.png' } },
    ]),
  )
  const detail = await readTrashDetail(makeDeps(log).deps)(id)

  expect(detail.blocks.map((block) => block.kind)).toEqual(['assistant', 'reasoning', 'assistant'])
  expect(detail.blocks[0]).toMatchObject({ kind: 'assistant', text: '前', attachments: [] })
  expect(detail.blocks[1]).toMatchObject({ kind: 'reasoning', text: '想' })
  expect(detail.blocks[2]).toMatchObject({
    kind: 'assistant', text: '后',
    attachments: [{ attachmentId: imgId, kind: 'image', mediaType: 'image/png', bytes: 3, width: 10, height: 20, name: 'reply.png' }],
  })
  expect(detail.assistantMessageCount).toBe(1)
})

it('tool/call + tool/result 按 callId 配成一块：成功 / 失败 / 缺结果三态', async () => {
  const log = body(
    toolCallLine(1, 'c1', 'read', '{"path":"a"}'),
    toolResultLine(2, 'c1', '内容'),
    toolCallLine(3, 'c2', 'bash', 'ls'),
    toolCallLine(4, 'c3', 'write', 'x'),
    toolResultLine(5, 'c3', '失败', true),
  )
  const detail = await readTrashDetail(makeDeps(log).deps)(id)

  expect(detail.blocks.map((block) => block.kind)).toEqual(['tool', 'tool', 'tool'])
  expect(detail.blocks[0]).toMatchObject({
    kind: 'tool', callId: 'c1', name: 'read', status: 'ok', args: '{"path":"a"}', result: '内容',
  })
  expect(detail.blocks[1]).toMatchObject({ kind: 'tool', callId: 'c2', status: 'unfinished', result: '' })
  expect(detail.blocks[2]).toMatchObject({ kind: 'tool', callId: 'c3', status: 'error', result: '失败' })
  expect(detail.toolCallCount).toBe(3)
})

it('工具结果里的图片跟工具块一起过线', async () => {
  const imgId = `sha256:${'b'.repeat(64)}`
  const log = body(
    toolCallLine(1, 'c1', 'read_image', '{}'),
    toolResultLine(2, 'c1', '看图', false, [{
      type: 'image', attachment: { attachmentId: imgId, mediaType: 'image/png', bytes: 4, width: 2, height: 3, name: 'shot.png' },
    }]),
  )
  const detail = await readTrashDetail(makeDeps(log).deps)(id)

  expect(detail.blocks[0]).toMatchObject({
    kind: 'tool', status: 'ok',
    attachments: [{ attachmentId: imgId, kind: 'image', mediaType: 'image/png', bytes: 4, width: 2, height: 3, name: 'shot.png' }],
  })
})

it('system/message 与 compaction/summary 各成一块', async () => {
  const log = body(
    { type: 'system/message', time: 1, data: { message: { content: [{ type: 'text', text: '系统' }] } } },
    { type: 'compaction/summary', time: 2, data: { summary: [{ type: 'text', text: '摘要' }] } },
  )
  const detail = await readTrashDetail(makeDeps(log).deps)(id)

  expect(detail.blocks.map((block) => block.kind)).toEqual(['system', 'compaction'])
  expect(detail.blocks[0]).toMatchObject({ kind: 'system', text: '系统' })
  expect(detail.blocks[1]).toMatchObject({ kind: 'compaction', text: '摘要' })
})

it('簿记事件不进正文，但轮数、时间与未知词表照旧', async () => {
  const log = body(
    { type: 'turn/start', time: 1, data: { turn: 1 } },
    { type: 'step/start', time: 2, data: {} },
    { type: 'job/registered', time: 3, data: { jobId: 'j1' } },
    { type: 'request/header', time: 4, data: {} },
    { type: 'permission/preset', time: 5, data: { preset: 'default' } },
    { type: 'sandbox/mode', time: 6, data: { mode: 'workspace-write' } },
    { type: 'approval/policy', time: 7, data: { policy: 'auto' } },
    { type: 'goal/change', time: 8, data: {} },
    { type: 'workspace/changes', time: 9, data: {} },
    { type: 'llm/retry', time: 10, data: {} },
    { type: 'session/end-seed', time: 11, data: {} },
    { type: 'compaction/start', time: 12, data: { compactionId: 'x' } },
    { type: 'compaction/end', time: 13, data: { compactionId: 'x' } },
    { type: 'compaction/prune', time: 14, data: {} },
    userLine(20, '还在读'),
  )
  const detail = await readTrashDetail(makeDeps(log).deps)(id)

  expect(detail.blocks.map((block) => block.kind)).toEqual(['user'])
  expect(detail.blocks[0]).toMatchObject({ kind: 'user', text: '还在读' })
  expect(detail.turnCount).toBe(1)
  expect(detail.lastActivity).toBe(20)
})

it('附件的两道闸：每块 20、每页 200；文本与计数照旧', async () => {
  const msg = (time: number, count: number) => ({
    type: 'user/message', time,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: `第${time}条` }, ...Array.from({ length: count }, (_u, i) => img(time * 100 + i))] },
  })
  const log = body(msg(1, 25), ...Array.from({ length: 11 }, (_u, i) => msg(10 + i, 20)))
  const detail = await readTrashDetail(makeDeps(log).deps)(id)

  expect(detail.blocks[0]!.attachments).toHaveLength(20)
  expect(detail.blocks.reduce((sum, block) => sum + block.attachments.length, 0)).toBe(200)
  expect(detail.blocks).toHaveLength(12)
  expect(detail.userMessageCount).toBe(12)
  expect(detail.blocks.every((block) => block.kind === 'user' && block.text.startsWith('第'))).toBe(true)
})

it('附件总量用尽后，纯附件块被挤成空块 ⇒ 整块不出线（判据与建块同一支；计数照旧算整条日志）', async () => {
  const bulk = Array.from({ length: 10 }, (_unused, i) => ({
    type: 'user/message', time: i + 1,
    data: { source: { kind: 'user' }, content: Array.from({ length: 20 }, (_inner, j) => img((i + 1) * 100 + j)) },
  }))
  const onlyImage = { type: 'user/message', time: 99, data: { source: { kind: 'user' }, content: [img(999)] } }
  const detail = await readTrashDetail(makeDeps(body(...bulk, onlyImage)).deps)(id)

  expect(detail.blocks).toHaveLength(10)
  expect(detail.blocks.every((block) => block.kind === 'tool' || block.text !== '' || block.attachments.length > 0)).toBe(true)
  expect(detail.userMessageCount).toBe(11)
})

it('单块超限：正文、工具参数、工具结果各自截断并标 truncated', async () => {
  const log = body(
    userLine(1, '0123456789'),
    toolCallLine(2, 'c1', 'bash', '0123456789'),
    toolResultLine(3, 'c1', '0123456789'),
  )
  const detail = await readTrashDetail(makeDeps(log).deps, { perBlockChars: 6, pageBlocks: 30 })(id)

  expect(detail.blocks[0]).toMatchObject({ kind: 'user', text: '012345', truncated: true })
  expect(detail.blocks[1]).toMatchObject({
    kind: 'tool', args: '012345', argsTruncated: true, result: '012345', resultTruncated: true,
  })
})

it('单块闸只改正文，不改计数：user / injection / assistant / tool 都照整条日志数', async () => {
  const log = body(
    userLine(1, '0123456789'),
    injectionLine(2, 'runtime-context', '0123456789'),
    asstLine(3, [{ type: 'text', text: '0123456789' }]),
    toolCallLine(4, 'c1', 'bash', '0123456789'),
    toolResultLine(5, 'c1', '0123456789'),
  )
  const detail = await readTrashDetail(makeDeps(log).deps, { perBlockChars: 6, pageBlocks: 30 })(id)

  expect(detail).toMatchObject({
    userMessageCount: 1, injectedCount: 1, assistantMessageCount: 1, toolCallCount: 1,
  })
  expect(detail.blocks.every((block) => (
    block.kind === 'tool'
      ? block.argsTruncated && block.resultTruncated
      : block.truncated
  ))).toBe(true)
})

it('分页：尾部一页 + 更早一页，游标拼接后等于全量', async () => {
  const log = body(...Array.from({ length: 40 }, (_unused, i) => userLine(i, `第${i}条`)))
  const { deps } = makeDeps(log)

  const tail = await readTrashDetail(deps, { perBlockChars: 16_000, pageBlocks: 30 })(id)
  expect(tail.blocks).toHaveLength(30)
  expect(tail.blocks[0]).toMatchObject({ kind: 'user', text: '第10条' })
  expect(tail.blocks[29]).toMatchObject({ kind: 'user', text: '第39条' })
  expect(tail.olderCursor).toBe(10)
  expect(tail.userMessageCount).toBe(40)

  const older = await readTrashDetail(deps, { perBlockChars: 16_000, pageBlocks: 30 })(id, tail.olderCursor!)
  expect(older.blocks).toHaveLength(10)
  expect(older.blocks[0]).toMatchObject({ kind: 'user', text: '第0条' })
  expect(older.blocks[9]).toMatchObject({ kind: 'user', text: '第9条' })
  expect(older.olderCursor).toBeNull()

  expect([...older.blocks, ...tail.blocks].map((block) => block.kind === 'user' ? block.text : '')).toHaveLength(40)
})

it('页级字符闸：尾页只装预算内的后几块，挤出的块在更早页原样取回（不丢、不重）', async () => {
  const text = (i: number) => `${String(i).padStart(3, '0')}${'x'.repeat(97)}`
  const log = body(...Array.from({ length: 6 }, (_unused, i) => userLine(i, text(i))))
  const { deps } = makeDeps(log)
  const limits = { perBlockChars: 16_000, pageBlocks: 30, pageChars: 250 }

  const tail = await readTrashDetail(deps, limits)(id)
  expect(tail.blocks.map((block) => block.kind === 'user' ? block.text.slice(0, 3) : '')).toEqual(['004', '005'])
  expect(tail.olderCursor).toBe(4)

  const older = await readTrashDetail(deps, limits)(id, tail.olderCursor!)
  expect(older.blocks.map((block) => block.kind === 'user' ? block.text.slice(0, 3) : '')).toEqual(['002', '003'])
  expect(older.olderCursor).toBe(2)

  const oldest = await readTrashDetail(deps, limits)(id, older.olderCursor!)
  expect(oldest.blocks.map((block) => block.kind === 'user' ? block.text.slice(0, 3) : '')).toEqual(['000', '001'])
  expect(oldest.olderCursor).toBeNull()
})

it('页级字符闸：单块超预算也保留一块，游标才能继续前进', async () => {
  const log = body(userLine(1, 'x'.repeat(300)))
  const detail = await readTrashDetail(makeDeps(log).deps, {
    perBlockChars: 16_000, pageBlocks: 30, pageChars: 100,
  })(id)

  expect(detail.blocks).toHaveLength(1)
  expect(detail.blocks[0]).toMatchObject({ kind: 'user', text: 'x'.repeat(300), truncated: false })
  expect(detail.olderCursor).toBeNull()
})

it('游标之后回填的工具结果计入页级闸：挤掉页首调用块，但结果仍配在它自己那页', async () => {
  const log = body(
    toolCallLine(1, 'c1', 'read', 'a'.repeat(60)),
    toolCallLine(2, 'c2', 'read', 'b'.repeat(60)),
    toolCallLine(3, 'c3', 'read', 'c'.repeat(60)),
    toolResultLine(4, 'c1', `一${'x'.repeat(59)}`),
    toolResultLine(5, 'c2', `二${'x'.repeat(59)}`),
    toolResultLine(6, 'c3', `三${'x'.repeat(59)}`),
  )
  const { deps } = makeDeps(log)
  const limits = { perBlockChars: 16_000, pageBlocks: 30, pageChars: 250 }

  const tail = await readTrashDetail(deps, limits)(id)
  expect(tail.blocks.map((block) => block.kind === 'tool' ? [block.callId, block.status] : [])).toEqual([
    ['c2', 'ok'], ['c3', 'ok'],
  ])
  expect(tail.olderCursor).toBe(1)

  const older = await readTrashDetail(deps, limits)(id, tail.olderCursor!)
  expect(older.blocks.map((block) => block.kind === 'tool' ? [block.callId, block.status, block.result] : [])).toEqual([
    ['c1', 'ok', `一${'x'.repeat(59)}`],
  ])
  expect(older.olderCursor).toBeNull()
})

it('四个计数都是整条日志的账：更早一页拿到的数与尾页那趟一模一样', async () => {
  const lines: Record<string, unknown>[] = []
  for (let i = 0; i < 20; i += 1) {
    lines.push(userLine(i, `第${i}条`))
    lines.push(injectionLine(i, 'runtime-context', `注入${i}`))
    // 只带 reasoning 的 assistant/message 也占一条计数，尽管它没有正文块。
    lines.push(asstLine(i, [{ type: 'reasoning', text: `想${i}` }]))
    lines.push(toolCallLine(i, `c${i}`, 'read', '{}'))
  }
  const { deps } = makeDeps(body(...lines))
  const limits = { perBlockChars: 16_000, pageBlocks: 30 }

  const tail = await readTrashDetail(deps, limits)(id)
  expect(tail.blocks).toHaveLength(30)
  expect(tail.olderCursor).not.toBeNull()

  const older = await readTrashDetail(deps, limits)(id, tail.olderCursor!)
  const wholeLogCounts = { userMessageCount: 20, assistantMessageCount: 20, toolCallCount: 20, injectedCount: 20 }
  expect(tail).toMatchObject(wholeLogCounts)
  expect(older).toMatchObject(wholeLogCounts)
})

it('分页边界上的工具结果仍回填到更早页：调用在页内、结果在游标之后', async () => {
  const beforeCall = Array.from({ length: 5 }, (_u, i) => userLine(i, `前${i}`))
  const afterCall = Array.from({ length: 35 }, (_u, i) => userLine(10 + i, `后${i}`))
  const log = body(
    ...beforeCall,
    toolCallLine(6, 'c1', 'read', '{"path":"a"}'),
    ...afterCall,
    toolResultLine(99, 'c1', '完成'),
  )
  const { deps } = makeDeps(log)

  const tail = await readTrashDetail(deps, { perBlockChars: 16_000, pageBlocks: 30 })(id)
  expect(tail.olderCursor).toBe(11)
  expect(tail.blocks.some((block) => block.kind === 'tool')).toBe(false)

  const older = await readTrashDetail(deps, { perBlockChars: 16_000, pageBlocks: 30 })(id, tail.olderCursor!)
  const tool = older.blocks.find((block) => block.kind === 'tool')
  expect(tool).toMatchObject({ kind: 'tool', callId: 'c1', status: 'ok', result: '完成' })
})

it('同一 callId 出两块：先出的那块被挤出页，不许把仍在页内的那块误报成未完成', async () => {
  // ADR-0026 决定 3 的不变量：配对认块对象，不认 callId 这一格。
  const log = body(
    toolCallLine(1, 'c1', 'read', '{}'),
    toolCallLine(2, 'c1', 'read', '{}'),
    userLine(3, '垫1'),
    userLine(4, '垫2'),
    userLine(5, '垫3'),
    toolResultLine(6, 'c1', '完成'),
  )
  const detail = await readTrashDetail(makeDeps(log).deps, { perBlockChars: 16_000, pageBlocks: 4 })(id)

  expect(detail.blocks.map((block) => block.kind)).toEqual(['tool', 'user', 'user', 'user'])
  expect(detail.blocks[0]).toMatchObject({ kind: 'tool', callId: 'c1', status: 'ok', result: '完成' })
  expect(detail.toolCallCount).toBe(2)
})

it('同一 callId 的两块各配一条结果：按到达顺序配给先出的调用，两块各留一个读数', async () => {
  const log = body(
    toolCallLine(1, 'c1', 'read', '{"n":1}'),
    toolCallLine(2, 'c1', 'read', '{"n":2}'),
    toolResultLine(3, 'c1', '第一个读数'),
    toolResultLine(4, 'c1', '第二个读数'),
  )
  const detail = await readTrashDetail(makeDeps(log).deps)(id)

  expect(detail.blocks).toHaveLength(2)
  expect(detail.blocks[0]).toMatchObject({ args: '{"n":1}', status: 'ok', result: '第一个读数' })
  expect(detail.blocks[1]).toMatchObject({ args: '{"n":2}', status: 'ok', result: '第二个读数' })
})

it('同 id 的结果多过待配的块：后到的不改写已经配上结果的块', async () => {
  const log = body(
    toolCallLine(1, 'c1', 'read', '{}'),
    toolResultLine(2, 'c1', '读数'),
    toolResultLine(3, 'c1', '又来一条'),
  )
  const detail = await readTrashDetail(makeDeps(log).deps)(id)

  expect(detail.blocks).toHaveLength(1)
  expect(detail.blocks[0]).toMatchObject({ status: 'ok', result: '读数' })
})

it('结果先于调用到达（日志逆序）：这条结果落不了点，块停在未完成', async () => {
  // 落不了点就丢，不为它把游标之后的结果正文留在手里——那会拆掉「只留当前页」的内存界。
  const log = body(
    toolResultLine(1, 'c1', '早到的结果'),
    toolCallLine(2, 'c1', 'read', '{}'),
  )
  const detail = await readTrashDetail(makeDeps(log).deps)(id)

  expect(detail.blocks[0]).toMatchObject({ kind: 'tool', callId: 'c1', status: 'unfinished', result: '' })
  expect(detail.toolCallCount).toBe(1)
})

it('调用块没带 callId：照常入页、念未完成，也不接任何结果', async () => {
  const log = body(
    toolCallLine(1, '', 'read', '{}'),
    toolCallLine(2, 'c2', 'read', '{}'),
    toolResultLine(3, 'c2', '结果'),
    toolResultLine(4, '', '串场'),
  )
  const detail = await readTrashDetail(makeDeps(log).deps)(id)

  expect(detail.blocks[0]).toMatchObject({ kind: 'tool', callId: '', status: 'unfinished', result: '' })
  expect(detail.blocks[1]).toMatchObject({ kind: 'tool', callId: 'c2', status: 'ok', result: '结果' })
  expect(detail.toolCallCount).toBe(2)
})

it('before=0 回空页、olderCursor 为 null（客户端不许再往前翻）', async () => {
  const log = body(userLine(1, '只有一条'))
  const detail = await readTrashDetail(makeDeps(log).deps)(id, 0)
  expect(detail.blocks).toEqual([])
  expect(detail.olderCursor).toBeNull()
})

it('认不出的 type 一律忽略、不报错（日志词汇表随宿主代次只增不减）', async () => {
  const detail = await readTrashDetail(makeDeps(body(
    { type: 'compaction/prune', time: 12, data: {} },
    { type: 'deliverables/presented', time: 13, data: {} },
    { type: 'some/future-event', time: 13.5, data: {} },
    userLine(14, '还在读'),
  )).deps)(id)
  expect(detail.blocks.map((block) => block.kind === 'user' ? block.text : '')).toEqual(['还在读'])
  expect(detail.lastActivity).toBe(14)
})

it('一条正文都没有 ⇒ 正常回空块，不判失败（文件在、大小在，只是没文字）', async () => {
  const detail = await readTrashDetail(makeDeps(body({ type: 'turn/start', time: 12 })).deps)(id)
  expect(detail.blocks).toEqual([])
  expect(detail.olderCursor).toBeNull()
  expect(detail.userMessageCount).toBe(0)
})

it('条目不在清册 ⇒ sessiondelete/trash-empty，且一次文件读都不做', async () => {
  const { deps, fs } = makeDeps(body({ type: 'turn/start', time: 1 }))
  await expect(readTrashDetail(deps)('nope')).rejects.toMatchObject({ code: 'sessiondelete/trash-empty' })
  expect(fs.listFiles).not.toHaveBeenCalled()
  expect(fs.readFile).not.toHaveBeenCalled()
})

// `/detail` 声明为 pure：清册只走 raw 面（读索引、不对账）。这条钉的是 seam 本身——一次详情读只发生
// 一次 `raw()`；`list()`（对账 + 写行）根本不在这条路上，那是 `/list` 与写动词的面。
it('清册只走 raw 面：一次详情读只发生一次 raw()', async () => {
  const raw = vi.fn(async () => [entry()])
  const deps: DetailDeps = {
    fs: {
      exists: vi.fn(async () => true),
      listFiles: vi.fn(async () => ['session.v4.jsonl.zstd']),
      readFile: vi.fn(async () => body({ type: 'turn/start', time: 1 })),
    },
    rows: raw,
    home: '/h',
  }
  await expect(readTrashDetail(deps)(id)).resolves.toMatchObject({ entryId: id })
  expect(raw).toHaveBeenCalledTimes(1)
})

it('目录不在 / 目录里没有会话日志 ⇒ sessiondelete/io 带原文', async () => {
  const gone = makeDeps(body({ type: 'turn/start', time: 1 }), { exists: false })
  await expect(readTrashDetail(gone.deps)(id)).rejects.toMatchObject({ code: 'sessiondelete/io', message: /回收站目录不在/ })
  const empty = makeDeps(body({ type: 'turn/start', time: 1 }), { files: ['notes.txt'] })
  await expect(readTrashDetail(empty.deps)(id)).rejects.toMatchObject({ code: 'sessiondelete/io', message: /没有会话日志/ })
})

it('读盘抛 ⇒ sessiondelete/io，原文留在 message 里', async () => {
  const fs = {
    exists: vi.fn(async () => true),
    listFiles: vi.fn(async () => ['session.v4.jsonl.zstd']),
    readFile: vi.fn(async () => { throw new Error('EACCES: permission denied') }),
  }
  const rows = createMemoryManifest([entry()])
  const deps: DetailDeps = { fs, rows: () => rows.list(), home: '/h' }
  await expect(readTrashDetail(deps)(id)).rejects.toMatchObject({ code: 'sessiondelete/io', message: /EACCES/ })
})

it('日志解不开 ⇒ io 带"第 N 帧"那句原文，绝不回半条正文', async () => {
  const payload = Buffer.from(rec({ type: 'turn/start', time: 1 }) + '\n', 'utf8')
  const blockHeader = (size: number) => {
    const v = 1 | (size << 3) // last=1, type=0 Raw
    return Buffer.from([v & 255, (v >>> 8) & 255, (v >>> 16) & 255])
  }
  const needsDictionary = Buffer.concat([
    // desc=0x01：DID 1 字节（字典 7，本机没有）+ 非单段带 Window + 无 FCS + 不承诺校验和
    // ⇒ 帧边界算得出来，内容必然解不开，正好走"第 N 帧解压失败"那条路
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x01, 0x00, 0x07]),
    blockHeader(payload.length),
    payload,
  ])
  const log = Buffer.concat([frame(rec({ type: 'session', createdAt: 1, cwd: 'C:/x' })), needsDictionary])
  await expect(readTrashDetail(makeDeps(log).deps)(id)).rejects.toMatchObject({
    code: 'sessiondelete/io', message: /第 2 帧解压失败/,
  })
})

it('同一目录两代并存 ⇒ 读的是最新那代（旧代是截了尾巴的快照，字母序会先撞上它）', async () => {
  // 真机形态（2026-10-16 本机 7 个目录）：换代时老代留在原地，新代是老代迁移后的超集。
  // v3 只到 9/23，v4 一直写到 9/30 ⇒ 读到 v3 就等于把后面那几天的对话整段看不见。
  const v3 = body(
    userLine(13, '先看改动'),
    asstLine(14, [{ type: 'text', text: '改动分四层' }]),
  )
  const v4 = body(
    userLine(13, '先看改动'),
    asstLine(14, [{ type: 'text', text: '改动分四层' }]),
    userLine(15, '再来一轮'),
    asstLine(16, [{ type: 'text', text: '第二轮' }]),
  )
  const readFile = vi.fn(async (path: string) => (path.endsWith('session.v3.jsonl.zstd') ? v3 : v4))
  const rows = createMemoryManifest([entry()])
  const deps: DetailDeps = {
    fs: {
      exists: vi.fn(async () => true),
      listFiles: vi.fn(async () => ['session.v3.jsonl.zstd', 'session.v4.jsonl.zstd']),
      readFile,
    },
    rows: () => rows.list(),
    home: '/h',
  }

  const detail = await readTrashDetail(deps)(id)

  expect(readFile).toHaveBeenCalledWith(`/h/session-trash/${id}/session.v4.jsonl.zstd`)
  expect(detail.blocks.map((block) => block.kind === 'user' || block.kind === 'assistant' ? block.text : '')).toEqual([
    '先看改动', '改动分四层', '再来一轮', '第二轮',
  ])
  expect(detail.lastActivity).toBe(16)
})

it('生产的三个闸就是那三位数字（改它必须是有意的，别让它悄悄漂）', () => {
  expect(PER_BLOCK_CHAR_CAP).toBe(16_000)
  expect(PAGE_BLOCK_LIMIT).toBe(30)
  expect(PAGE_CHAR_LIMIT).toBe(500_000)
})
