// 回收站单条详情的策略层（设计稿 2026-10-15 §3）
import zlib from 'node:zlib'
import { expect, it, vi } from 'vitest'
import { makeEntryId, type TrashEntry } from '../src/trash/entry.js'
import { createMemoryManifest } from '../src/trash/manifest.js'
import { PER_MESSAGE_CHAR_CAP, TOTAL_CHAR_CAP, readTrashDetail } from '../src/trash/detail.js'

const DELETED_AT = Date.UTC(2026, 9, 14, 6, 56, 58)
const id = makeEntryId(DELETED_AT, 'session-x')
const rec = (o: unknown) => JSON.stringify(o)
/** 一帧 = 一次 append（真实日志就是这么长出来的） */
const frame = (...lines: string[]) =>
  zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))

const entry = (): TrashEntry => ({
  id, sessionId: 'session-x', projectDir: '--p--', workspaceId: 'ws', wasArchived: true,
  deletedAt: DELETED_AT, title: '清册标题', sizeBytes: 1234,
})

function makeDeps(log: Buffer, over: { exists?: boolean; files?: string[] | null } = {}) {
  const fs = {
    exists: vi.fn(async () => over.exists ?? true),
    listFiles: vi.fn(async () => over.files ?? ['session.v4.jsonl.zstd']),
    readFile: vi.fn(async () => log),
  }
  return { deps: { fs, manifest: createMemoryManifest([entry()]), home: '/h' } as never, fs }
}

/** 带 header 的日志（其余记录追加在后面） */
const body = (...lines: Record<string, unknown>[]) =>
  frame(rec({ type: 'session', version: 4, id: 'session-x', createdAt: 10, cwd: 'C:/develop/x' }), ...lines.map(rec))

const userLine = (time: number, text: string) => ({
  type: 'user/message', time, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const asstLine = (time: number, content: unknown[]) => ({
  type: 'assistant/message', time, data: { message: { content } },
})

it('按清册定位目录，一次读出 cwd / 时间 / 标题 / 计数 / 模型', async () => {
  const log = body(
    { type: 'session/title', time: 11, data: { title: '日志标题' } },
    { type: 'turn/start', time: 12 },
    userLine(13, '先看改动'),
    { type: 'assistant/message', time: 14, data: { message: { source: { provider: 'p', model: 'm-1' }, content: [{ type: 'text', text: '改动分四层' }] } } },
    { type: 'tool/call', time: 15 },
  )
  const { deps, fs } = makeDeps(log)
  const detail = await readTrashDetail(deps)(id)
  expect(fs.readFile).toHaveBeenCalledWith(`/h/session-trash/${id}/session.v4.jsonl.zstd`)
  expect(detail).toMatchObject({
    entryId: id, cwd: 'C:/develop/x', createdAt: 10, lastActivity: 15, logTitle: '日志标题',
    turnCount: 1, toolCallCount: 1, injectedCount: 0, omittedByPayloadCap: 0,
  })
  expect(detail.models).toEqual(['m-1'])
  expect(detail.messages).toEqual([
    { role: 'user', time: 13, text: '先看改动', truncated: false },
    { role: 'assistant', time: 14, text: '改动分四层', truncated: false },
  ])
})

it('宿主注入的 user/message 不进正文，只进 injectedCount', async () => {
  const log = body(
    userLine(13, '真提问'),
    { type: 'user/message', time: 14, data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: '<system-reminder>…' }] } },
    { type: 'user/message', time: 15, data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context…' }] } },
    { type: 'user/message', time: 16, data: { source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'A skill is…' }] } },
  )
  const detail = await readTrashDetail(makeDeps(log).deps)(id)
  expect(detail.messages.map((m) => m.text)).toEqual(['真提问'])
  expect(detail.userMessageCount).toBe(1)
  expect(detail.injectedCount).toBe(3)
})

it('推理段与工具调用不进正文（少掉的条数由 `assistantMessageCount` 与 `toolCallCount` 说得清）', async () => {
  const log = body(
    asstLine(12, [{ type: 'reasoning', text: '想' }, { type: 'tool-call', name: 'pwsh' }]),
    { type: 'tool/call', time: 13 },
  )
  const detail = await readTrashDetail(makeDeps(log).deps)(id)
  expect(detail.messages).toEqual([])
  expect(detail.assistantMessageCount).toBe(0)
  expect(detail.toolCallCount).toBe(1)
})

it('认不出的 type 一律忽略、不报错（日志词汇表随宿主代次只增不减）', async () => {
  const detail = await readTrashDetail(makeDeps(body(
    { type: 'compaction/prune', time: 12, data: {} },
    { type: 'deliverables/presented', time: 13, data: {} },
    userLine(14, '还在读'),
  )).deps)(id)
  expect(detail.messages.map((m) => m.text)).toEqual(['还在读'])
  expect(detail.lastActivity).toBe(14)
})

it('一条正文都没有 ⇒ 正常回空 messages，不判失败（文件在、大小在，只是没文字）', async () => {
  const detail = await readTrashDetail(makeDeps(body({ type: 'turn/start', time: 12 })).deps)(id)
  expect(detail.messages).toEqual([])
  expect(detail.userMessageCount).toBe(0)
})

it('条目不在清册 ⇒ sessiondelete/trash-empty，且一次文件读都不做', async () => {
  const { deps, fs } = makeDeps(body({ type: 'turn/start', time: 1 }))
  await expect(readTrashDetail(deps)('nope')).rejects.toMatchObject({ code: 'sessiondelete/trash-empty' })
  expect(fs.listFiles).not.toHaveBeenCalled()
  expect(fs.readFile).not.toHaveBeenCalled()
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
  const deps = { fs, manifest: createMemoryManifest([entry()]), home: '/h' } as never
  await expect(readTrashDetail(deps)(id)).rejects.toMatchObject({ code: 'sessiondelete/io', message: /EACCES/ })
})

it('日志解不开 ⇒ io 带"第 N 帧"那句原文，绝不回半条正文', async () => {
  const payload = Buffer.from(rec({ type: 'turn/start', time: 1 }) + '\n', 'utf8')
  const blockHeader = (size: number) => {
    const v = 1 | (size << 3) // last=1, type=0 Raw
    return Buffer.from([v & 255, (v >>> 8) & 255, (v >>> 16) & 255])
  }
  const needsDictionary = Buffer.concat([
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x44, 0x07, payload.length & 255]),
    blockHeader(payload.length),
    payload,
  ])
  const log = Buffer.concat([frame(rec({ type: 'session', createdAt: 1, cwd: 'C:/x' })), needsDictionary])
  await expect(readTrashDetail(makeDeps(log).deps)(id)).rejects.toMatchObject({
    code: 'sessiondelete/io', message: /第 2 帧解压失败/,
  })
})

it('生产的两个闸就是设计稿里那两位数字（改它必须是有意的，别让它悄悄漂）', () => {
  expect(PER_MESSAGE_CHAR_CAP).toBe(3000)
  expect(TOTAL_CHAR_CAP).toBe(500_000)
})

it('单条超上限就截断并标 truncated；累计超上限就停，余下的记进 omitted', async () => {
  // 闸值这里给小的：验的是**策略**（截断、停止、计数），与帧形态和量级无关；
  // 真值（3000 / 50 万）由上一条用例钉住，本机量级见设计稿 §1（最大那条 ≈ 27 万字符，触发不了）
  const many = Array.from({ length: 12 }, (_unused, i) => asstLine(i, [{ type: 'text', text: `回复${i}——内容略长` }]))
  const { deps } = makeDeps(body(...many))
  const detail = await readTrashDetail(deps, { perMessageChars: 6, totalChars: 20 })(id)

  expect(detail.messages.map((m) => m.text)).toEqual(['回复0——内', '回复1——内', '回复2——内'])
  expect(detail.messages[0]!.truncated).toBe(true)
  expect(detail.omittedByPayloadCap).toBe(12 - detail.messages.length)
  // 计数说的是"有多少条回复"，正文说的是"显示了几个字"——两件事分开，不互相冒充
  expect(detail.assistantMessageCount).toBe(12)
})
