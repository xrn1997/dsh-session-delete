// 回收站单条详情的策略层（`src/trash/detail.ts` 的三条硬口径，逐条钉在这里）
import zlib from 'node:zlib'
import { expect, it, vi } from 'vitest'
import { makeEntryId, type TrashEntry } from '../src/trash/entry.js'
import { createMemoryManifest } from '../src/trash/manifest.js'
import { PER_MESSAGE_CHAR_CAP, TOTAL_CHAR_CAP, readTrashDetail, type DetailDeps } from '../src/trash/detail.js'
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
    { role: 'user', time: 13, text: '先看改动', truncated: false, attachments: [] },
    { role: 'assistant', time: 14, text: '改动分四层', truncated: false, attachments: [] },
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

it('纯图片消息不被空文本过滤；附件元信息过线、文本仍原话', async () => {
  const imgId = `sha256:${'a'.repeat(64)}`
  const log = body({
    type: 'user/message', time: 20,
    data: {
      source: { kind: 'user' },
      content: [
        { type: 'image', attachment: { attachmentId: imgId, mediaType: 'image/png', bytes: 3, width: 10, height: 20, name: 'shot.png' } },
      ],
    },
  })
  const detail = await readTrashDetail(makeDeps(log).deps)(id)
  expect(detail.userMessageCount).toBe(1)
  expect(detail.messages).toEqual([{
    role: 'user', time: 20, text: '', truncated: false,
    attachments: [{ attachmentId: imgId, kind: 'image', mediaType: 'image/png', bytes: 3, width: 10, height: 20, name: 'shot.png' }],
  }])
})

it('畸形 attachmentId 与 file 块：file 保留、畸形跳过', async () => {
  const good = `sha256:${'b'.repeat(64)}`
  const log = body({
    type: 'user/message', time: 21,
    data: {
      source: { kind: 'user' },
      content: [
        { type: 'text', text: '文件' },
        { type: 'file', attachment: { attachmentId: good, name: 'a.pdf', bytes: 9 } },
        { type: 'image', attachment: { attachmentId: '../../x' } },
      ],
    },
  })
  const detail = await readTrashDetail(makeDeps(log).deps)(id)
  expect(detail.messages[0]?.attachments).toEqual([
    { attachmentId: good, kind: 'file', name: 'a.pdf', bytes: 9 },
  ])
})

it('助手消息同样收附件：计数、角色、元信息一起过线', async () => {
  const imgId = `sha256:${'c'.repeat(64)}`
  const log = body({
    type: 'assistant/message', time: 22,
    data: {
      message: {
        content: [
          { type: 'image', attachment: { attachmentId: imgId, mediaType: 'image/png', bytes: 5, width: 30, height: 40, name: 'reply.png' } },
        ],
      },
    },
  })
  const detail = await readTrashDetail(makeDeps(log).deps)(id)
  expect(detail.assistantMessageCount).toBe(1)
  expect(detail.messages).toHaveLength(1)
  expect(detail.messages[0]!.role).toBe('assistant')
  expect(detail.messages[0]!.attachments).toEqual([
    { attachmentId: imgId, kind: 'image', mediaType: 'image/png', bytes: 5, width: 30, height: 40, name: 'reply.png' },
  ])
})

it('注入消息的附件也不进正文：source.kind 过滤在附件提取之前，只涨 injectedCount', async () => {
  // 顺序判据：若先提附件再判 source，这张图就会借"附件非空"绕过过滤混进 messages。
  const imgId = `sha256:${'d'.repeat(64)}`
  const log = body({
    type: 'user/message', time: 23,
    data: {
      source: { kind: 'runtime-context' },
      content: [
        { type: 'text', text: '<system-reminder>…' },
        { type: 'image', attachment: { attachmentId: imgId, mediaType: 'image/png', bytes: 2, width: 1, height: 1 } },
      ],
    },
  })
  const detail = await readTrashDetail(makeDeps(log).deps)(id)
  expect(detail.messages).toEqual([])
  expect(detail.userMessageCount).toBe(0)
  expect(detail.injectedCount).toBe(1)
})

it('附件的两道闸：每条 20、总量 200，多出的静默跳过；文本与计数照旧', async () => {
  const img = (n: number) => ({ type: 'image', attachment: { attachmentId: `sha256:${n.toString(16).padStart(64, '0')}`, mediaType: 'image/png', bytes: 1 } })
  const msg = (time: number, count: number) => ({
    type: 'user/message', time,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: `第${time}条` }, ...Array.from({ length: count }, (_u, i) => img(time * 100 + i))] },
  })
  const log = body(msg(1, 25), ...Array.from({ length: 11 }, (_u, i) => msg(10 + i, 20)))
  const detail = await readTrashDetail(makeDeps(log).deps)(id)

  expect(detail.messages[0]!.attachments).toHaveLength(20)
  expect(detail.messages.reduce((sum, m) => sum + m.attachments.length, 0)).toBe(200)
  expect(detail.messages).toHaveLength(12)
  expect(detail.userMessageCount).toBe(12)
  expect(detail.messages.every((m) => m.truncated === false && m.text.startsWith('第'))).toBe(true)
  // 附件被截是静默的：`omittedByPayloadCap` 只说"整条正文没进来"，不兼报附件少了几张。
  expect(detail.omittedByPayloadCap).toBe(0)
})

it('附件总量用尽后，纯附件消息仍收进正文：形态是空文本 + 空附件（渲染侧须容忍）', async () => {
  // 10 条 × 20 张 = 总量 200 刚好吃满；第 11 条只剩附件、没有文字。
  const img = (n: number) => ({ type: 'image', attachment: { attachmentId: `sha256:${n.toString(16).padStart(64, '0')}`, mediaType: 'image/png', bytes: 1 } })
  const bulk = Array.from({ length: 10 }, (_unused, i) => ({
    type: 'user/message', time: i + 1,
    data: { source: { kind: 'user' }, content: Array.from({ length: 20 }, (_inner, j) => img((i + 1) * 100 + j)) },
  }))
  const onlyImage = { type: 'user/message', time: 99, data: { source: { kind: 'user' }, content: [img(999)] } }
  const detail = await readTrashDetail(makeDeps(body(...bulk, onlyImage)).deps)(id)

  expect(detail.messages).toHaveLength(11)
  // 过滤判"空文本**且**无附件"，发生在附件闸之前 ⇒ 这条仍是一条消息，只是附件被 room=0 削空。
  expect(detail.messages[10]).toEqual({ role: 'user', time: 99, text: '', truncated: false, attachments: [] })
  expect(detail.userMessageCount).toBe(11)
  expect(detail.omittedByPayloadCap).toBe(0)
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
  expect(detail.messages.map((m) => m.text)).toEqual(['先看改动', '改动分四层', '再来一轮', '第二轮'])
  expect(detail.lastActivity).toBe(16)
})

it('生产的两个闸就是那两位数字（改它必须是有意的，别让它悄悄漂）', () => {
  expect(PER_MESSAGE_CHAR_CAP).toBe(3000)
  expect(TOTAL_CHAR_CAP).toBe(500_000)
})

it('单条超上限就截断并标 truncated；累计超上限就停，余下的记进 omitted', async () => {
  // 闸值这里给小的：验的是**策略**（截断、停止、计数），与帧形态和量级无关；
  // 真值（3000 / 50 万）由上一条用例钉住，本机量级见 src/trash/detail.ts 的载荷闸注释
  const many = Array.from({ length: 12 }, (_unused, i) => asstLine(i, [{ type: 'text', text: `回复${i}——内容略长` }]))
  const { deps } = makeDeps(body(...many))
  const detail = await readTrashDetail(deps, { perMessageChars: 6, totalChars: 20 })(id)

  expect(detail.messages.map((m) => m.text)).toEqual(['回复0——内', '回复1——内', '回复2——内'])
  expect(detail.messages[0]!.truncated).toBe(true)
  expect(detail.omittedByPayloadCap).toBe(12 - detail.messages.length)
  // 计数说的是"有多少条回复"，正文说的是"显示了几个字"——两件事分开，不互相冒充
  expect(detail.assistantMessageCount).toBe(12)
})
