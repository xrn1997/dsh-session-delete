// Node 半路由层（`/dsh-session-delete-api`）——**薄线**的那一半
//
// 照本机既有插件的做法：分发器是**纯构造器**（`createApiHandler(deps)`），不依赖 Cordis，
// 用**真 `node:http` server** 承载（Node 原生 req/res 语义不替身），所以这一层可以单测到位。
//
// 钉住的是**契约**，不是实现细节：
//  ① 六个段名各自的方法 + 形状（GET list、GET ping、POST detail、POST apply＝一组 id 一个动作、
//    POST empty＝清空、GET orphans＝无主子会话扫描）；
//  ② 信封就是浏览器半消费的那个形状
//  （`{ok:true,value}` / `{ok:false,error:{code,message,details?}}`）；③ 码只从那五个里出、且失败的
//  **原文**进 `error.message`；④ 路由层自检（未知路径 / 方法不对 / body 不对）不静默吞；
//  ⑤ 取数通道的**同源栅栏**：跨源请求拒掉，且拒之前一个副作用都不发生。
import http from 'node:http'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiHandler } from '../src/api/dispatch.js'
import { PARAMS, ROUTES, SESSION_DELETE_API_PREFIX, type ApplyOutcome } from '../src/shared/wire.js'
import { makeEntryId, sessionDirOf, trashDirOf, type TrashEntry } from '../src/trash/entry.js'
import type { DeleteDeps } from '../src/verbs/delete-session.js'
import { restoreSession } from '../src/verbs/restore-session.js'
import { createFakeDeps } from './support/fake-deps.js'

const HOME = '/h'
const NOW = Date.UTC(2026, 8, 30, 13, 5, 0)

/** 条目 id 一律由 `makeEntryId` 产出（`恢复` 动词按 id 反推原目录名）⇒ 夹具照真实形状造，
 *  不拿 `'a'` 这种手写串冒充。 */
const entryIdOf = (sessionDirName: string) => makeEntryId(NOW, sessionDirName)
const entry = (sessionDirName: string, over: Partial<TrashEntry> = {}): TrashEntry => ({
  id: entryIdOf(sessionDirName), sessionId: sessionDirName, projectDir: '--p--', workspaceId: 'ws-1',
  wasArchived: false, deletedAt: 1,
  title: '', sizeBytes: 0, ...over,
})

/**
 * 六个段名的假依赖：动词要什么给什么——**真动词 + 真清单端口**，只有宿主与文件系统是替身
 * （`tests/support/fake-deps.ts` 里那第二个 adapter）。
 * 替身暴露出来是为了让每条用例只翻自己那一格，而不必重建整副依赖，也不必强转到 `DeleteDeps`。
 *
 * `listDirs` 按种子（`over.seed`）给：`list` 现在**先对账再读**（`reconcileTrash`），
 * "清单里有行而回收站根下空空"的世界会被对账当场摘空——那是不一致的世界（真实里行与目录成对出现），
 * 所以这里让二者默认一致；要测漂移的用例自己翻 `listDirs` / `readFile`。
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
} = {}) {
  const seed = over.seed ?? []
  const made = createFakeDeps({
    seed,
    now: NOW,
    live: over.live ?? false,
    // 计数与"盘上后代"两个口共用 `members`：给了 `subagents` 就按它构造等长成员，否则按成员数推（与宿主同口径）。
    counts: over.subagents,
    members: over.members ?? {},
    workspaceExists: over.workspaceExists ?? true,
    fs: {
      exists: true,
      size: 224 * 1024,
      // 回收站详情要在条目目录里挑日志；`*.jsonl.zstd` 是 `pickSessionLog` 认得出的一代。
      files: ['session.v4.jsonl.zstd'],
      // `list` 现在**先对账再读**：清单里有行而回收站根下空空的世界不一致（真实里行与目录成对出现），
      // 所以默认让二者一致；要测漂移的用例自己翻 `listDirs` / `readFile`。
      dirs: seed.map((e) => e.id),
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

/** 起真 http server（127.0.0.1:0）承载分发器——与宿主把我们的 handler 挂进前缀路由同形。 */
async function start(deps: DeleteDeps, mountPrefix = true): Promise<string> {
  const handler = createApiHandler(deps)
  const server = http.createServer((req, res) => {
    void handler(req, res).catch(() => { /* 分发器内部已写错误信封，这里只兜底 */ })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(() => new Promise((resolve) => server.close(() => resolve())))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}${mountPrefix ? SESSION_DELETE_API_PREFIX : ''}`
}

interface CallInit { method?: string; body?: unknown; headers?: Record<string, string> }

/** 一次调用 → 解析出的信封（HTTP 状态一并带出，因为路由层自检要看它）。 */
async function call(base: string, path: string, init: CallInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? init.headers : { 'content-type': 'application/json', ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
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
  expect(outcomes[0]!.ok).toBe(false)
  const error = outcomes[0]!.error as { code: string; message: string }
  expect(error.code.startsWith('sessiondelete/')).toBe(true)
  return { code: error.code, message: error.message }
}

/**
 * 原生 `http.request` 形态的一次调用。**栅栏用例必须用它**：`Origin` / `Referer` 在 Fetch 规范里
 * 是 forbidden header name，`fetch()` 传了也会被丢掉——那样测出来的就是"没有 Origin"那条放行支。
 */
/** 一次 `POST /apply` 的 body：动作 + 一组 id。 */
function applyBody(action: string, ids: string[]) {
  return JSON.stringify({ [PARAMS.action]: action, [PARAMS.ids]: ids })
}

function rawCall(
  base: string, path: string, method: string, headers: Record<string, string>, body?: string,
): Promise<{ status: number; text: string }> {
  const url = new URL(`${base}${path}`)
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method, headers },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

describe('路由层 · 段名契约（/apply 一段管所有动作，2026-10-17）', () => {
  it('GET /list 回信封 {ok:true,value}，值就是清单（最近删除在前）', async () => {
    const { deps } = makeDeps({ seed: [entry('a', { deletedAt: 100 }), entry('b', { deletedAt: 200 })] })
    const base = await start(deps)
    const { status, body } = await call(base, ROUTES.list)
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
        [trashDirOf(kids[0]!.id, HOME)]: 500,
        [trashDirOf(kids[1]!.id, HOME)]: 300,
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
    const { body } = await call(base, ROUTES.list)
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
    const rows = (await call(base, ROUTES.list)).body.value as Array<TrashEntry & { subagentBytes?: number; releaseBytes: number }>
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
    const rows = (await call(base, ROUTES.list)).body.value as Array<{ releaseBytes: number }>
    expect(rows).toHaveLength(1)
    const { body } = await call(base, ROUTES.apply, {
      method: 'POST', body: { [PARAMS.action]: 'purge', [PARAMS.ids]: [parent.id] },
    })
    const outcome = (body.value as Array<{ ok: true; value: { removed: number; freedBytes: number } }>)[0]!
    // 删掉的三份目录：父 + 孩子 + 盘上后代；释放量与清单那一行同一个数。
    expect(outcome.value).toEqual({ removed: 3, freedBytes: rows[0]!.releaseBytes })
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
    const rows = (await call(base, ROUTES.list)).body.value as Array<{ releaseBytes: number }>
    const listedTotal = rows.reduce((total, row) => total + row.releaseBytes, 0)
    const { body } = await call(base, ROUTES.empty, { method: 'POST', body: {} })
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
    await call(base, ROUTES.list)
    expect(host.isLive).not.toHaveBeenCalled()
  })

  it('盘上没有剩 ⇒ 不出现 strandedSubagents（界面上那半句也不该有）', async () => {
    const parent = entry('session-parent')
    const kid = entry('session-kidA', { parentEntryId: parent.id, sizeBytes: 700 })
    const { deps } = makeDeps({ seed: [parent, kid], subagents: {} })
    const base = await start(deps)
    const { body } = await call(base, ROUTES.list)
    const rows = body.value as Array<TrashEntry & { subagentCount?: number; strandedSubagents?: number }>
    expect(rows[0]).toMatchObject({ subagentCount: 1 })
    expect(rows[0]!.strandedSubagents).toBeUndefined()
  })

  it('宿主记录还在、目录已经不在 ⇒ 不算盘上残留（count 与 bytes 同一条存在性判据）', async () => {
    const parent = entry('session-parent')
    const { deps, fs, host } = makeDeps({
      seed: [parent],
      members: { 'session-parent': [{ sessionId: 'session-kid', projectDir: '--p--' }] },
    })
    fs.exists.mockImplementation(async (...args: unknown[]) => !String(args[0]).endsWith('session-kid'))
    const base = await start(deps)
    const { body } = await call(base, ROUTES.list)
    const rows = body.value as Array<TrashEntry & { strandedSubagents?: number; strandedBytes?: number }>
    expect(host.subagentMembersOf).toHaveBeenCalled()
    expect(rows[0]!.strandedSubagents).toBeUndefined()
    expect(rows[0]!.strandedBytes).toBeUndefined()
  })

  // ADR-0006 第六处行为差异：`releaseBytes` 改念盘上实测之后，某条可见行的目录读不了（非 ENOENT）
  // 会让整个清单读失败——迁移前这一格只念清册、不碰盘，那些世界照样列得出清单。回执形状钉在信封上。
  it('/list 某条行目录读不了（EACCES）⇒ 200 + io，不拿 0 冒充「它会释放多少」', async () => {
    const row = entry('a')
    const { deps, fs } = makeDeps({ seed: [row] })
    const dir = trashDirOf(row.id, HOME)
    fs.sizeOfDir.mockImplementation(async (path: string) => {
      if (path === dir) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      return 0
    })
    const base = await start(deps)
    const failure = await failureOf(base, ROUTES.list)
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
    const { body } = await call(base, ROUTES.list)
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
    const goneRows = (await call(goneBase, ROUTES.list)).body.value as Array<TrashEntry & { workspaceMissing?: boolean }>
    expect(goneRows[0]).toMatchObject({ workspaceMissing: true })
    expect(gone.host.workspaceExists).toHaveBeenCalledWith('ws-1')

    const alive = makeDeps({ seed: [entry('a')] })
    const aliveBase = await start(alive.deps)
    const aliveRows = (await call(aliveBase, ROUTES.list)).body.value as Array<TrashEntry & { workspaceMissing?: boolean }>
    expect(aliveRows[0]!.workspaceMissing).toBeUndefined()
  })

  it('未分组条目（workspaceId 空串）不去问账本，也不带 workspaceMissing', async () => {
    const { deps, host } = makeDeps({ seed: [entry('a', { workspaceId: '' })] })
    const base = await start(deps)
    const rows = (await call(base, ROUTES.list)).body.value as Array<TrashEntry & { workspaceMissing?: boolean }>
    expect(host.workspaceExists).not.toHaveBeenCalled()
    expect(rows[0]!.workspaceMissing).toBeUndefined()
  })

  // 孩子折进父行是"父行在"的前提下才成立。父行不见了（手工摘的、清册半损的、对账把它当外人摘掉的），
  // 孩子**必须自己站出来占一行**——否则那一条既看不见也清不掉，正是我们一直在躲的"点不到的行"。
  it('父行不在 ⇒ 孩子自己占一行，不许隐形', async () => {
    const orphan = entry('session-kidA', { parentEntryId: '20260930T130500Z-session-nope' })
    const { deps } = makeDeps({ seed: [orphan] })
    const base = await start(deps)
    const { body } = await call(base, ROUTES.list)
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
    const { body } = await call(base, ROUTES.list)
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
    await call(base, ROUTES.list)
    const stored = await manifest.list()
    expect(stored).toEqual(seed)
    expect(JSON.stringify(stored)).not.toContain('subagentCount')
  })

  // 删除确认框要说「含 N 个子会话，将一起移入回收站」（issue #3）⇒ 那个数必须在**删除之前**问得到。
  // 2026-10-17 批量重构后它挂在 `/apply` 的 `count` 上（一条一段退役了），纯读豁免跟着一起搬。
  it('apply count 交回这条会话在盘上的后代数（确认框删除前取一次数）', async () => {
    const { deps, host } = makeDeps({ subagents: { 'session-parent': 3 } })
    const base = await start(deps)
    const { status, body } = await call(base, ROUTES.apply, {
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
    const { body } = await call(base, ROUTES.apply, {
      method: 'POST', body: { [PARAMS.action]: 'count', [PARAMS.ids]: ['session-none'] },
    })
    expect(body).toEqual({ ok: true, value: [{ id: 'session-none', action: 'count', ok: true, value: 0 }] })
  })

  it('apply delete 拿一组 sessionId 走删除动词，回移入回收站的那一条', async () => {
    const { deps, manifest, host } = makeDeps()
    const base = await start(deps)
    const { status, body } = await call(base, ROUTES.apply, {
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
    const { status, body } = await call(base, ROUTES.apply, {
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
    const single = await call(oneBase, ROUTES.apply, {
      method: 'POST', body: { [PARAMS.action]: 'purge', [PARAMS.ids]: [entryIdOf('a')] },
    })
    expect((single.body.value as Array<Record<string, unknown>>)[0]).toMatchObject({ ok: true, value: { removed: 1, freedBytes: 224 * 1024 } })
    expect((await one.manifest.list()).map((e) => e.id)).toEqual([entryIdOf('b')])

    const all = makeDeps({ seed: two() })
    const allBase = await start(all.deps)
    const cleared = await call(allBase, ROUTES.empty, { method: 'POST', body: {} })
    expect(cleared.body).toMatchObject({ ok: true, value: { removed: 2, freedBytes: 448 * 1024 } })
    expect(await all.manifest.list()).toEqual([])
  })
})

describe('路由层 · list 是对账 + 读（2026-10-16）', () => {
  it('目录多出一条 ⇒ 长出行（id 与项目目录从那条日志的 header 重建）', async () => {
    const ghost = entryIdOf('session-ghost')
    const { deps, fs } = makeDeps({ seed: [entry('a')] })
    fs.listDirs.mockResolvedValue([entryIdOf('a'), ghost])
    fs.readFile.mockImplementation(async (_path: string) =>
      zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', version: 4, id: 'session-ghost', createdAt: 1, cwd: 'C:/develop/p' })}\n`, 'utf8')))
    const base = await start(deps)
    const { body } = await call(base, ROUTES.list)
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
    const { body } = await call(base, ROUTES.list)
    expect(body).toMatchObject({ ok: true, value: [] })
    expect(await manifest.list()).toEqual([])
  })

  it('零漂移时不读日志（对账的读放大只发生在真漂移上）', async () => {
    const { deps, fs } = makeDeps({ seed: [entry('a')] })
    const base = await start(deps)
    const { body } = await call(base, ROUTES.list)
    expect((body.value as TrashEntry[]).map((e) => e.id)).toEqual([entryIdOf('a')])
    expect(fs.readFile).not.toHaveBeenCalled()
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
    const listPromise = call(base, ROUTES.list)
    await vi.waitFor(() => { expect(fs.listDirs).toHaveBeenCalled() })
    const deletePromise = call(base, ROUTES.apply, { method: 'POST', body: { [PARAMS.action]: 'delete', [PARAMS.ids]: ['session-abc'] } })
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
    const listPromise = call(base, ROUTES.list)
    await vi.waitFor(() => { expect(fs.listDirs).toHaveBeenCalled() })
    const count = await call(base, ROUTES.apply, { method: 'POST', body: { [PARAMS.action]: 'count', [PARAMS.ids]: ['session-parent'] } })
    expect(count.body).toEqual({ ok: true, value: [{ id: 'session-parent', action: 'count', ok: true, value: 2 }] }) // 没有等在对账后面
    release()
    await listPromise
  })
})

describe('路由层 · 失败路径（码来自 map-error，原文不吞）', () => {
  it('删一个正在跑的会话 ⇒ sessiondelete/live，且一个字节都没动', async () => {
    const { deps, manifest, fs } = makeDeps({ live: true })
    const base = await start(deps)
    const { code, message } = await failureOfOutcome(base, ROUTES.apply, { method: 'POST', body: { [PARAMS.action]: 'delete', [PARAMS.ids]: ['session-abc'] } })
    expect(code).toBe('sessiondelete/live')
    expect(message).toContain('session-abc')
    expect(fs.rename).not.toHaveBeenCalled()
    expect(await manifest.list()).toEqual([])
  })

  // 「没有这一条」只在**真正没被同批带走**时响亮报错；被同批前一条带走的 id 才是幂等 no-op。
  // 幽灵 id（整批开始前就不在清册）必须报 `trash-empty`，不许被"已被带走"粉饰成成功。
  it('恢复一条不在清单里的 id ⇒ 单条动词响亮抛 trash-empty（与混合批里被带走的幂等 no-op 是两件事）', async () => {
    const { deps } = makeDeps()
    await expect(restoreSession(deps)('ghost')).rejects.toThrow(/ghost/)
  })

  it('恢复时原项目目录没了 ⇒ sessiondelete/project-missing（不静默建目录）', async () => {
    const { deps, fs } = makeDeps({ seed: [entry('a')] })
    // 清单在、回收站目录也在，唯独 sessions 根不在
    fs.exists.mockImplementation(async (path: string) => path !== `${HOME}/sessions`)
    const base = await start(deps)
    const { code } = await failureOfOutcome(base, ROUTES.apply, { method: 'POST', body: { [PARAMS.action]: 'restore', [PARAMS.ids]: [entryIdOf('a')] } })
    expect(code).toBe('sessiondelete/project-missing')
    expect(fs.rename).not.toHaveBeenCalled()
  })

  it('删一条不在账本里的会话 ⇒ sessiondelete/not-found', async () => {
    const { deps, host } = makeDeps()
    host.projectDirOf.mockResolvedValue(undefined)
    const base = await start(deps)
    const { code } = await failureOfOutcome(base, ROUTES.apply, { method: 'POST', body: { [PARAMS.action]: 'delete', [PARAMS.ids]: ['ghost'] } })
    expect(code).toBe('sessiondelete/not-found')
  })

  it('彻底删除一条不存在的 entryId ⇒ sessiondelete/trash-empty（幂等只留给"被同批前一条带走"，不粉饰幽灵 id）', async () => {
    const { deps, fs } = makeDeps({ seed: [entry('a')] })
    const base = await start(deps)
    const { code } = await failureOfOutcome(base, ROUTES.apply, { method: 'POST', body: { [PARAMS.action]: 'purge', [PARAMS.ids]: ['ghost'] } })
    expect(code).toBe('sessiondelete/trash-empty')
    expect(fs.removeDir).not.toHaveBeenCalled()
  })

  it('list 的域层故障也过同一张映射表 ⇒ sessiondelete/io，原文带出', async () => {
    const { deps, manifest } = makeDeps()
    manifest.list = async () => { throw new Error('domain xrn1997_session_delete_trash is already open') }
    const base = await start(deps)
    const { code, message } = await failureOf(base, ROUTES.list)
    expect(code).toBe('sessiondelete/io')
    expect(message).toContain('already open')
  })
})

describe('路由层 · 自检（不静默吞）', () => {
  it('路由自检有自己的 HTTP 状态：方法不对 405、未知路径 404，信封照带原文（2026-10-17 错误面对齐）', async () => {
    const { deps } = makeDeps()
    const base = await start(deps)
    const wrongMethod = await call(base, ROUTES.apply)
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.body.ok).toBe(false)
    const unknown = await call(base, '/nope')
    expect(unknown.status).toBe(404)
    expect((unknown.body.error as { message: string }).message).toMatch(/未知路由/)
  })

  it('方法不对：GET /apply 不在 list 那条道上', async () => {
    const { deps } = makeDeps()
    const base = await start(deps)
    const { message } = await failureOf(base, ROUTES.apply)
    expect(message).toMatch(/方法不允许/)
  })

  it('未知路径：前缀本身、未知段、前缀外的请求都回错误信封，绝不假装成功', async () => {
    const { deps } = makeDeps()
    const base = await start(deps)
    expect((await failureOf(base, '')).message).toMatch(/未知路由/)
    expect((await failureOf(base, '/nope')).message).toMatch(/未知路由/)
    // 卸载前缀（宿主之外直接打到 handler 的路径）同样按未知路由处理
    const bare = await start(deps, false)
    expect((await failureOf(bare, '/outside')).message).toMatch(/未知路由/)
  })

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
      const { status, message } = await failureOf(base, ROUTES.apply, { method: 'POST', body })
      expect(message, JSON.stringify(body)).toMatch(/动作|ids/)
      // 请求本身不对 ⇒ 自己的 4xx。**操作**失败才是 200 + 信封（那条口径见下面 `/detail` 读不到那条）。
      expect(status, JSON.stringify(body)).toBe(400)
    }
    expect((await failureOf(base, ROUTES.detail, { method: 'POST', body: {} })).status).toBe(400)

    const res = await fetch(`${base}${ROUTES.apply}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    })
    expect(res.status).toBe(400)
    expect((await res.json() as { ok: boolean }).ok).toBe(false)
  })
})

describe('路由层 · 同源栅栏', () => {
  // 栅栏不认段名也不认动作：这里钉的是 `/apply` 那**一段**（写口），形状与退役前的四条一段一致。
  const body = applyBody('delete', ['session-abc'])
  const json = { 'content-type': 'application/json' }

  it('跨源的 Origin（无 Referer 也会带）被挡在门外：403，且一个副作用都不发生', async () => {
    const { deps, manifest, fs } = makeDeps()
    const base = await start(deps)
    const res = await rawCall(base, ROUTES.apply, 'POST', { ...json, origin: 'https://evil.example' }, body)
    expect(res.status).toBe(403)
    expect(fs.rename).not.toHaveBeenCalled()
    expect(await manifest.list()).toEqual([])
  })

  it('跨源的 Referer 同样被挡', async () => {
    const { deps } = makeDeps()
    const base = await start(deps)
    const res = await rawCall(base, ROUTES.apply, 'POST', { ...json, referer: 'https://evil.example/x' }, body)
    expect(res.status).toBe(403)
  })

  it('同源（Origin / Referer 与 Host 同源）放行；两者都缺席（curl 形态）也放行', async () => {
    const { deps, manifest } = makeDeps()
    const base = await start(deps)
    const host = new URL(base).host
    const sameOrigin = await rawCall(base, ROUTES.apply, 'POST', { ...json, origin: `http://${host}`, referer: `http://${host}/` }, body)
    expect(sameOrigin.status).toBe(200)
    expect(JSON.parse(sameOrigin.text)).toMatchObject({ ok: true })
    expect((await manifest.list()).length).toBe(1)

    const bare = await rawCall(base, ROUTES.apply, 'POST', json, applyBody('delete', ['session-xyz']))
    expect(bare.status).toBe(200)
    expect((await manifest.list()).length).toBe(2)
  })

  // 桌面壳那条路（asar `/lib/main.js`）：渲染进程从 `dsh-app://app/` 加载，页面里对非静态路径的
  // 请求由 `protocol.handle("dsh-app")` 转给宿主，转之前它**摘掉 `origin`**（并换成宿主 cookie）。
  // 所以桌面版的请求到了我们这里既没有 Origin、Referer 也不是 http 同源——栅栏必须认得这个形状，
  // 否则真机上探测永远 403、所有入口一个都不出现（而 headless Edge 直连 http 的过门读数看不出来）。
  it('桌面壳转发的形态（Origin 被摘掉、Referer 是 dsh-app://app/）放行', async () => {
    const { deps, manifest } = makeDeps()
    const base = await start(deps)
    const res = await rawCall(base, ROUTES.apply, 'POST', { ...json, referer: 'dsh-app://app/' }, body)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.text)).toMatchObject({ ok: true })
    expect((await manifest.list()).length).toBe(1)
  })

  it('挂着 dsh-app 前缀但不是桌面壳那个 origin 的 Referer 照样挡（别把它写成前缀匹配）', async () => {
    const { deps, manifest } = makeDeps()
    const base = await start(deps)
    const res = await rawCall(base, ROUTES.apply, 'POST', { ...json, referer: 'dsh-app://app.evil/' }, body)
    expect(res.status).toBe(403)
    expect(await manifest.list()).toEqual([])
  })
})

describe('POST /detail（回收站单条详情，2026-10-15）', () => {
  const seed = [entry('session-a', { title: '有标题', sizeBytes: 4096 })]
  const json = { 'content-type': 'application/json' }

  it('清册里有这一条 ⇒ 成功信封，值就是 detail 的形状（不回灌清册字段）', async () => {
    const { deps } = makeDeps({ seed })
    const base = await start(deps)
    const { status, body: envelope } = await call(base, ROUTES.detail, {
      method: 'POST',
      body: { [PARAMS.entryId]: entryIdOf('session-a') },
    })
    expect(status).toBe(200)
    expect(envelope.ok).toBe(true)
    expect(envelope.value as Record<string, unknown>).toMatchObject({
      entryId: entryIdOf('session-a'), cwd: 'C:/p', createdAt: 1, messages: [],
    })
    // 清册已有的字段不上线：清单里的大小与详情里的大小必须是同一个数
    expect(Object.keys(envelope.value as object)).not.toContain('sizeBytes')
    expect(Object.keys(envelope.value as object)).not.toContain('deletedAt')
  })

  it('entryId 不在清册 ⇒ trash-empty，且一次文件读都不做', async () => {
    const { deps, fs } = makeDeps({ seed })
    const base = await start(deps)
    const { status, code } = await failureOf(base, ROUTES.detail, { method: 'POST', body: { [PARAMS.entryId]: 'nope' } })
    expect(status).toBe(200) // 操作失败 ⇒ 200 + 信封；4xx 只留给请求本身不对
    expect(code).toBe('sessiondelete/trash-empty')
    expect(fs.readFile).not.toHaveBeenCalled()
  })

  it('目录里没有会话日志 ⇒ io，原文说的是哪个目录里有什么', async () => {
    const { deps } = makeDeps({ seed })
    ;deps.fs.listFiles = vi.fn(async () => ['notes.txt'])
    const base = await start(deps)
    const { code, message } = await failureOf(base, ROUTES.detail, { method: 'POST', body: { [PARAMS.entryId]: entryIdOf('session-a') } })
    expect(code).toBe('sessiondelete/io')
    expect(message).toMatch(/没有会话日志/)
  })

  it('路由层自检同表：GET 被拒说的是"需 POST"，body 缺/空/非串都落 io 并点名字段', async () => {
    const { deps } = makeDeps({ seed })
    const base = await start(deps)
    const wrongMethod = await failureOf(base, ROUTES.detail, { method: 'GET' })
    expect(wrongMethod.message).toMatch(/需 POST/)
    for (const bad of [{}, { [PARAMS.entryId]: '' }, { [PARAMS.entryId]: 42 }]) {
      const failure = await failureOf(base, ROUTES.detail, { method: 'POST', body: bad })
      expect(failure.code).toBe('sessiondelete/io')
      expect(failure.message).toMatch(PARAMS.entryId)
    }
  })

  it('栅栏对六个段名一视同仁（这里打的是 POST /detail）：跨源 Origin 拒 403，桌面壳的 Referer 放行', async () => {
    const { deps, fs } = makeDeps({ seed })
    const base = await start(deps)
    const payload = JSON.stringify({ [PARAMS.entryId]: entryIdOf('session-a') })
    const evil = await rawCall(base, ROUTES.detail, 'POST', { ...json, origin: 'https://evil.example' }, payload)
    expect(evil.status).toBe(403)
    expect(fs.readFile).not.toHaveBeenCalled()
    const shell = await rawCall(base, ROUTES.detail, 'POST', { ...json, referer: 'dsh-app://app/' }, payload)
    expect(shell.status).toBe(200)
    expect(JSON.parse(shell.text)).toMatchObject({ ok: true })
  })
})

/** 一次 `POST /apply`：body 自己带动作与 ids。 */
describe('路由层 · POST /apply 的自检与栅栏（一组 id 一个动作，2026-10-17）', () => {
  const json = { 'content-type': 'application/json' }
  const payload = applyBody('count', ['session-parent'])

  it('GET 被拒说的是"需 POST"，body 缺动作 / ids 不成形都落 io 并点名字段', async () => {
    const { deps } = makeDeps()
    const base = await start(deps)
    const wrongMethod = await failureOf(base, ROUTES.apply, { method: 'GET' })
    expect(wrongMethod.message).toMatch(/需 POST/)
    for (const bad of [{}, { [PARAMS.action]: 'count' }, { [PARAMS.action]: 'count', [PARAMS.ids]: '' }]) {
      const failure = await failureOf(base, ROUTES.apply, { method: 'POST', body: bad })
      expect(failure.code).toBe('sessiondelete/io')
      expect(failure.message).toMatch(/动作|ids/)
    }
  })

  it('跨源 Origin 拒 403 且一次宿主调用都不发；桌面壳的 Referer 照常放行', async () => {
    const { deps, host } = makeDeps({ subagents: { 'session-parent': 1 } })
    const base = await start(deps)
    const hostHeader = { ...json, host: new URL(base).host }
    const evil = await rawCall(base, ROUTES.apply, 'POST', { ...hostHeader, origin: 'https://evil.example' }, payload)
    expect(evil.status).toBe(403)
    expect(host.subagentMembersOf).not.toHaveBeenCalled()
    const shell = await rawCall(base, ROUTES.apply, 'POST', { ...hostHeader, referer: 'dsh-app://app/' }, payload)
    expect(shell.status).toBe(200)
    expect(JSON.parse(shell.text)).toMatchObject({ ok: true, value: [{ id: 'session-parent', action: 'count', ok: true, value: 1 }] })
  })
})

// 批量通道（2026-10-17）：写动词从「一条一段」收成 `POST /apply`——一次 HTTP 带一组 id，
// 逐条回 `ApplyOutcome`。钉的是契约：整批只读一次清单、只预取一次宿主会话表；重复 id 去重；
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
    const { status, body } = await call(base, ROUTES.apply, {
      method: 'POST',
      body: { [PARAMS.action]: 'restore', [PARAMS.ids]: [restoreId('a'), 'ghost', restoreId('b')] },
    })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    const outcomes = body.value as Array<Record<string, unknown>>
    expect(outcomes.map((o) => o.id)).toEqual([restoreId('a'), 'ghost', restoreId('b')])
    expect(outcomes[0]).toMatchObject({ ok: true, action: 'restore', value: { id: restoreId('a') } })
    expect(outcomes[1]).toMatchObject({ ok: false })
    expect((outcomes[1]!.error as { code: string }).code).toBe('sessiondelete/trash-empty')
    expect((outcomes[1]!.error as { message: string }).message).toContain('ghost')
    expect(outcomes[2]).toMatchObject({ ok: false, action: 'restore' })
    expect((outcomes[2]!.error as { code: string }).code).toBe('sessiondelete/project-missing')
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
    const { body } = await call(base, ROUTES.apply, {
      method: 'POST', body: { [PARAMS.action]: 'restore', [PARAMS.ids]: [restoreId('a'), restoreId('b')] },
    })
    const outcomes = body.value as Array<Record<string, unknown>>
    expect(outcomes[0]).toMatchObject({ ok: false })
    expect((outcomes[0]!.error as { code: string }).code).toBe('sessiondelete/trash-empty')
    expect(outcomes[1]).toMatchObject({ ok: true, value: { id: restoreId('b') } })
  })

  it('同批前一条已把后一条带走 ⇒ 后一条是幂等成功（null），不是失败', async () => {
    const parent = entry('session-p', { sessionId: 'session-p' })
    const child = entry('session-c', { sessionId: 'session-c', parentEntryId: parent.id, deletedAt: 2 })
    const { deps } = makeDeps({ seed: [child, parent] })
    const base = await start(deps)
    const { body } = await call(base, ROUTES.apply, {
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
    const { body } = await call(base, ROUTES.apply, {
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
    const { body } = await call(base, ROUTES.apply, {
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
    const { body } = await call(base, ROUTES.apply, {
      method: 'POST', body: { [PARAMS.action]: 'delete', [PARAMS.ids]: ['session-a', 'session-bad', 'session-b'] },
    })
    const outcomes = body.value as Array<Record<string, unknown>>
    expect(outcomes[0]).toMatchObject({ ok: true, value: { sessionId: 'session-a' } })
    expect(outcomes[1]).toMatchObject({ ok: false })
    expect((outcomes[1]!.error as { code: string }).code).toBe('sessiondelete/not-found')
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
    const { body } = await call(base, ROUTES.apply, {
      method: 'POST', body: { [PARAMS.action]: 'delete', [PARAMS.ids]: ['session-parent', 'session-child'] },
    })
    const outcomes = body.value as Array<Record<string, unknown>>
    expect(outcomes[0]).toMatchObject({ ok: true, value: { sessionId: 'session-parent' } })
    expect(outcomes[1]).toEqual({ id: 'session-child', action: 'delete', ok: true, value: null })
    expect(await manifest.list()).toHaveLength(2)
  })

  it('整批恢复只预取一次宿主会话表，通告走批量口', async () => {
    const seed = [entry('session-a', { sessionId: 'session-a' }), entry('session-b', { sessionId: 'session-b' })]
    const { deps, host } = makeDeps({ seed })
    host.restoredSummariesOf.mockResolvedValue([
      { sessionId: 'session-a', summary: { sessionId: 'session-a' } },
      { sessionId: 'session-b', summary: { sessionId: 'session-b' } },
    ])
    const base = await start(deps)
    await call(base, ROUTES.apply, {
      method: 'POST', body: { [PARAMS.action]: 'restore', [PARAMS.ids]: [restoreId('a'), restoreId('b')] },
    })
    expect(host.restoredSummariesOf).toHaveBeenCalledTimes(1)
    expect(host.announceRestoredBatch).toHaveBeenCalledTimes(1)
    expect(host.announceRestored).not.toHaveBeenCalled()
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
    host.restoredSummariesOf.mockResolvedValue([
      { sessionId: 'session-a', summary: { sessionId: 'session-a' } },
      { sessionId: 'session-b', summary: { sessionId: 'session-b' } },
    ])
    const base = await start(deps)
    await call(base, ROUTES.apply, {
      method: 'POST',
      body: { [PARAMS.action]: 'restore', [PARAMS.ids]: [restoreId('a'), restoreId('b')] },
    })
    expect(host.unarchive).toHaveBeenCalledTimes(2)
    expect(host.archive).not.toHaveBeenCalled()
    const announced = host.announceRestoredBatch.mock.invocationCallOrder[0]!
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
    await call(base, ROUTES.apply, {
      method: 'POST', body: { [PARAMS.action]: 'restore', [PARAMS.ids]: [restoreId('a')] },
    })
    expect(host.announceRestoredBatch).toHaveBeenCalledTimes(1)
    const announced = host.announceRestoredBatch.mock.calls[0]?.[0]
    expect([...announced].sort()).toEqual(['session-a', 'session-kid'])
  })
})

// 无主子会话维护（2026-10-19）：父被彻底删掉之后，它的 subagent 孩子还留在 `sessions/` 里，
// 而宿主的客户端把 `origin:"subagent"` 整排藏了 ⇒ 这一坨字节既看不见也清不掉。
// 扫描是**纯读**（不占到达序链、一个字都不动），清理是**写动作**（上链，且点之前先对账）。
describe('路由层 · GET /orphans 与 apply orphan-clean（无主子会话，2026-10-19）', () => {
  const corpus = () => [
    { sessionId: 'session-root', parentSessionId: 'session-gone', projectDir: '--p--', subagent: true },
    { sessionId: 'session-kid', parentSessionId: 'session-root', projectDir: '--p--', subagent: false },
  ]

  it('GET /orphans 是纯读：交回闭包总数、字节、项目分组；不删任何东西', async () => {
    const { deps, fs, host, manifest } = makeDeps()
    host.listSessions = vi.fn(async () => ({ available: true as const, value: corpus() }))
    const base = await start(deps)
    const { status, body } = await call(base, ROUTES.orphans)
    expect(status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      value: {
        roots: ['session-root'], totalSessions: 2, totalBytes: 448 * 1024, missingParents: 1,
        groups: [{ projectDir: '--p--', sessions: 2, bytes: 448 * 1024 }],
      },
    })
    expect(fs.removeDir).not.toHaveBeenCalled()
    expect(await manifest.list()).toEqual([])
  })

  // 语料面缺席 ≠ "这个家没有孤儿"。回一份 `roots: []` 的空报告会让界面说一句"没有要清理的"，
  // 而盘上真躺着几百 MB ⇒ 必须是 `io` 信封（Task 2 在动词层立的判据，这里钉它能过桥到线上）。
  it('GET /orphans 的 sessionQuery 缺席 ⇒ io 信封，不冒充空报告', async () => {
    const { deps } = makeDeps()
    const base = await start(deps)
    const failure = await failureOf(base, ROUTES.orphans)
    // **操作**读不到 ⇒ 200 + 信封（404 是"这条路由不存在"，那是另一件事，见上面 POST 那条）
    expect(failure.status).toBe(200)
    expect(failure.code).toBe('sessiondelete/io')
  })

  // 第六个段名是**读**段：不留第二条写路径——清理只有 `POST /apply` 的 `orphan-clean` 这一条路。
  it('POST /orphans 不是写动作 ⇒ 405', async () => {
    const { deps } = makeDeps()
    const base = await start(deps)
    const { status } = await call(base, ROUTES.orphans, { method: 'POST', body: {} })
    expect(status).toBe(405)
  })

  it('POST /apply orphan-clean：按根清闭包，回逐根字节与条数', async () => {
    const { deps, host, fs } = makeDeps()
    host.listSessions = vi.fn(async () => ({ available: true as const, value: corpus() }))
    const base = await start(deps)
    const { body } = await call(base, ROUTES.apply, { method: 'POST', body: { [PARAMS.action]: 'orphan-clean', [PARAMS.ids]: ['session-root'] } })
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
    const { body } = await call(base, ROUTES.apply, { method: 'POST', body: { [PARAMS.action]: 'orphan-clean', [PARAMS.ids]: ['root'] } })
    expect((body.value as ApplyOutcome[])[0]).toMatchObject({
      id: 'root', action: 'orphan-clean', ok: true, value: { removed: 2, freedBytes: 448 * 1024 },
    })
  })

  it('POST /apply orphan-clean：会话语料缺席 ⇒ 顶层 io 信封，不回零条假回执', async () => {
    const { deps, fs } = makeDeps()
    const base = await start(deps)
    const failure = await failureOf(base, ROUTES.apply, {
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
    const { body } = await call(base, ROUTES.apply, {
      method: 'POST', body: { [PARAMS.action]: 'orphan-clean', [PARAMS.ids]: ['session-root'] },
    })
    const outcome = (body.value as ApplyOutcome[])[0]!
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
    const failure = await failureOfOutcome(base, ROUTES.apply, {
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
    const failure = await failureOfOutcome(base, ROUTES.apply, {
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
    const listPromise = call(base, ROUTES.list)
    await vi.waitFor(() => { expect(fs.listDirs).toHaveBeenCalled() })
    const scanned = await call(base, ROUTES.orphans)
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
    const listPromise = call(base, ROUTES.list)
    await vi.waitFor(() => { expect(fs.listDirs).toHaveBeenCalled() })
    const cleanPromise = call(base, ROUTES.apply, {
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
    const { status, body } = await call(base, ROUTES.ping)
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
    const listPromise = call(base, ROUTES.list)
    await vi.waitFor(() => { expect(fs.listDirs).toHaveBeenCalled() })
    const ping = await call(base, ROUTES.ping)
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
    const { status, body } = await call(base, ROUTES.empty, { method: 'POST', body: {} })
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
    const { body } = await call(base, ROUTES.empty, { method: 'POST', body: {} })
    expect(body.ok).toBe(true)
    expect(fs.removeDir).toHaveBeenCalledWith(`/h/session-trash/${id}`)
    expect(await manifest.list()).toEqual([])
  })
})
