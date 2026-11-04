// Node 半路由层（`/api/dsh-session-delete-api`）——exact Fetch 适配器的那一半
//
// 分发器是**纯构造器**（`createDispatcher(deps)`），传输适配器只有 `registerConnectionRoutes` 一个。
// 这里用**真 `node:http` server + 一条极薄的测试桥**承载：`node:http` 的 req/res 语义不替身，
// 请求仍被装成 `Request` 交给注册的 exact Fetch 路由，响应原样写回。
//
// 钉住的是**契约**，不是实现细节：
//  ① 九个段名各自的方法 + 形状（GET list、GET ping、POST detail、POST apply＝一组 id 一个动作、
//    POST empty＝清空、GET orphans＝无主子会话扫描、GET attachment＝附件原始字节、
//    GET attachment-orphans＝孤儿附件报告、POST attachment-clean＝孤儿附件清理）；
//  ② 信封就是浏览器半消费的那个形状
//  （`{ok:true,value}` / `{ok:false,error:{code,message,details?}}`）；③ 码只从那五个里出、且失败的
//  **原文**进 `error.message`；④ 请求体不对回 400 + 信封；路径 / 方法不匹配由宿主 exact route
//  在 handler 之前回 404（测试桥按同一口径转发），插件分发器里的 405 / 404 只是适配器直调时的防御。
//  鉴权不在这一层：宿主 `/api` bridge 在 exact route 之前完成 Host/Origin/浏览器认证（ADR-0033）。
import http from 'node:http'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDispatcher } from '../src/api/dispatch.js'
import {
  registerConnectionRoutes,
  type ConnectionFetchRouteLike,
  type ConnectionFetchServiceLike,
} from '../src/api/connection-route.js'
import { DEFAULT_CONFIG, type SessionDeleteConfig } from '../src/config.js'
import { OFFICIAL_SESSION_DELETE_API_PREFIX, PARAMS, ROUTES, type ApplyOutcome } from '../src/shared/wire.js'
import { makeEntryId, sessionDirOf, trashDirOf, type TrashEntry } from '../src/trash/entry.js'
import { attachmentPathOf } from '../src/trash/attachments.js'
import type { DeleteDeps } from '../src/deps.js'
import { AttachmentsUnavailableError, type AttachmentsPort, type ImageAttachmentRefLike } from '../src/ports/attachments-port.js'
import { restoreSession } from '../src/verbs/restore-session.js'
import { createFakeDeps } from './support/fake-deps.js'
import { pick } from './support/fixture.js'
import { trashEntry } from './support/world.js'

const HOME = '/h'
const NOW = Date.UTC(2026, 8, 30, 13, 5, 0)

/** 条目 id 一律由 `makeEntryId` 产出（`恢复` 动词按 id 反推原目录名）⇒ 夹具照真实形状造，
 *  不拿 `'a'` 这种手写串冒充。 */
const entryIdOf = (sessionDirName: string) => makeEntryId(NOW, sessionDirName)
const entry = (sessionDirName: string, over: Partial<TrashEntry> = {}): TrashEntry =>
  trashEntry(entryIdOf(sessionDirName), { sessionId: sessionDirName, ...over })

/**
 * 九个段名的假依赖：动词要什么给什么——**真动词 + 真清册 seam**，只有宿主与文件系统是替身
 * （`tests/support/fake-deps.ts` 里那第二个 adapter）。
 * 替身暴露出来是为了让每条用例只翻自己那一格，而不必重建整副依赖，也不必强转到 `DeleteDeps`。
 *
 * `listDirs` 不在这里声明：假件的缺省让回收站目录从**初值**清册行集派生（不再是实时 `rowIds`），
 * 于是删除那次 `rename` 真把目录搬进回收站、恢复那次 `rename` 真把它搬走——"写后世界自洽"由**写操作**
 * 保证，而不是"写了行目录自动出现"；对账住在 `ledger.list()` 里——"清单有行而回收站根下空空"会被它当场摘空
 * （真实里行与目录成对出现，那是不一致的世界）。要测漂移的用例自己翻 `listDirs` / `readFile`。
 */
function makeDeps(over: {
  seed?: TrashEntry[]
  live?: boolean
  subagents?: Record<string, number>
  members?: Record<string, Array<{ sessionId: string; projectDir: string }>>
  workspaceExists?: boolean
  /** 按**完整路径**给盘上目录的实测字节；给了就以此为唯一来源（没列到的目录是 0），
   *  不再用缺省的 224 KiB——"清册记的"与"盘上实测的"要在同一个世界里对得出来。 */
  sizes?: Record<string, number>
  /** 宿主 `attachments` 读面；缺省不可用，附件段走直接 fs fallback。 */
  attachments?: AttachmentsPort
  /** 归一后的可调项；缺省是 `DEFAULT_CONFIG`。 */
  config?: SessionDeleteConfig
} = {}) {
  const seed = over.seed ?? []
  const made = createFakeDeps({
    seed,
    now: NOW,
    config: over.config,
    live: over.live ?? false,
    // 计数与"盘上后代"两个口共用 `members`：给了 `subagents` 就按它构造等长成员，否则按成员数推（与宿主同口径）。
    counts: over.subagents,
    members: over.members ?? {},
    workspaceExists: over.workspaceExists ?? true,
    attachments: over.attachments,
    fs: {
      exists: true,
      size: 224 * 1024,
      // 回收站详情要在条目目录里挑日志；`*.jsonl.zstd` 是 `pickSessionLog` 认得出的一代。
      files: ['session.v4.jsonl.zstd'],
      // `listDirs` 不在这里声明：假件默认让回收站目录从初值行集派生，此后被 `rename`/`removeDir` 改变
      // （真实里行与目录成对出现）。要测漂移的用例自己翻 `listDirs` / `readFile`。
      readFile: () =>
        zlib.zstdCompressSync(Buffer.from(
          `${JSON.stringify({ type: 'session', version: 4, id: 'session-a', createdAt: 1, cwd: 'C:/p' })}\n`,
          'utf8',
        )),
    },
  })
  // 显式给了尺寸表就整条换掉：没列到的目录量到 0，而不是缺省的 224 KiB——
  // 需要区分"清册记的 sizeBytes"与"盘上实测"的用例，这两半边必须各说各的数。
  if (over.sizes !== undefined) {
    const sizes = over.sizes
    made.fs.sizeOfDir.mockImplementation(async (path: string) => sizes[path] ?? 0)
  }
  return { deps: made.deps, fs: made.fs, host: made.host, manifest: made.manifest }
}

const servers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as () => Promise<void>)()
})
/**
 * 测试桥：把注册的 exact Fetch 路由接到真 `node:http` server 上，保持用例的 HTTP 形状不变。
 * **按宿主 `createSharedFetchHandler` 的口径**：路径与方法都命中才进 handler，否则 404 纯文本。
 * 插件分发器里的 405 / 未知路由 404 只是适配器直调时的防御分支，在 `tests/connection-route.test.ts` 钉。
 */
async function start(deps: DeleteDeps): Promise<string> {
  const routes = new Map<string, ConnectionFetchRouteLike>()
  const service: ConnectionFetchServiceLike = {
    fetch: {
      register: (route) => {
        routes.set(route.path, route)
        return async () => { routes.delete(route.path) }
      },
    },
  }
  registerConnectionRoutes(service, createDispatcher(deps))
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const route = routes.get(url.pathname)
      const method = req.method ?? 'GET'
      if (route === undefined || !route.methods.some((declared) => declared === method)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const headers = Object.fromEntries(
        Object.entries(req.headers).filter(([, value]) => typeof value === 'string') as [string, string][],
      )
      const response = await route.fetch(new Request(url, {
        method: req.method ?? 'GET',
        headers,
        ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
      }))
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
      res.end(Buffer.from(await response.arrayBuffer()))
    })().catch(() => { /* 路由内部已写错误响应，测试桥只兜底 */ })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(() => new Promise((resolve) => server.close(() => resolve())))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}${OFFICIAL_SESSION_DELETE_API_PREFIX}`
}

interface CallInit { method?: string; body?: unknown; headers?: Record<string, string> }

/** 一次调用 → 解析出的信封（HTTP 状态一并带出，因为路由层自检要看它）。 */
async function call(base: string, path: string, init: CallInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = init.body === undefined ? undefined : JSON.stringify(init.body)
  // 发出去的请求里 `body` 与 `headers` 都是载荷：**「键缺席」与「键是 undefined」不是一件事**
  // （前者才是 GET 的常态），所以不往这两格写 undefined，缺省就不建键。
  const headers = payload === undefined ? init.headers : { 'content-type': 'application/json', ...init.headers }
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    ...(headers === undefined ? {} : { headers }),
    ...(payload === undefined ? {} : { body: payload }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** 原始响应（附件段回二进制，不能用 `call` 的 `res.json()`）。 */
async function callRaw(base: string, path: string): Promise<Response> {
  return fetch(`${base}${path}`)
}

/** 失败的形状（src/shared/wire.ts 的五个码）：`{ok:false, error:{code, message}}`。 */
async function failureOf(base: string, path: string, init: CallInit = {}): Promise<{ status: number; code: string; message: string }> {
  const { status, body } = await call(base, path, init)
  expect(body.ok).toBe(false)
  const error = body.error as { code: string; message: string }
  expect(error.code.startsWith('sessiondelete/')).toBe(true)
  expect(['live', 'not-found', 'trash-empty', 'project-missing', 'io'])
    .toContain(error.code.slice('sessiondelete/'.length))
  return { status, code: error.code, message: error.message }
}

/** `/apply` 的**单条**失败：顶层信封照回 `ok:true`（一次调用办成了），逐条的 `ok:false` 里才是码与原文。
 *  这里把"只有一条且它失败"这一形状钉死，取回那一条的失败面。 */
async function failureOfOutcome(
  base: string, path: string, init: CallInit = {},
): Promise<{ code: string; message: string }> {
  const { body } = await call(base, path, init)
  expect(body.ok).toBe(true)
  const outcomes = body.value as Array<{ ok: boolean; error?: { code: string; message: string } }>
  expect(outcomes).toHaveLength(1)
  expect(pick(outcomes, 0).ok).toBe(false)
  const error = pick(outcomes, 0).error as { code: string; message: string }
  expect(error.code.startsWith('sessiondelete/')).toBe(true)
  return { code: error.code, message: error.message }
}

describe('路由层 · 段名契约（/apply 一段管所有动作，2026-10-17）', () => {
  it('GET /list 回信封 {ok:true,value}，值就是清单（最近删除在前）', async () => {
    const { deps } = makeDeps({ seed: [entry('a', { deletedAt: 100 }), entry('b', { deletedAt: 200 })] })
    const base = await start(deps)
    const { status, body } = await call(base, ROUTES.list.path)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect((body.value as TrashEntry[]).map((e) => e.id)).toEqual([entryIdOf('b'), entryIdOf('a')])
  })

  // 清单**只列父行**：孩子折进父那一行（宿主的客户端本来就藏孩子，回收站里也不单独列——单独列会冒出
  // 一堆点不到的行）。折进去的同时要报出个数与字节，页脚合计才算得上它们。
  // 另一个数 `strandedSubagents` 来自宿主：这条父会话**在盘上还留着几个没被带走的孩子**——
  // 级联落地之前删掉的那些存量才非零。两个数分开给，不许用一个冒充另一个。
  // 这些派生读数都**不落清册**：落进去就是"一个会变的数住在一份该如实的记录里"（`reconcile.ts` 五条口径第③条）。
  it('GET /list 只列父行，孩子折进父行并报出个数与字节', async () => {
    const parent = entry('session-parent')
    const kids = [
      entry('session-kidA', { parentEntryId: parent.id, sizeBytes: 700 }),
      entry('session-kidB', { parentEntryId: parent.id, sizeBytes: 300 }),
    ]
    const { deps, host } = makeDeps({
      seed: [parent, ...kids],
      // 孩子清册里记的是 700 / 300，盘上实测是 500 / 300：读数必须念实测的那一组。
      sizes: {
        [trashDirOf(parent.id, HOME)]: 4096,
        [trashDirOf(pick(kids, 0).id, HOME)]: 500,
        [trashDirOf(pick(kids, 1).id, HOME)]: 300,
        [sessionDirOf('--p--', 'session-grandkidA', HOME)]: 200,
        [sessionDirOf('--p--', 'session-grandkidB', HOME)]: 100,
      },
      members: {
        'session-parent': [
          { sessionId: 'session-kidA', projectDir: '--p--' },
          { sessionId: 'session-kidB', projectDir: '--p--' },
          // 两个盘上孙代不在清册里：它们才是「盘上还剩」的那一份；折进来的两个孩子在清册里，
          // 不能既算 `subagentBytes` 又算 `strandedBytes`（否则 releaseBytes 会多报一份）。
          { sessionId: 'session-grandkidA', projectDir: '--p--' },
          { sessionId: 'session-grandkidB', projectDir: '--p--' },
        ],
      },
    })
    const base = await start(deps)
    const { body } = await call(base, ROUTES.list.path)
    const rows = body.value as Array<TrashEntry & { subagentCount?: number; subagentBytes?: number; strandedSubagents?: number; strandedBytes?: number; releaseBytes?: number }>
    expect(rows.map(r => r.sessionId)).toEqual(['session-parent'])
    expect(rows[0]).toMatchObject({
      // 孩子折进父行：条数是 kids 的长度，字节是孩子**回收站目录**的实测值（500 + 300），不是清册的 700 + 300。
      subagentCount: 2, subagentBytes: 800,
      strandedSubagents: 2, strandedBytes: 300,
      // 计划量的是盘上目录：本行 4096 + 孩子 800 + 盘上孙代 300；清册里已有的孩子不重复算。
      releaseBytes: 4096 + 800 + 300,
    })
    expect(host.subagentMembersOf).toHaveBeenCalledTimes(1)
  })

  // 释放量的唯一口径是盘上实测（与 purge 同一条），不是清册里删除那一刻记的 sizeBytes。
  it('/list 的 releaseBytes 读盘上实测目录，不是清册里记的 sizeBytes', async () => {
    const parent = entry('session-parent', { sizeBytes: 111 })
    const kid = entry('session-kidA', { parentEntryId: parent.id, sizeBytes: 222 })
    const { deps } = makeDeps({
      seed: [parent, kid],
      sizes: {
        [trashDirOf(parent.id, HOME)]: 4096,
        [trashDirOf(kid.id, HOME)]: 512,
      },
    })
    const base = await start(deps)
    const rows = (await call(base, ROUTES.list.path)).body.value as Array<TrashEntry & { subagentBytes?: number; releaseBytes: number }>
    expect(rows[0]).toMatchObject({
      sizeBytes: 111, // 清册那一格原样发（它记的是删除那一刻）
      subagentBytes: 512,
      releaseBytes: 4096 + 512,
    })
  })

  // 「这一行会释放多少」与「彻底删除它实际释放了多少」必须是同一个数：量的是同一批目录。
  it('同一行 /list.releaseBytes 等于对它 purge 的 freedBytes（同一 fake fs 世界）', async () => {
    const parent = entry('session-parent')
    const kid = entry('session-kidA', { parentEntryId: parent.id })
    const { deps } = makeDeps({
      seed: [parent, kid],
      sizes: {
        [trashDirOf(parent.id, HOME)]: 4096,
        [trashDirOf(kid.id, HOME)]: 512,
        [sessionDirOf('--p--', 'session-x', HOME)]: 128,
      },
      members: { 'session-parent': [{ sessionId: 'session-x', projectDir: '--p--' }] },
    })
    const base = await start(deps)
    const rows = (await call(base, ROUTES.list.path)).body.value as Array<{ releaseBytes: number }>
    expect(rows).toHaveLength(1)
    const { body } = await call(base, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'purge', [PARAMS.ids]: [parent.id] },
    })
    const outcome = pick(body.value as Array<{ ok: true; value: { removed: number; freedBytes: number } }>, 0)
    // 删掉的三份目录：父 + 孩子 + 盘上后代；释放量与清单那一行同一个数。附件读数单独一格（这个世界没有图片）。
    expect(outcome.value).toEqual({
      removed: 3,
      freedBytes: pick(rows, 0).releaseBytes,
      attachments: { removed: 0, freedBytes: 0, failed: 0 },
    })
  })

  // 页脚合计（可见行之和）与「清空」的回执也必须对得上：两处量的同一组目录。
  it('全部可见行 releaseBytes 之和 = /empty 的 freedBytes（同一世界）', async () => {
    const p1 = entry('session-p1')
    const k1 = entry('session-k1', { parentEntryId: p1.id })
    const p2 = entry('session-p2')
    const { deps } = makeDeps({
      seed: [p1, k1, p2],
      sizes: {
        [trashDirOf(p1.id, HOME)]: 1000,
        [trashDirOf(k1.id, HOME)]: 200,
        [trashDirOf(p2.id, HOME)]: 3000,
        [sessionDirOf('--p--', 'session-x1', HOME)]: 40,
        [sessionDirOf('--p--', 'session-x2', HOME)]: 60,
      },
      members: {
        [p1.sessionId]: [{ sessionId: 'session-x1', projectDir: '--p--' }],
        [p2.sessionId]: [{ sessionId: 'session-x2', projectDir: '--p--' }],
      },
    })
    const base = await start(deps)
    const rows = (await call(base, ROUTES.list.path)).body.value as Array<{ releaseBytes: number }>
    const listedTotal = rows.reduce((total, row) => total + row.releaseBytes, 0)
    const { body } = await call(base, ROUTES.empty.path, { method: 'POST', body: {} })
    // 三份回收站目录 + 两个盘上后代；合计字节与可见行之和同一个数。
    expect(body).toMatchObject({ ok: true, value: { removed: 5, freedBytes: listedTotal } })
  })

  // 清单是纯读：活体准入只属于写动词，`/list` 一次都不问。
  it('/list 不判活体（isLive 零调用）', async () => {
    const parent = entry('session-parent')
    const { deps, host } = makeDeps({
      seed: [parent],
      members: { 'session-parent': [{ sessionId: 'session-x', projectDir: '--p--' }] },
    })
    const base = await start(deps)
    await call(base, ROUTES.list.path)
    expect(host.isLive).not.toHaveBeenCalled()
  })

  it('盘上没有剩 ⇒ 不出现 strandedSubagents（界面上那半句也不该有）', async () => {
    const parent = entry('session-parent')
    const kid = entry('session-kidA', { parentEntryId: parent.id, sizeBytes: 700 })
    const { deps } = makeDeps({ seed: [parent, kid], subagents: {} })
    const base = await start(deps)
    const { body } = await call(base, ROUTES.list.path)
    const rows = body.value as Array<TrashEntry & { subagentCount?: number; strandedSubagents?: number }>
    expect(rows[0]).toMatchObject({ subagentCount: 1 })
    expect(pick(rows, 0).strandedSubagents).toBeUndefined()
  })

  it('宿主记录还在、目录已经不在 ⇒ 不算盘上残留（count 与 bytes 同一条存在性判据）', async () => {
    const parent = entry('session-parent')
    const { deps, fs, host } = makeDeps({
      seed: [parent],
      members: { 'session-parent': [{ sessionId: 'session-kid', projectDir: '--p--' }] },
    })
    fs.exists.mockImplementation(async (...args: unknown[]) => !String(args[0]).endsWith('session-kid'))
    const base = await start(deps)
    const { body } = await call(base, ROUTES.list.path)
    const rows = body.value as Array<TrashEntry & { strandedSubagents?: number; strandedBytes?: number }>
    expect(host.subagentMembersOf).toHaveBeenCalled()
    expect(pick(rows, 0).strandedSubagents).toBeUndefined()
    expect(pick(rows, 0).strandedBytes).toBeUndefined()
  })

  // ADR-0027 决定 2 / 后果（原 ADR-0006 第六处行为差异）：`releaseBytes` 改念盘上实测之后，
  // 某条可见行的目录读不了（非 ENOENT）会让整个清单读失败——迁移前这一格只念清册、不碰盘，
  // 那些世界照样列得出清单。回执形状钉在信封上。
  it('/list 某条行目录读不了（EACCES）⇒ 200 + io，不拿 0 冒充「它会释放多少」', async () => {
    const row = entry('a')
    const { deps, fs } = makeDeps({ seed: [row] })
    const dir = trashDirOf(row.id, HOME)
    fs.sizeOfDir.mockImplementation(async (path: string) => {
      if (path === dir) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      return 0
    })
    const base = await start(deps)
    const failure = await failureOf(base, ROUTES.list.path)
    expect(failure.status).toBe(200)
    expect(failure.code).toBe('sessiondelete/io')
    expect(failure.message).toContain('EACCES')
  })

  it('普通行（没孩子）只多一格 `releaseBytes`（盘上实测），三个可选读数都不出现', async () => {
    const { deps } = makeDeps({
      seed: [entry('a')],
      sizes: { [trashDirOf(entryIdOf('a'), HOME)]: 4096 },
    })
    const base = await start(deps)
    const { body } = await call(base, ROUTES.list.path)
    const rows = body.value as TrashEntry[]
    // `releaseBytes` 是存储侧必填的那一格：没孩子没后代 ⇒ 就是这条回收站目录的实测字节（清册的 sizeBytes 是 0）。
    expect(JSON.parse(JSON.stringify(rows[0]))).toEqual({ ...JSON.parse(JSON.stringify(entry('a'))), releaseBytes: 4096 })
  })

  // 宿主的「删除工作区」只删注册、保留日志 ⇒ 回收站里可能躺着"工作区已经没了"的条目。
  // 恢复这半已经改成按「未分组」收（见 `restore-session.test.ts`），清单这半要在**点之前**说出这件事。
  // 与另外三个只读数同一条规矩：只在真缺时出现，工作区还在时不给这个字段（不拿 false 冒充"判过了"）。
  it('原工作区已不在账本 ⇒ 行上带 workspaceMissing；工作区还在时这个字段不出现', async () => {
    const gone = makeDeps({ seed: [entry('a')], workspaceExists: false })
    const goneBase = await start(gone.deps)
    const goneRows = (await call(goneBase, ROUTES.list.path)).body.value as Array<TrashEntry & { workspaceMissing?: boolean }>
    expect(goneRows[0]).toMatchObject({ workspaceMissing: true })
    expect(gone.host.workspaceExists).toHaveBeenCalledWith('ws-1')

    const alive = makeDeps({ seed: [entry('a')] })
    const aliveBase = await start(alive.deps)
    const aliveRows = (await call(aliveBase, ROUTES.list.path)).body.value as Array<TrashEntry & { workspaceMissing?: boolean }>
    expect(pick(aliveRows, 0).workspaceMissing).toBeUndefined()
  })

  it('未分组条目（workspaceId 空串）不去问账本，也不带 workspaceMissing', async () => {
    const { deps, host } = makeDeps({ seed: [entry('a', { workspaceId: '' })] })
    const base = await start(deps)
    const rows = (await call(base, ROUTES.list.path)).body.value as Array<TrashEntry & { workspaceMissing?: boolean }>
    expect(host.workspaceExists).not.toHaveBeenCalled()
    expect(pick(rows, 0).workspaceMissing).toBeUndefined()
  })

  // 孩子折进父行是"父行在"的前提下才成立。父行不见了（手工摘的、清册半损的、对账把它当外人摘掉的），
  // 孩子**必须自己站出来占一行**——否则那一条既看不见也清不掉，正是我们一直在躲的"点不到的行"。
  it('父行不在 ⇒ 孩子自己占一行，不许隐形', async () => {
    const orphan = entry('session-kidA', { parentEntryId: '20260930T130500Z-session-nope' })
    const { deps } = makeDeps({ seed: [orphan] })
    const base = await start(deps)
    const { body } = await call(base, ROUTES.list.path)
    const rows = body.value as TrashEntry[]
    expect(rows.map(r => r.sessionId)).toEqual(['session-kidA'])
  })

  // 「露出来」与「折进去」必须是**同一条**判据算出来的两半（issue #4）。两条判据不同源时的世界：
  // 一条孩子行既自己占一行、又被折进另一条的 `subagentBytes` ⇒ 页脚合计把它的字节数两遍。
  it('父行自己也是孩子 ⇒ 孩子不许既折进它、又自己占一行', async () => {
    const mid = entry('session-mid', { parentEntryId: '20260930T130500Z-session-nope', sizeBytes: 100, deletedAt: 200 })
    const leaf = entry('session-leaf', { parentEntryId: mid.id, sizeBytes: 200, deletedAt: 100 })
    const { deps } = makeDeps({ seed: [mid, leaf] })
    const base = await start(deps)
    const { body } = await call(base, ROUTES.list.path)
    const rows = body.value as Array<TrashEntry & { subagentCount?: number; subagentBytes?: number }>
    // 两条都得看得见（谁都不许隐形），且谁都没把对方折进自己那一格
    expect(rows.map(r => r.sessionId)).toEqual(['session-mid', 'session-leaf'])
    expect(rows.map(r => [r.subagentCount, r.subagentBytes])).toEqual([[undefined, undefined], [undefined, undefined]])
  })

  it('子会话那三个字段不落清册（读一次之后，清册里那几行一个字段都没多）', async () => {
    const parent = entry('session-parent')
    const kid = entry('session-kidA', { parentEntryId: parent.id })
    const seed = [parent, kid]
    const { deps, manifest } = makeDeps({ seed, subagents: { 'session-parent': 5 } })
    const base = await start(deps)
    await call(base, ROUTES.list.path)
    const stored = await manifest.list()
    expect(stored).toEqual(seed)
    expect(JSON.stringify(stored)).not.toContain('subagentCount')
  })

  // 删除确认框要说「含 N 个子会话，将一起移入回收站」（issue #3）⇒ 那个数必须在**删除之前**问得到。
  // 2026-10-17 批量重构后它挂在 `/apply` 的 `count` 上（一条一段退役了），纯读豁免跟着一起搬。
  it('apply count 交回这条会话在盘上的后代数（确认框删除前取一次数）', async () => {
    const { deps, host } = makeDeps({ subagents: { 'session-parent': 3 } })
    const base = await start(deps)
    const { status, body } = await call(base, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'count', [PARAMS.ids]: ['session-parent'] },
    })
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: [{ id: 'session-parent', action: 'count', ok: true, value: 3 }] })
    expect(host.subagentMembersOf).toHaveBeenCalledWith(['session-parent'])
  })

  // 没挂 `sessionQuery`（或这条确实没后代）⇒ 0。0 不是"不知道"，界面上那一栏在 n===0 时整句不出现，
  // 所以这个数不会被读成"有一个数说没有孩子"。
  it('apply count 拿不到数 ⇒ 0（界面上那一栏在 n===0 时整句不出现，所以 0 不会被读成"有一个数说没孩子"）', async () => {
    const { deps } = makeDeps({ subagents: {} })
    const base = await start(deps)
    const { body } = await call(base, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'count', [PARAMS.ids]: ['session-none'] },
    })
    expect(body).toEqual({ ok: true, value: [{ id: 'session-none', action: 'count', ok: true, value: 0 }] })
  })

  it('apply delete 拿一组 sessionId 走删除动词，回移入回收站的那一条', async () => {
    const { deps, manifest, host } = makeDeps()
    const base = await start(deps)
    const { status, body } = await call(base, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'delete', [PARAMS.ids]: ['session-abc'] },
    })
    expect(status).toBe(200)
    expect((body.value as Array<Record<string, unknown>>)[0]).toMatchObject({
      ok: true, value: { sessionId: 'session-abc', title: '会话标题', sizeBytes: 224 * 1024 },
    })
    // 清单真的多了一行（路由不是把动词的返回值转发一下了事），且账本/归档都动到了
    expect((await manifest.list()).map((e) => e.sessionId)).toEqual(['session-abc'])
    expect(host.detach).toHaveBeenCalledWith('session-abc', 'ws-1')
  })

  it('apply restore 拿一组 entryId 走恢复动词，成功即从清单消失', async () => {
    const { deps, manifest } = makeDeps({ seed: [entry('a')] })
    const base = await start(deps)
    const { status, body } = await call(base, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'restore', [PARAMS.ids]: [entryIdOf('a')] },
    })
    expect(status).toBe(200)
    expect((body.value as Array<Record<string, unknown>>)[0]).toMatchObject({ ok: true, value: { id: entryIdOf('a') } })
    expect(await manifest.list()).toEqual([])
  })

  it('apply purge 一组 id 单条；/empty 清空（回执 {removed,freedBytes}）', async () => {
    // `entry('a')` 的 id 就是 `entryIdOf('a')`（夹具第一参是**原目录名**，不是整串 id）
    const two = () => [entry('a'), entry('b')]
    const one = makeDeps({ seed: two() })
    const oneBase = await start(one.deps)
    const single = await call(oneBase, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'purge', [PARAMS.ids]: [entryIdOf('a')] },
    })
    expect((single.body.value as Array<Record<string, unknown>>)[0]).toMatchObject({ ok: true, value: { removed: 1, freedBytes: 224 * 1024 } })
    expect((await one.manifest.list()).map((e) => e.id)).toEqual([entryIdOf('b')])

    const all = makeDeps({ seed: two() })
    const allBase = await start(all.deps)
    const cleared = await call(allBase, ROUTES.empty.path, { method: 'POST', body: {} })
    expect(cleared.body).toMatchObject({ ok: true, value: { removed: 2, freedBytes: 448 * 1024 } })
    expect(await all.manifest.list()).toEqual([])
  })

  it('/empty 对空回收站是幂等的：回 {removed:0,freedBytes:0}', async () => {
    const empty = makeDeps()
    const base = await start(empty.deps)
    const cleared = await call(base, ROUTES.empty.path, { method: 'POST', body: {} })
    expect(cleared.status).toBe(200)
    expect(cleared.body).toMatchObject({ ok: true, value: { removed: 0, freedBytes: 0 } })
  })
})

// `tests/support/fake-deps.ts` 的 raw 清册与 `fs` 的路径树世界由**写操作**缝在一起：
// 删除的 `rename` 真把目录搬进回收站、下一次 `/list` 的对账看得见它（否则刚删的会话会被自己的对账
// 当幽灵行摘掉）；恢复的 `rename` 真把目录搬走、清册行跟着摘。假件那处缝一旦拆开，别的用例会拿到
// 一个"写完之后世界不自洽"的假世界。
describe('路由层 · 写后世界仍自洽（假件的 raw 清册与回收站目录由写操作缝合）', () => {
  it('delete 之后 /list 仍含新行；restore 之后 /list 不再含它', async () => {
    const { deps } = makeDeps()
    const base = await start(deps)

    const deleted = await call(base, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'delete', [PARAMS.ids]: ['session-live'] },
    })
    const outcome = pick(deleted.body.value as Array<{ ok: boolean; value: { id: string } }>, 0)
    expect(outcome.ok).toBe(true)

    const listed = (await call(base, ROUTES.list.path)).body.value as TrashEntry[]
    expect(listed.map((row) => row.sessionId)).toEqual(['session-live'])

    await call(base, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'restore', [PARAMS.ids]: [outcome.value.id] },
    })
    expect((await call(base, ROUTES.list.path)).body.value).toEqual([])
  })
})

describe('路由层 · list 是对账 + 读（2026-10-16）', () => {
  it('目录多出一条 ⇒ 长出行（id 与项目目录从那条日志的 header 重建）', async () => {
    const ghost = entryIdOf('session-ghost')
    const { deps, fs } = makeDeps({ seed: [entry('a')] })
    fs.listDirs.mockResolvedValue([entryIdOf('a'), ghost])
    fs.readFile.mockImplementation(async () =>
      zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', version: 4, id: 'session-ghost', createdAt: 1, cwd: 'C:/develop/p' })}\n`, 'utf8')))
    const base = await start(deps)
    const { body } = await call(base, ROUTES.list.path)
    expect(body.ok).toBe(true)
    const rows = body.value as TrashEntry[]
    expect(rows.map((e) => e.id)).toContain(ghost)
    expect(rows.find((e) => e.id === ghost)).toMatchObject({
      sessionId: 'session-ghost', projectDir: '--C-develop-p--', workspaceId: '', wasArchived: false, title: '',
    })
  })

  it('目录没了的行 ⇒ 当场摘掉（不用重启宿主）', async () => {
    const { deps, manifest, fs } = makeDeps({ seed: [entry('a')] })
    fs.listDirs.mockResolvedValue([])
    const base = await start(deps)
    const { body } = await call(base, ROUTES.list.path)
    expect(body).toMatchObject({ ok: true, value: [] })
    expect(await manifest.list()).toEqual([])
  })

  it('零漂移时不读日志（对账的读放大只发生在真漂移上）', async () => {
    const { deps, fs } = makeDeps({ seed: [entry('a')] })
    const base = await start(deps)
    const { body } = await call(base, ROUTES.list.path)
    expect((body.value as TrashEntry[]).map((e) => e.id)).toEqual([entryIdOf('a')])
    expect(fs.readFile).not.toHaveBeenCalled()
  })
})

// ADR-0012：restore 的组来自 `ledger.list()`（对账 + 读），不是 raw 索引。手工搬进 `session-trash/`
// 的目录此刻还没有清册行；若 restore 读 raw，这条会被判 `trash-empty` 而不是恢复。
describe('路由层 · apply restore 走真相读（ADR-0012）', () => {
  it('只有目录、没有清册行 ⇒ 先对账立行，再按这一行恢复', async () => {
    const ghost = entryIdOf('session-ghost')
    const { deps, fs, manifest } = makeDeps()
    expect(await manifest.list()).toEqual([]) // raw 里没有它：raw 读必然 trash-empty
    fs.listDirs.mockResolvedValue([ghost])
    fs.readFile.mockImplementation(async () =>
      zlib.zstdCompressSync(Buffer.from(
        `${JSON.stringify({ type: 'session', version: 4, id: 'session-ghost', createdAt: 1, cwd: 'C:/develop/p' })}\n`,
        'utf8',
      )))
    const base = await start(deps)
    const { status, body } = await call(base, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'restore', [PARAMS.ids]: [ghost] },
    })
    expect(status).toBe(200)
    expect((body.value as Array<Record<string, unknown>>)[0]).toMatchObject({ ok: true, value: { id: ghost } })
    // 行是从目录与日志头重建出来的：对账真的读过这两处，清册里原本没有它
    expect(fs.listDirs).toHaveBeenCalled()
    expect(fs.readFile).toHaveBeenCalled()
    expect(await manifest.list()).toEqual([])
    expect(fs.rename).toHaveBeenCalledWith(
      trashDirOf(ghost, HOME),
      sessionDirOf('--C-develop-p--', 'session-ghost', HOME),
    )
  })
})

// ADR-0012：purge 的写前读同样走 `ledger.list()`。只有目录、没有清册行的条目要先被对账立起来，
// 否则 `carried.claim()` 看不到它，动词会按 trash-empty 拒绝。
describe('路由层 · apply purge 走真相读（ADR-0012）', () => {
  it('只有目录、没有清册行 ⇒ 先对账立行，再按这一行彻底删除', async () => {
    const ghost = entryIdOf('session-ghost')
    const { deps, fs, manifest } = makeDeps()
    expect(await manifest.list()).toEqual([]) // raw 里没有它
    fs.listDirs.mockResolvedValue([ghost])
    fs.readFile.mockImplementation(async () =>
      zlib.zstdCompressSync(Buffer.from(
        `${JSON.stringify({ type: 'session', version: 4, id: 'session-ghost', createdAt: 1, cwd: 'C:/develop/p' })}\n`,
        'utf8',
      )))
    const base = await start(deps)
    const { status, body } = await call(base, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'purge', [PARAMS.ids]: [ghost] },
    })
    expect(status).toBe(200)
    expect((body.value as Array<Record<string, unknown>>)[0]).toMatchObject({ ok: true, value: { removed: 1 } })
    expect(fs.listDirs).toHaveBeenCalled()
    expect(fs.removeDir).toHaveBeenCalledWith(trashDirOf(ghost, HOME))
    expect(await manifest.list()).toEqual([])
  })
})

// 对账与三个写动词都是"读清单 + 动文件 + 写清单"的多步，交错跑会互相踩——串行链把它们按到达序排队。
describe('路由层 · 到达序串行（对账与写动词不交错）', () => {
  it('前一个请求跑完之前，后一个的副作用不发生', async () => {
    const { deps, fs, host } = makeDeps()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let first = true
    fs.listDirs.mockImplementation(async () => {
      if (first) {
        first = false
        await gate
      }
      return []
    })
    const base = await start(deps)
    const listPromise = call(base, ROUTES.list.path)
    await vi.waitFor(() => { expect(fs.listDirs).toHaveBeenCalled() })
    const deletePromise = call(base, ROUTES.apply.path, { method: 'POST', body: { [PARAMS.action]: 'delete', [PARAMS.ids]: ['session-abc'] } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(host.isLive).not.toHaveBeenCalled() // 删除的第一个副作用都还没发生：它被链挡在门外
    release()
    await listPromise
    await deletePromise
    expect(host.isLive).toHaveBeenCalledWith('session-abc') // 前一个一松开，它就接着跑完
  })

  // 纯读不排队（`detail`、`ping` 早就在这条路上）：确认框那一句「含 N 个子会话」挂的是
  // `/apply` 的 `action:'count'`，它不该被前面一次对账堵在身后——否则"打开菜单点删除"要等一次磁盘扫描才有回音。
  it('链被对账占住时，apply 的 count 照样立刻回（纯读豁免跟着段名一起搬进 /apply）', async () => {
    const { deps, fs } = makeDeps({ subagents: { 'session-parent': 2 } })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let first = true
    fs.listDirs.mockImplementation(async () => {
      if (first) {
        first = false
        await gate
      }
      return []
    })
    const base = await start(deps)
    const listPromise = call(base, ROUTES.list.path)
    await vi.waitFor(() => { expect(fs.listDirs).toHaveBeenCalled() })
    const count = await call(base, ROUTES.apply.path, { method: 'POST', body: { [PARAMS.action]: 'count', [PARAMS.ids]: ['session-parent'] } })
    expect(count.body).toEqual({ ok: true, value: [{ id: 'session-parent', action: 'count', ok: true, value: 2 }] }) // 没有等在对账后面
    release()
    await listPromise
  })
})

describe('路由层 · 失败路径（码来自 map-error，原文不吞）', () => {
  it('删一个正在跑的会话 ⇒ sessiondelete/live，且一个字节都没动', async () => {
    const { deps, manifest, fs } = makeDeps({ live: true })
    const base = await start(deps)
    const { code, message } = await failureOfOutcome(base, ROUTES.apply.path, { method: 'POST', body: { [PARAMS.action]: 'delete', [PARAMS.ids]: ['session-abc'] } })
    expect(code).toBe('sessiondelete/live')
    expect(message).toContain('session-abc')
    expect(fs.rename).not.toHaveBeenCalled()
    expect(await manifest.list()).toEqual([])
  })

  // 「没有这一条」只在**真正没被同批带走**时响亮报错；被同批前一条带走的 id 才是幂等 no-op。
  // 幽灵 id（整批开始前就不在清册）必须报 `trash-empty`，不许被"已被带走"粉饰成成功。
  it('恢复一条不在清单里的 id ⇒ 单条动词响亮抛 trash-empty（与混合批里被带走的幂等 no-op 是两件事）', async () => {
    const { deps } = makeDeps()
    await expect(restoreSession(deps)('ghost', [])).rejects.toThrow(/ghost/)
  })

  it('恢复时原项目目录没了 ⇒ sessiondelete/project-missing（不静默建目录）', async () => {
    const { deps, fs } = makeDeps({ seed: [entry('a')] })
    // 清单在、回收站目录也在，唯独 sessions 根不在
    fs.exists.mockImplementation(async (path: string) => path !== `${HOME}/sessions`)
    const base = await start(deps)
    const { code } = await failureOfOutcome(base, ROUTES.apply.path, { method: 'POST', body: { [PARAMS.action]: 'restore', [PARAMS.ids]: [entryIdOf('a')] } })
    expect(code).toBe('sessiondelete/project-missing')
    expect(fs.rename).not.toHaveBeenCalled()
  })

  it('删一条不在账本里的会话 ⇒ sessiondelete/not-found', async () => {
    const { deps, host } = makeDeps()
    host.projectDirOf.mockResolvedValue(undefined)
    const base = await start(deps)
    const { code } = await failureOfOutcome(base, ROUTES.apply.path, { method: 'POST', body: { [PARAMS.action]: 'delete', [PARAMS.ids]: ['ghost'] } })
    expect(code).toBe('sessiondelete/not-found')
  })

  it('彻底删除一条不存在的 entryId ⇒ sessiondelete/trash-empty（幂等只留给"被同批前一条带走"，不粉饰幽灵 id）', async () => {
    const { deps, fs } = makeDeps({ seed: [entry('a')] })
    const base = await start(deps)
    const { code } = await failureOfOutcome(base, ROUTES.apply.path, { method: 'POST', body: { [PARAMS.action]: 'purge', [PARAMS.ids]: ['ghost'] } })
    expect(code).toBe('sessiondelete/trash-empty')
    expect(fs.removeDir).not.toHaveBeenCalled()
  })

  it('list 的域层故障也过同一张映射表 ⇒ sessiondelete/io，原文带出', async () => {
    const { deps, manifest } = makeDeps()
    manifest.list = async () => { throw new Error('domain xrn1997_session_delete_trash is already open') }
    const base = await start(deps)
    const { code, message } = await failureOf(base, ROUTES.list.path)
    expect(code).toBe('sessiondelete/io')
    expect(message).toContain('already open')
  })
})

describe('路由层 · 请求体自检（不静默吞）', () => {
  it('body 不对：缺动作 / ids 不是串数组 / 非法 JSON，一律 400 + 信封（不崩成空响应，也不伪装成 200）', async () => {
    const { deps } = makeDeps()
    const base = await start(deps)
    const badBodies: Array<Record<string, unknown>> = [
      {},
      { [PARAMS.action]: 'delete' },
      { [PARAMS.action]: 'delete', [PARAMS.ids]: [] },
      { [PARAMS.action]: 'delete', [PARAMS.ids]: [42] },
      { [PARAMS.action]: 'nuke', [PARAMS.ids]: ['x'] },
    ]
    for (const body of badBodies) {
      const { status, message } = await failureOf(base, ROUTES.apply.path, { method: 'POST', body })
      expect(message, JSON.stringify(body)).toMatch(/动作|ids/)
      // 请求本身不对 ⇒ 自己的 4xx。**操作**失败才是 200 + 信封（那条口径见下面 `/detail` 读不到那条）。
      expect(status, JSON.stringify(body)).toBe(400)
    }
    expect((await failureOf(base, ROUTES.detail.path, { method: 'POST', body: {} })).status).toBe(400)

    const res = await fetch(`${base}${ROUTES.apply.path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    })
    expect(res.status).toBe(400)
    expect((await res.json() as { ok: boolean }).ok).toBe(false)
  })
})

describe('POST /detail（回收站单条详情，2026-10-15）', () => {
  const seed = [entry('session-a', { title: '有标题', sizeBytes: 4096 })]

  it('清册里有这一条 ⇒ 成功信封，值就是 detail 的形状（不回灌清册字段）', async () => {
    const { deps } = makeDeps({ seed })
    const base = await start(deps)
    const { status, body: envelope } = await call(base, ROUTES.detail.path, {
      method: 'POST',
      body: { [PARAMS.entryId]: entryIdOf('session-a') },
    })
    expect(status).toBe(200)
    expect(envelope.ok).toBe(true)
    expect(envelope.value as Record<string, unknown>).toMatchObject({
      entryId: entryIdOf('session-a'), cwd: 'C:/p', createdAt: 1, blocks: [], olderCursor: null,
    })
    // 清册已有的字段不上线：清单里的大小与详情里的大小必须是同一个数
    expect(Object.keys(envelope.value as object)).not.toContain('sizeBytes')
    expect(Object.keys(envelope.value as object)).not.toContain('deletedAt')
  })

  it('分页游标：不带 before 取尾部一页，带 before 取更早一页；计数始终是全日志的', async () => {
    const { deps, fs } = makeDeps({ seed })
    const lines = [
      JSON.stringify({ type: 'session', version: 4, id: 'session-a', createdAt: 1, cwd: 'C:/p' }),
      ...Array.from({ length: 35 }, (_unused, i) => JSON.stringify({
        type: 'user/message', time: i,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: `第${i}条` }] },
      })),
    ]
    fs.readFile.mockImplementation(async () => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')))
    const base = await start(deps)

    const tail = await call(base, ROUTES.detail.path, {
      method: 'POST', body: { [PARAMS.entryId]: entryIdOf('session-a') },
    })
    const tailValue = tail.body.value as {
      blocks: Array<{ kind: string; text: string }>
      olderCursor: number | null
      userMessageCount: number
    }
    expect(tailValue.blocks).toHaveLength(30)
    expect(tailValue.blocks[0]).toMatchObject({ kind: 'user', text: '第5条' })
    expect(tailValue.blocks[29]).toMatchObject({ kind: 'user', text: '第34条' })
    expect(tailValue.olderCursor).toBe(5)
    expect(tailValue.userMessageCount).toBe(35)

    const older = await call(base, ROUTES.detail.path, {
      method: 'POST', body: { [PARAMS.entryId]: entryIdOf('session-a'), [PARAMS.before]: 5 },
    })
    const olderValue = older.body.value as { blocks: Array<{ text: string }>; olderCursor: number | null }
    expect(olderValue.blocks).toHaveLength(5)
    expect(olderValue.blocks[0]).toMatchObject({ text: '第0条' })
    expect(olderValue.olderCursor).toBeNull()
  })

  it('before 不是非负整数 ⇒ 400，并点名字段（请求本身不对，不是操作失败）', async () => {
    const { deps } = makeDeps({ seed })
    const base = await start(deps)
    for (const before of [-1, 1.5, '5']) {
      const failure = await failureOf(base, ROUTES.detail.path, {
        method: 'POST', body: { [PARAMS.entryId]: entryIdOf('session-a'), [PARAMS.before]: before },
      })
      expect(failure.status, String(before)).toBe(400)
      expect(failure.message).toContain(PARAMS.before)
    }
  })

  it('entryId 不在清册 ⇒ trash-empty，且一次文件读都不做', async () => {
    const { deps, fs } = makeDeps({ seed })
    const base = await start(deps)
    const { status, code } = await failureOf(base, ROUTES.detail.path, { method: 'POST', body: { [PARAMS.entryId]: 'nope' } })
    expect(status).toBe(200) // 操作失败 ⇒ 200 + 信封；4xx 只留给请求本身不对
    expect(code).toBe('sessiondelete/trash-empty')
    expect(fs.readFile).not.toHaveBeenCalled()
  })

  // `/detail` 声明为 pure ⇒ 它只读清册 **raw 索引**（`ledger.raw()`）：对账会写清册行，那是写动作，
  // 必须排在到达序链上，不能随一次看详情偷跑。行为面照旧由目录判：行在 raw 里而目录不在 ⇒ io，不是
  // trash-empty（真相读会先把它当幽灵摘掉，那条路是 `/list` 的）。
  it('/detail 只读 raw 索引、不对账：目录不在的行回 io「回收站目录不在」，一次 listDirs 都不发生', async () => {
    const { deps, fs, manifest } = makeDeps({ seed })
    fs.listDirs.mockResolvedValue([]) // 若走 `list()`，这一行会被当场摘掉 ⇒ trash-empty
    fs.exists.mockImplementation(async (...args: unknown[]) => !String(args[0]).endsWith(entryIdOf('session-a')))
    const base = await start(deps)
    const { status, code, message } = await failureOf(base, ROUTES.detail.path, {
      method: 'POST', body: { [PARAMS.entryId]: entryIdOf('session-a') },
    })
    expect(status).toBe(200)
    expect(code).toBe('sessiondelete/io')
    expect(message).toMatch(/回收站目录不在/)
    // 不对账：`listDirs` 零调用，清册里那一行也一个字都没被动过
    expect(fs.listDirs).not.toHaveBeenCalled()
    expect((await manifest.list()).map((row) => row.id)).toEqual([entryIdOf('session-a')])
  })

  it('目录里没有会话日志 ⇒ io，原文说的是哪个目录里有什么', async () => {
    const { deps } = makeDeps({ seed })
    ;deps.fs.listFiles = vi.fn(async () => ['notes.txt'])
    const base = await start(deps)
    const { code, message } = await failureOf(base, ROUTES.detail.path, { method: 'POST', body: { [PARAMS.entryId]: entryIdOf('session-a') } })
    expect(code).toBe('sessiondelete/io')
    expect(message).toMatch(/没有会话日志/)
  })

  it('body 缺 / 空 / 非串都落 io 并点名字段（方法不对由宿主 exact route 先回 404）', async () => {
    const { deps } = makeDeps({ seed })
    const base = await start(deps)
    for (const bad of [{}, { [PARAMS.entryId]: '' }, { [PARAMS.entryId]: 42 }]) {
      const failure = await failureOf(base, ROUTES.detail.path, { method: 'POST', body: bad })
      expect(failure.code).toBe('sessiondelete/io')
      expect(failure.message).toMatch(PARAMS.entryId)
    }
  })
})

/** 一次 `POST /apply`：body 自己带动作与 ids。 */
describe('路由层 · POST /apply 的自检（一组 id 一个动作，2026-10-17）', () => {
  it('body 缺动作 / ids 不成形都落 io 并点名字段（方法不对由宿主 exact route 先回 404）', async () => {
    const { deps } = makeDeps()
    const base = await start(deps)
    for (const bad of [{}, { [PARAMS.action]: 'count' }, { [PARAMS.action]: 'count', [PARAMS.ids]: '' }]) {
      const failure = await failureOf(base, ROUTES.apply.path, { method: 'POST', body: bad })
      expect(failure.code).toBe('sessiondelete/io')
      expect(failure.message).toMatch(/动作|ids/)
    }
  })
})

// 批量通道（2026-10-17）：写动词从「一条一段」收成 `POST /apply`——一次 HTTP 带一组 id，
// 逐条回 `ApplyOutcome`。钉的是契约：整批只读一次清单、整组 id 只通告一次；重复 id 去重；
// 「已被同批前一条带走」是幂等成功不是失败；一条失败不传染下一条。
describe('路由层 · POST /apply（一组 id 上的同一个动作）', () => {
  const restoreId = (n: string) => entryIdOf(`session-${n}`)

  it('restore 混合批：成功的回条目、失败的带原文码，清单只读一次', async () => {
    const seed = [
      entry('session-a', { sessionId: 'session-a', projectDir: '--p-good--' }),
      entry('session-b', { sessionId: 'session-b', projectDir: '--p-gone--' }),
    ]
    const { deps, manifest, fs } = makeDeps({ seed })
    // 只让 b 的原项目目录缺席（sessions 根与 a 的目录都在）：a 成功、b 报原文、ghost 报"没有这一条"
    fs.exists.mockImplementation(async (path: string) => !path.includes('--p-gone--'))
    const listSpy = vi.spyOn(manifest, 'list')
    const base = await start(deps)
    const { status, body } = await call(base, ROUTES.apply.path, {
      method: 'POST',
      body: { [PARAMS.action]: 'restore', [PARAMS.ids]: [restoreId('a'), 'ghost', restoreId('b')] },
    })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    const outcomes = body.value as Array<Record<string, unknown>>
    expect(outcomes.map((o) => o.id)).toEqual([restoreId('a'), 'ghost', restoreId('b')])
    expect(outcomes[0]).toMatchObject({ ok: true, action: 'restore', value: { id: restoreId('a') } })
    expect(outcomes[1]).toMatchObject({ ok: false })
    expect((pick(outcomes, 1).error as { code: string }).code).toBe('sessiondelete/trash-empty')
    expect((pick(outcomes, 1).error as { message: string }).message).toContain('ghost')
    expect(outcomes[2]).toMatchObject({ ok: false, action: 'restore' })
    expect((pick(outcomes, 2).error as { code: string }).code).toBe('sessiondelete/project-missing')
    // 整批一次清单读（不是每条一次）
    expect(listSpy).toHaveBeenCalledTimes(1)
    // ghost 不在清单也不在任何组里 ⇒ 它**不是**幂等 no-op（没有前一条带走它），照报 trash-empty
    expect(await manifest.list()).toHaveLength(1) // 只剩 b（a 已回来）
  })

  it('restore 一条失败不传染下一条', async () => {
    const seed = [entry('session-a', { sessionId: 'session-a' }), entry('session-b', { sessionId: 'session-b' })]
    const { deps, fs } = makeDeps({ seed })
    // 只让 a 的回收站目录缺席：a 失败、b 照常成功
    fs.exists.mockImplementation(async (path: string) => !path.endsWith(restoreId('a')))
    const base = await start(deps)
    const { body } = await call(base, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'restore', [PARAMS.ids]: [restoreId('a'), restoreId('b')] },
    })
    const outcomes = body.value as Array<Record<string, unknown>>
    expect(outcomes[0]).toMatchObject({ ok: false })
    expect((pick(outcomes, 0).error as { code: string }).code).toBe('sessiondelete/trash-empty')
    expect(outcomes[1]).toMatchObject({ ok: true, value: { id: restoreId('b') } })
  })

  it('同批前一条已把后一条带走 ⇒ 后一条是幂等成功（null），不是失败', async () => {
    const parent = entry('session-p', { sessionId: 'session-p' })
    const child = entry('session-c', { sessionId: 'session-c', parentEntryId: parent.id, deletedAt: 2 })
    const { deps } = makeDeps({ seed: [child, parent] })
    const base = await start(deps)
    const { body } = await call(base, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'restore', [PARAMS.ids]: [parent.id, child.id] },
    })
    const outcomes = body.value as Array<Record<string, unknown>>
    expect(outcomes[0]).toMatchObject({ ok: true, value: { id: parent.id } })
    expect(outcomes[1]).toEqual({ id: child.id, action: 'restore', ok: true, value: null })
  })

  it('purge 一组 id：父行带走它的孩子、清单同步收缩、重复 id 去重', async () => {
    const parent = entry('session-p', { sessionId: 'session-p' })
    const child = entry('session-c', { sessionId: 'session-c', parentEntryId: parent.id, deletedAt: 2 })
    const { deps, manifest } = makeDeps({ seed: [child, parent] })
    const base = await start(deps)
    const { body } = await call(base, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'purge', [PARAMS.ids]: [parent.id, parent.id, child.id] },
    })
    const outcomes = body.value as Array<Record<string, unknown>>
    expect(outcomes).toHaveLength(2) // 去重后
    expect(outcomes[0]).toMatchObject({ ok: true, value: { removed: 2 } })
    expect(outcomes[1]).toMatchObject({ ok: true, value: { removed: 0 } }) // 已被父带走
    expect(await manifest.list()).toEqual([])
  })

  it('count 一组会话 id ⇒ 每条一个数，拿不到的回 0（不报错）', async () => {
    const { deps, host } = makeDeps()
    host.subagentMembersOf.mockResolvedValue({
      available: true,
      value: {
        'session-parent': [
          { sessionId: 'session-parent-1', projectDir: '--p--' },
          { sessionId: 'session-parent-2', projectDir: '--p--' },
        ],
      },
    })
    const base = await start(deps)
    const { body } = await call(base, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'count', [PARAMS.ids]: ['session-parent', 'session-none'] },
    })
    const outcomes = body.value as Array<Record<string, unknown>>
    expect(outcomes[0]).toMatchObject({ ok: true, value: 2 })
    expect(outcomes[1]).toMatchObject({ ok: true, value: 0 })
  })

  it('delete 一组会话 id：各自成行进清册，一条失败不传染下一条', async () => {
    const { deps, manifest, host } = makeDeps()
    host.projectDirOf.mockImplementation(async (sessionId: string) => (sessionId === 'session-bad' ? undefined : '--p--'))
    const base = await start(deps)
    const { body } = await call(base, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'delete', [PARAMS.ids]: ['session-a', 'session-bad', 'session-b'] },
    })
    const outcomes = body.value as Array<Record<string, unknown>>
    expect(outcomes[0]).toMatchObject({ ok: true, value: { sessionId: 'session-a' } })
    expect(outcomes[1]).toMatchObject({ ok: false })
    expect((pick(outcomes, 1).error as { code: string }).code).toBe('sessiondelete/not-found')
    expect(outcomes[2]).toMatchObject({ ok: true, value: { sessionId: 'session-b' } })
    expect((await manifest.list()).length).toBe(2)
  })

  // 批量删除里父先走、孩子跟着搬进回收站 ⇒ 后到的孩子 id 是一次幂等 no-op，不是 not-found。
  // 单条删除（N=1）不会命中这台分支。
  it('delete 同批父先走：跟着父亲被带走的子会话返回幂等 null', async () => {
    const { deps, manifest, host } = makeDeps({
      members: { 'session-parent': [{ sessionId: 'session-child', projectDir: '--p--' }] },
    })
    // 孩子如果真被单独走一遍会在这里拿到 undefined；幂等支根本不该进动词。
    host.projectDirOf.mockImplementation(async (sessionId: string) =>
      (sessionId === 'session-child' ? undefined : '--p--'))
    const base = await start(deps)
    const { body } = await call(base, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'delete', [PARAMS.ids]: ['session-parent', 'session-child'] },
    })
    const outcomes = body.value as Array<Record<string, unknown>>
    expect(outcomes[0]).toMatchObject({ ok: true, value: { sessionId: 'session-parent' } })
    expect(outcomes[1]).toEqual({ id: 'session-child', action: 'delete', ok: true, value: null })
    expect(await manifest.list()).toHaveLength(2)
  })

  it('整批恢复只调一次通告，整组 id 一起交出去', async () => {
    const seed = [entry('session-a', { sessionId: 'session-a' }), entry('session-b', { sessionId: 'session-b' })]
    const { deps, host } = makeDeps({ seed })
    const base = await start(deps)
    await call(base, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'restore', [PARAMS.ids]: [restoreId('a'), restoreId('b')] },
    })
    expect(host.announceRestored).toHaveBeenCalledTimes(1)
    expect(host.announceRestored.mock.calls[0]?.[0]).toEqual(['session-a', 'session-b'])
    // 新清单的删除不归档 ⇒ 恢复不碰归档集。
    expect(host.unarchive).not.toHaveBeenCalled()
    expect(host.archive).not.toHaveBeenCalled()
  })

  // 旧清单（2026-10-21 之前用归档藏会话）的批量恢复：每一条都要先取消归档，整批通告必须等它们都落地。
  // 新清单那条上面的用例已经钉了"不碰归档"；这两条一起把迁移支与常规支分开。
  it('旧清单的批量恢复：先取消归档再发批量通告', async () => {
    const seed = [entry('session-a'), entry('session-b')]
    const { deps, host } = makeDeps({ seed })
    host.isArchived.mockResolvedValue(true)
    const base = await start(deps)
    await call(base, ROUTES.apply.path, {
      method: 'POST',
      body: { [PARAMS.action]: 'restore', [PARAMS.ids]: [restoreId('a'), restoreId('b')] },
    })
    expect(host.unarchive).toHaveBeenCalledTimes(2)
    expect(host.archive).not.toHaveBeenCalled()
    const announced = pick(host.announceRestored.mock.invocationCallOrder, 0)
    expect(announced).toBeGreaterThan(Math.max(...host.unarchive.mock.invocationCallOrder))
  })

  // 用户勾的是父那一行，回来的是**一整组**。通告漏掉孩子 = 客户端那一行永远还挂着"在回收站"的读感
  // （宿主的分组面不会自己想起它）。单条动词那条路早就钉过（`restore-session.test.ts` 数到 3），
  // 这条钉的是**批量这一层**：它自己攒 `restored` 名单，不靠动词发通告。
  it('整批恢复：跟着父亲一起回来的孩子也进那一次批量通告', async () => {
    const parent = entry('session-a', { sessionId: 'session-a' })
    const kid = entry('session-kid', { sessionId: 'session-kid', parentEntryId: parent.id })
    const { deps, host } = makeDeps({ seed: [parent, kid] })
    const base = await start(deps)
    await call(base, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'restore', [PARAMS.ids]: [restoreId('a')] },
    })
    expect(host.announceRestored).toHaveBeenCalledTimes(1)
    // 上面那条已经证明这一趟通告发生了一次，取位只是把它交给编译器看：拿不到就是夹具脱节，
    // 不许让下一行断言对着 undefined 蒙一次绿。
    const announced = pick(pick(host.announceRestored.mock.calls, 0), 0)
    expect([...announced].sort()).toEqual(['session-a', 'session-kid'])
  })
})

// 无主子会话维护（2026-10-19）：父被彻底删掉之后，它的 subagent 孩子还留在 `sessions/` 里，
// 而宿主的客户端把 `origin:"subagent"` 整排藏了 ⇒ 这一坨字节既看不见也清不掉。
// 扫描是**纯读**（不占到达序链、一个字都不动），清理是**写动作**（上链，且点之前先对账）。
describe('路由层 · GET /orphans 与 apply orphan-clean（无主子会话，2026-10-19）', () => {
  const corpus = () => [
    { sessionId: 'session-root', parentSessionId: 'session-gone', projectDir: '--p--', subagent: true },
    { sessionId: 'session-kid', parentSessionId: 'session-root', projectDir: '--p--', subagent: true },
  ]

  it('GET /orphans 是纯读：交回闭包总数、字节、项目分组；不删任何东西', async () => {
    const { deps, fs, host, manifest } = makeDeps()
    host.listSessions = vi.fn(async () => ({ available: true as const, value: corpus() }))
    const base = await start(deps)
    const { status, body } = await call(base, ROUTES.orphans.path)
    expect(status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      value: {
        roots: ['session-root'], totalSessions: 2, totalBytes: 448 * 1024, missingParents: 1,
        groups: [{ projectDir: '--p--', sessions: 2, bytes: 448 * 1024 }],
      },
    })
    expect(fs.removeDir).not.toHaveBeenCalled()
    // 连对账都不是：`/orphans` 只读清册 raw 索引，一次 `listDirs` 都不该发生。
    expect(fs.listDirs).not.toHaveBeenCalled()
    expect(await manifest.list()).toEqual([])
  })

  // `/orphans` 声明为 pure ⇒ 它不许对账（对账会写清册行，那是写动作，必须排在到达序链上）。
  // 清册里有一行而目录不在：raw 读仍把它交回来，`listDirs` 一次都不发生；真相读 `list()` 才会摘它。
  it('GET /orphans 不对账：目录不在的种子行仍留在 raw 清册里，且不碰 listDirs', async () => {
    const { deps, fs, host, manifest } = makeDeps({ seed: [entry('session-ghost-entry')] })
    host.listSessions = vi.fn(async () => ({ available: true as const, value: corpus() }))
    fs.listDirs.mockResolvedValue([]) // 目录不在：若走 `list()` 这一行会被当场摘掉
    const base = await start(deps)
    const { status, body } = await call(base, ROUTES.orphans.path)
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, value: { roots: ['session-root'] } })
    expect(fs.listDirs).not.toHaveBeenCalled()
    expect((await manifest.list()).map((row) => row.sessionId)).toEqual(['session-ghost-entry'])
  })

  // 语料面缺席 ≠ "这个家没有孤儿"。回一份 `roots: []` 的空报告会让界面说一句"没有要清理的"，
  // 而盘上真躺着几百 MB ⇒ 必须是 `io` 信封（判据在动词层，这里钉它能过桥到线上）。
  it('GET /orphans 的 sessionQuery 缺席 ⇒ io 信封，不冒充空报告', async () => {
    const { deps } = makeDeps()
    const base = await start(deps)
    const failure = await failureOf(base, ROUTES.orphans.path)
    // **操作**读不到 ⇒ 200 + 信封（404 是"这条路由不存在"，那是另一件事，见上面 POST 那条）
    expect(failure.status).toBe(200)
    expect(failure.code).toBe('sessiondelete/io')
  })

  // `/orphans` 是**读**段：只注册 GET；POST 在宿主 exact route 的 handler 之前就回 404，不留写路径。
  it('POST /orphans 不是写动作 ⇒ 宿主 exact route 回 404', async () => {
    const { deps } = makeDeps()
    const base = await start(deps)
    const res = await fetch(`${base}${ROUTES.orphans.path}`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('not found')
  })

  it('POST /apply orphan-clean：按根清闭包，回逐根字节与条数', async () => {
    const { deps, host, fs } = makeDeps()
    host.listSessions = vi.fn(async () => ({ available: true as const, value: corpus() }))
    const base = await start(deps)
    const { body } = await call(base, ROUTES.apply.path, { method: 'POST', body: { [PARAMS.action]: 'orphan-clean', [PARAMS.ids]: ['session-root'] } })
    expect(body.ok).toBe(true)
    expect((body.value as ApplyOutcome[])[0]).toMatchObject({
      action: 'orphan-clean', ok: true, value: { removed: 2, freedBytes: 448 * 1024 },
    })
    expect(fs.removeDir).toHaveBeenCalledTimes(2)
  })

  it('POST /apply orphan-clean：根 id 去前缀后仍匹配（session-root 与 root 都认）', async () => {
    const { deps, host } = makeDeps()
    host.listSessions = vi.fn(async () => ({ available: true as const, value: corpus() }))
    const base = await start(deps)
    const { body } = await call(base, ROUTES.apply.path, { method: 'POST', body: { [PARAMS.action]: 'orphan-clean', [PARAMS.ids]: ['root'] } })
    expect((body.value as ApplyOutcome[])[0]).toMatchObject({
      id: 'root', action: 'orphan-clean', ok: true, value: { removed: 2, freedBytes: 448 * 1024 },
    })
  })

  it('POST /apply orphan-clean：会话语料缺席 ⇒ 顶层 io 信封，不回零条假回执', async () => {
    const { deps, fs } = makeDeps()
    const base = await start(deps)
    const failure = await failureOf(base, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'orphan-clean', [PARAMS.ids]: ['session-root'] },
    })
    expect(failure.code).toBe('sessiondelete/io')
    expect(fs.removeDir).not.toHaveBeenCalled()
  })

  it('POST /apply orphan-clean：删到一半失败 ⇒ failure.error.details 带部分回执', async () => {
    const { deps, host, fs } = makeDeps()
    host.listSessions = vi.fn(async () => ({ available: true as const, value: corpus() }))
    fs.removeDir.mockImplementation(async (...args: unknown[]) => {
      if (String(args[0]).endsWith('session-kid')) throw new Error('boom')
    })
    const base = await start(deps)
    const { body } = await call(base, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'orphan-clean', [PARAMS.ids]: ['session-root'] },
    })
    const outcome = pick(body.value as ApplyOutcome[], 0)
    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? {} : outcome.error).toMatchObject({
      code: 'sessiondelete/io',
      details: { removed: 1, freedBytes: 224 * 1024, failedSessionId: 'session-kid' },
    })
  })

  it('POST /apply orphan-clean：成员在跑 ⇒ live，零删', async () => {
    const { deps, host, fs } = makeDeps()
    host.listSessions = vi.fn(async () => ({ available: true as const, value: corpus() }))
    host.isLive = vi.fn(async (id: string) => id === 'session-kid')
    const base = await start(deps)
    const failure = await failureOfOutcome(base, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'orphan-clean', [PARAMS.ids]: ['session-root'] },
    })
    expect(failure.code).toBe('sessiondelete/live')
    expect(fs.removeDir).not.toHaveBeenCalled()
  })

  // 点之后到清理落地之间，回收站可能被手工动过。写动作**自己先对账**（与三个写动词同一条链、同一份
  // 判据）：刚手工搬进回收站的那一格目录要能被认成"父还在回收站里等着"（stranded，不该被当孤儿删掉）。
  it('POST /apply orphan-clean 是写动作：清册里躺着这个父 ⇒ 不再是孤儿，报 not-found 且零删', async () => {
    const { deps, host, fs, manifest } = makeDeps()
    host.listSessions = vi.fn(async () => ({ available: true as const, value: corpus() }))
    // 手工搬进来的父目录：清册里还没有这一行，只有目录 ⇒ 先对账把它重建出来，父从此是"已知的"（stranded，
    // 该跟着父恢复或彻底删除，不是这里能替用户决定的）。不先对账的话这一条会被当成孤儿**直接删掉**。
    fs.listDirs = vi.fn(async () => [entryIdOf('session-gone')])
    fs.readFile = vi.fn(async () => zlib.zstdCompressSync(Buffer.from(
      `${JSON.stringify({ type: 'session', version: 4, id: 'session-gone', createdAt: 1, cwd: 'C:/p' })}\n`, 'utf8')))
    const base = await start(deps)
    const failure = await failureOfOutcome(base, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'orphan-clean', [PARAMS.ids]: ['session-root'] },
    })
    expect(failure.code).toBe('sessiondelete/not-found')
    expect(fs.removeDir).not.toHaveBeenCalled()
    // 对账真的写过清册（父行立起来了），而这一组一个字没动
    expect((await manifest.list()).map((row) => row.sessionId)).toEqual(['session-gone'])
  })

  // 纯读的那一半：链被对账占住时 `/orphans` 照样立刻回——残留条是面板打开时就读的一份读数，
  // 不该排在一次 100 条的恢复/对账后面（与 `ping`、`detail`、`apply/count` 同一条豁免）。
  it('链被对账占住时 GET /orphans 照样立刻回（纯读不占链）', async () => {
    const { deps, fs, host } = makeDeps()
    host.listSessions = vi.fn(async () => ({ available: true as const, value: corpus() }))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let first = true
    fs.listDirs.mockImplementation(async () => {
      if (first) {
        first = false
        await gate
      }
      return []
    })
    const base = await start(deps)
    const listPromise = call(base, ROUTES.list.path)
    await vi.waitFor(() => { expect(fs.listDirs).toHaveBeenCalled() })
    const scanned = await call(base, ROUTES.orphans.path)
    expect(scanned.body).toMatchObject({ ok: true, value: { totalSessions: 2, roots: ['session-root'] } })
    release()
    await listPromise
  })

  // 写的那一半必须在链上：`orphan-clean` 自己要先读清单再动文件，与对账交错跑就会互相踩。
  it('链被对账占住时 orphan-clean 的副作用不发生（写动作一律上链）', async () => {
    const { deps, fs, host } = makeDeps()
    host.listSessions = vi.fn(async () => ({ available: true as const, value: corpus() }))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let first = true
    fs.listDirs.mockImplementation(async () => {
      if (first) {
        first = false
        await gate
      }
      return []
    })
    const base = await start(deps)
    const listPromise = call(base, ROUTES.list.path)
    await vi.waitFor(() => { expect(fs.listDirs).toHaveBeenCalled() })
    const cleanPromise = call(base, ROUTES.apply.path, {
      method: 'POST', body: { [PARAMS.action]: 'orphan-clean', [PARAMS.ids]: ['session-root'] },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(host.listSessions).not.toHaveBeenCalled()
    expect(fs.removeDir).not.toHaveBeenCalled()
    release()
    await cleanPromise
    await listPromise
    expect(host.listSessions).toHaveBeenCalled()
  })
})

describe('路由层 · GET /ping（探测专用：零副作用的最便宜一问）', () => {
  it('回 pong，且一次清单读、一次文件读都不做', async () => {
    const { deps, manifest, fs } = makeDeps({ seed: [entry('a')] })
    const listSpy = vi.spyOn(manifest, 'list')
    const base = await start(deps)
    const { status, body } = await call(base, ROUTES.ping.path)
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: 'pong' })
    expect(listSpy).not.toHaveBeenCalled()
    expect(fs.listDirs).not.toHaveBeenCalled()
  })

  // 探测必须**不进串行链**：否则一次 100 条的恢复/对账在飞时，页面加载会被它堵在身后，
  // 恰好违背这条零成本探测的初衷。
  it('链被对账占住时 ping 照样立刻回', async () => {
    const { deps, fs } = makeDeps({ seed: [entry('a')] })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let first = true
    fs.listDirs.mockImplementation(async () => {
      if (first) {
        first = false
        await gate
      }
      return []
    })
    const base = await start(deps)
    const listPromise = call(base, ROUTES.list.path)
    await vi.waitFor(() => { expect(fs.listDirs).toHaveBeenCalled() })
    const ping = await call(base, ROUTES.ping.path)
    expect(ping.body).toEqual({ ok: true, value: 'pong' })
    release()
    await listPromise
  })
})

describe('路由层 · POST /empty（清空 = 聚合回执，不按条回）', () => {
  it('清掉全部行并回 {removed,freedBytes}', async () => {
    // 夹具第一参是**原目录名**：`entry('a')` / `entry('b')` 才是两个不同的 id
    const { deps, manifest } = makeDeps({ seed: [entry('a'), entry('b')] })
    const base = await start(deps)
    const { status, body } = await call(base, ROUTES.empty.path, { method: 'POST', body: {} })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.value).toMatchObject({ removed: 2 })
    expect(await manifest.list()).toEqual([])
  })

  // 清空**先对账再清**（与 `/list` 同一条判据，2026-10-19）：手工搬进回收站的那一格在清册里还没有行，
  // 只按清册清就会留下一个永远点不到的目录——而"清空"在用户那里说的是"这里一个不剩"。
  it('empty 先对账：只有目录、清册里没有的条目也会被清空带走', async () => {
    const { deps, fs, manifest } = makeDeps()
    const id = entryIdOf('session-ghost')
    fs.listDirs = vi.fn(async () => [id])
    const base = await start(deps)
    const { body } = await call(base, ROUTES.empty.path, { method: 'POST', body: {} })
    expect(body.ok).toBe(true)
    expect(fs.removeDir).toHaveBeenCalledWith(`/h/session-trash/${id}`)
    expect(await manifest.list()).toEqual([])
  })
})

// 附件段（2026-10-27）：附件字节。全仓唯一的二进制响应段；读的是宿主附件库
//（`$DSH_HOME/attachments/v1/objects` 图片 / `file-objects` 普通文件），不碰回收站清册。
// 请求本身不对（id/kind 形状）⇒ 400 + JSON 信封；对象不在 / 超过上限 ⇒ 200 + JSON 信封
//（图片的 `img onError` 会换成占位；普通文件走 `<a download>`，没有页面内失败面）。
describe('路由层 · GET /attachment（二进制附件字节，2026-10-27）', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
  const imageId = `sha256:${'a'.repeat(64)}`
  const fileId = `sha256:${'b'.repeat(64)}`
  /** 附件段的 query（`id` / `kind` / `name` 与 Node 半同源）。 */
  const query = (id: string, kind: string, name?: string): string =>
    `${ROUTES.attachment.path}?${PARAMS.attachmentId}=${encodeURIComponent(id)}&${PARAMS.attachmentKind}=${kind}`
    + (name === undefined ? '' : `&${PARAMS.attachmentName}=${encodeURIComponent(name)}`)

  /** 带引用元数据的 query：服务路径用它；缺字段就只带存在的那几格。 */
  const withMeta = (
    id: string,
    kind: string,
    meta: { mediaType?: string; bytes?: number; width?: number; height?: number; name?: string },
  ): string => {
    const params = new URLSearchParams({ [PARAMS.attachmentId]: id, [PARAMS.attachmentKind]: kind })
    if (meta.mediaType !== undefined) params.set(PARAMS.attachmentMediaType, meta.mediaType)
    if (meta.bytes !== undefined) params.set(PARAMS.attachmentBytes, String(meta.bytes))
    if (meta.width !== undefined) params.set(PARAMS.attachmentWidth, String(meta.width))
    if (meta.height !== undefined) params.set(PARAMS.attachmentHeight, String(meta.height))
    if (meta.name !== undefined) params.set(PARAMS.attachmentName, meta.name)
    return `${ROUTES.attachment.path}?${params.toString()}`
  }

  it('GET /attachment 回原始图片字节与安全头', async () => {
    const made = makeDeps()
    made.fs.statFile.mockImplementation(async (p: string) =>
      (p.includes('/attachments/') ? { size: png.length } : { size: 0 }))
    made.fs.readFile.mockImplementation(async (p: string) => {
      if (p.includes('/attachments/')) return png
      throw new Error(`unexpected read: ${p}`)
    })
    const base = await start(made.deps)
    const res = await callRaw(base, query(imageId, 'image'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-length')).toBe(String(png.length))
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png)
  })

  // 同源闸依赖宿主 bridge 保留原始 Host（它只改写 request.url）：这条走真 node:http 桥，
  // 钉住「浏览器带的同源 Referer 与 Host 对得上」与「异 authority 被插件拒」。
  it('经真 node:http 桥：同源 Referer 放行，异 authority 的 Referer 回 403 信封', async () => {
    const made = makeDeps()
    made.fs.statFile.mockResolvedValue({ size: png.length })
    made.fs.readFile.mockResolvedValue(png)
    const base = await start(made.deps)
    const origin = new URL(base).origin

    const res = await fetch(`${base}${query(imageId, 'image')}`, {
      headers: { referer: `${origin}/index.html` },
    })
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png)

    const blocked = await fetch(`${base}${query(imageId, 'image')}`, {
      headers: { referer: 'http://192.168.1.5:9999/page' },
    })
    expect(blocked.status).toBe(403)
    expect(((await blocked.json()) as { ok: boolean }).ok).toBe(false)
  })

  it('GET /attachment 的 id/kind 闸：非法一律 400 信封，且不读盘', async () => {
    const made = makeDeps()
    const base = await start(made.deps)
    const badPaths = [
      `${ROUTES.attachment.path}?${PARAMS.attachmentId}=${encodeURIComponent('../../x')}&${PARAMS.attachmentKind}=image`,
      `${ROUTES.attachment.path}?${PARAMS.attachmentId}=${encodeURIComponent(`sha256:${'A'.repeat(64)}`)}&${PARAMS.attachmentKind}=image`,
      `${ROUTES.attachment.path}?${PARAMS.attachmentId}=${encodeURIComponent(imageId)}&${PARAMS.attachmentKind}=v2`,
      `${ROUTES.attachment.path}?${PARAMS.attachmentKind}=image`,
    ]
    for (const path of badPaths) {
      const { status, body } = await call(base, path)
      expect(status, path).toBe(400)
      expect(body.ok, path).toBe(false)
    }
    expect(made.fs.statFile).not.toHaveBeenCalled()
    expect(made.fs.readFile).not.toHaveBeenCalled()
  })

  it('GET /attachment 对象不在：200 + 失败信封（img onError 的落点）', async () => {
    const made = makeDeps()
    made.fs.statFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    const base = await start(made.deps)
    const { status, body } = await call(base, query(imageId, 'image'))
    expect(status).toBe(200)
    expect(body.ok).toBe(false)
    expect((body.error as { code: string }).code).toBe('sessiondelete/io')
    expect(made.fs.readFile).not.toHaveBeenCalled()
  })

  it('GET /attachment 超过 20 MiB：200 + 失败信封，不把整份字节读进内存', async () => {
    const made = makeDeps()
    made.fs.statFile.mockResolvedValue({ size: 20 * 1024 * 1024 + 1 })
    const base = await start(made.deps)
    const { status, body } = await call(base, query(imageId, 'image'))
    expect(status).toBe(200)
    expect(body.ok).toBe(false)
    expect((body.error as { message: string }).message).toContain('上限')
    expect(made.fs.readFile).not.toHaveBeenCalled()
  })

  it('kind=file 回 octet-stream + attachment 下载头，文件名过闸', async () => {
    const bytes = Buffer.from('hello attachment')
    const made = makeDeps()
    made.fs.statFile.mockResolvedValue({ size: bytes.length })
    made.fs.readFile.mockResolvedValue(bytes)
    const base = await start(made.deps)
    const res = await callRaw(base, query(fileId, 'file', '../secret name.txt'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    const disposition = res.headers.get('content-disposition') ?? ''
    expect(disposition.startsWith("attachment; filename*=UTF-8''")).toBe(true)
    // 路径分隔符与 `..` 都被换掉：请求里的名字进不了文件系统，只作为下载名。
    expect(decodeURIComponent(disposition.slice("attachment; filename*=UTF-8''".length))).toBe('__secret name.txt')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes)
  })

  it('图片魔数认不出 ⇒ 按下载处理（octet-stream + attachment），不猜类型', async () => {
    const bytes = Buffer.from('not an image')
    const made = makeDeps()
    made.fs.statFile.mockResolvedValue({ size: bytes.length })
    made.fs.readFile.mockResolvedValue(bytes)
    const base = await start(made.deps)
    const res = await callRaw(base, query(imageId, 'image'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename\*=UTF-8''/)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes)
  })

  it('attachments 服务优先：readImage 的归一化 ref 决定类型，不读 fs', async () => {
    const readImage = vi.fn(async (ref: ImageAttachmentRefLike) => ({ ref, data: new Uint8Array(png) }))
    const service: AttachmentsPort = {
      available: () => true,
      readImage,
      readFileStream: async function* () { yield new Uint8Array() },
    }
    const made = makeDeps({ attachments: service })
    const base = await start(made.deps)
    const res = await callRaw(base, withMeta(imageId, 'image', {
      mediaType: 'image/png', bytes: png.length, width: 1, height: 1,
    }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png)
    expect(readImage).toHaveBeenCalledWith(expect.objectContaining({
      attachmentId: imageId, mediaType: 'image/png', bytes: png.length, width: 1, height: 1,
    }))
    expect(made.fs.statFile).not.toHaveBeenCalled()
    expect(made.fs.readFile).not.toHaveBeenCalled()
  })

  it('attachments 服务优先：readFileStream 分块拼回，不读 fs', async () => {
    const chunks = [Buffer.from('hello '), Buffer.from('attachment')]
    const service: AttachmentsPort = {
      available: () => true,
      readImage: async () => { throw new Error('readImage 不该被调用') },
      readFileStream: async function* () { for (const chunk of chunks) yield chunk },
    }
    const made = makeDeps({ attachments: service })
    const base = await start(made.deps)
    const res = await callRaw(base, withMeta(fileId, 'file', {
      bytes: chunks.reduce((sum, chunk) => sum + chunk.length, 0), name: 'secret name.txt',
    }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.concat(chunks))
    expect(made.fs.readFile).not.toHaveBeenCalled()
  })

  it('文件引用缺 name ⇒ 视为元数据不够，退回直接 fs（宿主把空名判无效引用）', async () => {
    const bytes = Buffer.from('hello attachment')
    const readFileStream = vi.fn(async function* () { yield new Uint8Array() })
    const service: AttachmentsPort = {
      available: () => true,
      readImage: async () => { throw new Error('不该调用') },
      readFileStream,
    }
    const made = makeDeps({ attachments: service })
    made.fs.statFile.mockResolvedValue({ size: bytes.length })
    made.fs.readFile.mockResolvedValue(bytes)
    const base = await start(made.deps)
    const res = await callRaw(base, withMeta(fileId, 'file', { bytes: bytes.length }))
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes)
    expect(readFileStream).not.toHaveBeenCalled()
    expect(made.fs.readFile).toHaveBeenCalled()
  })

  it('文件引用里声明的字节超限 ⇒ 不调用 readFileStream，直接回 io', async () => {
    const readFileStream = vi.fn(async function* () { yield new Uint8Array() })
    const service: AttachmentsPort = {
      available: () => true,
      readImage: async () => { throw new Error('不该调用') },
      readFileStream,
    }
    const made = makeDeps({ config: { ...DEFAULT_CONFIG, maxAttachmentBytes: 16 }, attachments: service })
    const base = await start(made.deps)
    const { status, body } = await call(base, withMeta(fileId, 'file', { bytes: 17, name: 'a.bin' }))
    expect(status).toBe(200)
    expect(body.ok).toBe(false)
    expect((body.error as { message: string }).message).toContain('上限')
    expect(readFileStream).not.toHaveBeenCalled()
    expect(made.fs.readFile).not.toHaveBeenCalled()
  })

  it('服务在场但引用元数据不够 ⇒ 退回直接 fs，不拿半截 ref 去猜', async () => {
    const readImage = vi.fn(async () => { throw new Error('不该调用') })
    const service: AttachmentsPort = {
      available: () => true,
      readImage,
      readFileStream: async function* () { yield new Uint8Array() },
    }
    const made = makeDeps({ attachments: service })
    made.fs.statFile.mockResolvedValue({ size: png.length })
    made.fs.readFile.mockResolvedValue(png)
    const base = await start(made.deps)
    const res = await callRaw(base, query(imageId, 'image'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(readImage).not.toHaveBeenCalled()
    expect(made.fs.readFile).toHaveBeenCalled()
  })

  it('available() 为真但服务中途消失 ⇒ 退回直接 fs，不把这次读取判成 io', async () => {
    const service: AttachmentsPort = {
      available: () => true,
      readImage: async () => { throw new AttachmentsUnavailableError() },
      readFileStream: async function* () {
        yield new Uint8Array()
        throw new AttachmentsUnavailableError()
      },
    }
    const made = makeDeps({ attachments: service })
    made.fs.statFile.mockResolvedValue({ size: png.length })
    made.fs.readFile.mockResolvedValue(png)
    const base = await start(made.deps)
    const res = await callRaw(base, withMeta(imageId, 'image', {
      mediaType: 'image/png', bytes: png.length, width: 1, height: 1,
    }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png)
    expect(made.fs.readFile).toHaveBeenCalled()
  })

  it('引用里声明的字节超限 ⇒ 不调用 readImage，直接回 io（也不回退 fs）', async () => {
    const readImage = vi.fn(async () => { throw new Error('不该调用') })
    const service: AttachmentsPort = {
      available: () => true,
      readImage,
      readFileStream: async function* () { yield new Uint8Array() },
    }
    const made = makeDeps({ config: { ...DEFAULT_CONFIG, maxAttachmentBytes: 16 }, attachments: service })
    const base = await start(made.deps)
    const { status, body } = await call(base, withMeta(imageId, 'image', {
      mediaType: 'image/png', bytes: 17, width: 1, height: 1,
    }))
    expect(status).toBe(200)
    expect(body.ok).toBe(false)
    expect((body.error as { message: string }).message).toContain('上限')
    expect(readImage).not.toHaveBeenCalled()
    expect(made.fs.readFile).not.toHaveBeenCalled()
  })

  it('attachments 服务路径也受上限闸：图片超限回 200 + io，不读 fs', async () => {
    const readImage = vi.fn(async (ref: ImageAttachmentRefLike) => ({ ref, data: new Uint8Array(17) }))
    const service: AttachmentsPort = {
      available: () => true,
      readImage,
      readFileStream: async function* () { yield new Uint8Array() },
    }
    const made = makeDeps({ config: { ...DEFAULT_CONFIG, maxAttachmentBytes: 16 }, attachments: service })
    const base = await start(made.deps)
    // 声明值在闸内、服务实际回超限字节：考的是读后按实际字节再判一次。
    const { status, body } = await call(base, withMeta(imageId, 'image', {
      mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    }))
    expect(status).toBe(200)
    expect(body.ok).toBe(false)
    expect((body.error as { message: string }).message).toContain('上限')
    expect(readImage).toHaveBeenCalled()
    expect(made.fs.readFile).not.toHaveBeenCalled()
  })

  it('attachments 服务路径也受上限闸：文件流超限在累计处停下，不回退 fs', async () => {
    const service: AttachmentsPort = {
      available: () => true,
      readImage: async () => { throw new Error('不该调用') },
      readFileStream: async function* () { yield new Uint8Array(20) },
    }
    const made = makeDeps({ config: { ...DEFAULT_CONFIG, maxAttachmentBytes: 16 }, attachments: service })
    const base = await start(made.deps)
    // 声明值在闸内、服务实际流超限：考的是累计处停下，而不是声明的预检。
    const { status, body } = await call(base, withMeta(fileId, 'file', { bytes: 1, name: 'a.bin' }))
    expect(status).toBe(200)
    expect(body.ok).toBe(false)
    expect((body.error as { message: string }).message).toContain('上限')
    expect(made.fs.readFile).not.toHaveBeenCalled()
  })
})

// 孤儿附件（2026-10-27，第八、第九段）：报告与清理共用同一份引用扫描。
// 报告是纯读（不排链、不读清册），读不出引用源 ⇒ 200 + io（不拿 0 冒充"没有孤儿"）；
// 清理是写动作（上链），只删 `objects` 下无引用的图片，聚合回 `AttachmentCleanupWire`。
describe('路由层 · 孤儿附件（GET /attachment-orphans、POST /attachment-clean，2026-10-27）', () => {
  const OBJECTS = `${HOME}/attachments/v1/objects`
  const ACTIVE = '/h/sessions/--p--/session-active'
  const TRASHED = '/h/session-trash/20260101T000000Z-session-trashed'
  const LOG = 'session.v4.jsonl.zstd'
  const hex = (char: string) => char.repeat(64)
  const ID = `sha256:${hex('a')}`
  const ID2 = `sha256:${hex('b')}`
  const ID3 = `sha256:${hex('c')}`
  const imagePath = (id: string) => attachmentPathOf(HOME, 'image', id)
  const logWithImage = (id: string) =>
    zlib.zstdCompressSync(Buffer.from(
      [
        JSON.stringify({ type: 'session', version: 4, id: 'session-x', createdAt: 1, cwd: 'C:/p' }),
        JSON.stringify({
          type: 'user/message', time: 2,
          data: {
            source: { kind: 'user' },
            content: [{ type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', bytes: 3 } }],
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    ))

  /** 三个对象：aa 被活动会话引用、bb 被回收站目录引用、cc 无引用。 */
  function orphanDeps(over: { unreadable?: boolean } = {}) {
    const made = makeDeps()
    made.fs.listDirs.mockImplementation(async (p: string) => {
      if (p === '/h/sessions') return ['--p--']
      if (p === '/h/sessions/--p--') return ['session-active']
      if (p === '/h/session-trash') return ['20260101T000000Z-session-trashed']
      if (p === OBJECTS) return ['aa', 'bb', 'cc']
      return []
    })
    made.fs.listFiles.mockImplementation(async (p: string) => {
      if (p === ACTIVE) return over.unreadable === true ? ['session.v4.jsonl'] : [LOG]
      if (p === TRASHED) return [LOG]
      if (p === `${OBJECTS}/aa`) return [hex('a')]
      if (p === `${OBJECTS}/bb`) return [hex('b')]
      if (p === `${OBJECTS}/cc`) return [hex('c')]
      return []
    })
    made.fs.readFile.mockImplementation(async (p: string) => {
      if (p === `${ACTIVE}/${LOG}`) return logWithImage(ID)
      if (p === `${TRASHED}/${LOG}`) return logWithImage(ID2)
      throw new Error(`unexpected read: ${p}`)
    })
    made.fs.statFile.mockImplementation(async (p: string) => {
      if (p === imagePath(ID)) return { size: 10 }
      if (p === imagePath(ID2)) return { size: 20 }
      if (p === imagePath(ID3)) return { size: 30 }
      return { size: 0 }
    })
    return made
  }

  it('GET /attachment-orphans：没有对象 ⇒ {count:0,totalBytes:0}，且不读清册', async () => {
    const made = makeDeps()
    const listSpy = vi.spyOn(made.manifest, 'list')
    const base = await start(made.deps)
    const { status, body } = await call(base, ROUTES.attachmentOrphans.path)
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: { count: 0, totalBytes: 0, items: [] } })
    expect(listSpy).not.toHaveBeenCalled()
  })

  it('GET /attachment-orphans：只报无引用对象（活动会话与回收站目录的引用保留）', async () => {
    const made = orphanDeps()
    const base = await start(made.deps)
    const { status, body } = await call(base, ROUTES.attachmentOrphans.path)
    expect(status).toBe(200)
    expect(body).toEqual({
      ok: true,
      value: { count: 1, totalBytes: 30, items: [{ attachmentId: ID3, bytes: 30 }] },
    })
    expect(made.fs.removeFile).not.toHaveBeenCalled()
  })

  it('GET /attachment-orphans：预览清单默认最多 200 条，数量与字节按全量', async () => {
    const names = Array.from({ length: 205 }, (_, i) => i.toString(16).padStart(64, '0'))
    const made = makeDeps()
    made.fs.listDirs.mockImplementation(async (p: string) => {
      if (p === OBJECTS) return ['00']
      return []
    })
    made.fs.listFiles.mockImplementation(async (p: string) =>
      p === `${OBJECTS}/00` ? names : [])
    made.fs.statFile.mockResolvedValue({ size: 1 })
    const base = await start(made.deps)
    const { status, body } = await call(base, ROUTES.attachmentOrphans.path)
    expect(status).toBe(200)
    const value = body.value as { count: number; totalBytes: number; items: unknown[] }
    expect(value.count).toBe(205)
    expect(value.totalBytes).toBe(205)
    expect(value.items).toHaveLength(200)
  })

  it('GET /attachment-orphans：预览条数取配置（ADR-0037）', async () => {
    const names = Array.from({ length: 5 }, (_, i) => i.toString(16).padStart(64, '0'))
    const made = makeDeps({ config: { ...DEFAULT_CONFIG, orphanPreviewLimit: 2 } })
    made.fs.listDirs.mockImplementation(async (p: string) => (p === OBJECTS ? ['00'] : []))
    made.fs.listFiles.mockImplementation(async (p: string) => (p === `${OBJECTS}/00` ? names : []))
    made.fs.statFile.mockResolvedValue({ size: 1 })
    const base = await start(made.deps)
    const { status, body } = await call(base, ROUTES.attachmentOrphans.path)
    expect(status).toBe(200)
    const value = body.value as { count: number; totalBytes: number; items: unknown[] }
    expect(value.count).toBe(5)
    expect(value.totalBytes).toBe(5)
    expect(value.items).toHaveLength(2)
  })

  it('GET /attachment-orphans：引用源读不出 ⇒ 200 + sessiondelete/io（不冒充空报告）', async () => {
    const made = orphanDeps({ unreadable: true })
    const base = await start(made.deps)
    const failure = await failureOf(base, ROUTES.attachmentOrphans.path)
    expect(failure.status).toBe(200)
    expect(failure.code).toBe('sessiondelete/io')
    expect(failure.message).toMatch(/无法判定孤儿/)
    expect(failure.message).toMatch(/没有可读的会话日志/)
  })

  // 报告是纯读：链被对账占住时照样立刻回（与 /orphans、/ping 同一条豁免）。
  it('GET /attachment-orphans 不进到达序链', async () => {
    const made = orphanDeps()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let first = true
    made.fs.listDirs.mockImplementation(async (p: string) => {
      // 第一趟 `/list` 的对账卡在回收站根上；报告自己也读这一层，但只挡第一趟。
      if (p === '/h/session-trash' && first) {
        first = false
        await gate
      }
      if (p === '/h/sessions') return ['--p--']
      if (p === '/h/sessions/--p--') return ['session-active']
      if (p === '/h/session-trash') return ['20260101T000000Z-session-trashed']
      if (p === OBJECTS) return ['aa', 'bb', 'cc']
      return []
    })
    const base = await start(made.deps)
    const listPromise = call(base, ROUTES.list.path)
    await vi.waitFor(() => { expect(made.fs.listDirs).toHaveBeenCalledWith('/h/session-trash') })
    const report = await call(base, ROUTES.attachmentOrphans.path)
    expect(report.body).toEqual({
      ok: true,
      value: { count: 1, totalBytes: 30, items: [{ attachmentId: ID3, bytes: 30 }] },
    })
    release()
    await listPromise
  })

  it('POST /attachment-clean：只删无引用图片，回 {removed,freedBytes,failed}', async () => {
    const made = orphanDeps()
    const base = await start(made.deps)
    const { status, body } = await call(base, ROUTES.attachmentClean.path, { method: 'POST' })
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: { removed: 1, freedBytes: 30, failed: 0 } })
    expect(made.fs.removeFile).toHaveBeenCalledTimes(1)
    expect(made.fs.removeFile).toHaveBeenCalledWith(imagePath(ID3))
    expect(made.fs.removeFile).not.toHaveBeenCalledWith(imagePath(ID))
    expect(made.fs.removeFile).not.toHaveBeenCalledWith(imagePath(ID2))
  })

  it('POST /attachment-clean：引用源读不出 ⇒ 零删 + skipped（不是零条假回执）', async () => {
    const made = orphanDeps({ unreadable: true })
    const base = await start(made.deps)
    const { status, body } = await call(base, ROUTES.attachmentClean.path, { method: 'POST' })
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, value: { removed: 0, freedBytes: 0, failed: 0 } })
    expect((body.value as { skipped?: string }).skipped).toMatch(/无法判定孤儿/)
    expect(made.fs.removeFile).not.toHaveBeenCalled()
  })
})
