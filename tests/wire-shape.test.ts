/**
 * 线上形状的**一条事实一个家**（ADR-0003）。
 *
 * 这一份钉的不是行为，是**形状**：加一个字段、少一个字段、在两个地方各写一份，都要在这里红。
 * 为什么值得单独一份：形状漂移在运行期是静默的（多发一个键没人读、少发一个键界面上半句消失），
 * 只有类型层与键集比对能当场抓住它。
 */
import { describe, expect, it } from 'vitest'
import { toWire } from '../src/api/trash-rows.js'
import { bodyOf } from '../src/api/route-table.js'
import { REQUIRED_ENTRY_FIELDS, type TrashEntry } from '../src/trash/entry.js'
import {
  BODY_GROUPS,
  PARAMS,
  ROUTE_CODES,
  ROUTES,
  SESSION_DELETE_CODES,
  SESSION_DELETE_ERROR_DOMAIN,
  TRASH_DIR_LABEL,
  TRASH_DIR_NAME,
  VERB_CODES,
  WIRE_VALUE_GUARDS,
  WRITE_PROGRESS_STEPS,
  isDSHRemoteError,
  isRemoteResult,
  isWriteProgressWire,
  type TrashRowWire,
} from '../src/shared/wire.js'
import type { PurgeResultLike, TrashDetailLike, TrashEntryLike } from '../src/client/remote.js'
import type {
  ArchiveDetailWire,
  ArchiveSubagentWire,
  ArchiveListWire,
  ArchiveRowWire,
  AttachmentCleanupWire,
  AttachmentOrphanReportWire,
  PurgeStatsWire,
  SessionDetailWire,
  TrashDetailAttachmentWire,
  TrashDetailWire,
} from '../src/shared/wire.js'

/** 两个类型**完全相等**（不是"互相可赋值"）——多一个或漏一个字段都会让它变成 false。 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** 一份完整的清册行（`TrashEntry` 的必填字段一格不少；`satisfies` 让接口加字段时这里编译不过）。 */
const ENTRY = {
  id: '20261019T120000Z-session-a',
  sessionId: 'session-a',
  projectDir: '--p--',
  workspaceId: 'ws-1',
  wasArchived: false,
  deletedAt: 1_760_000_000_000,
  title: '会话标题',
  sizeBytes: 224 * 1024,
} satisfies Required<Omit<TrashEntry, 'parentEntryId'>>

describe('清册的落地形状与线上形状', () => {
  it('必填字段清单与 TrashEntry 的必填键集逐格一致（接口加了字段而清单没跟 ⇒ 这里红）', () => {
    expect(Object.keys(REQUIRED_ENTRY_FIELDS).sort()).toEqual(Object.keys(ENTRY).sort())
  })

  it('必填字段清单的类型表与字段同源（`string` / `number` / `boolean` 三档）', () => {
    for (const [field, kind] of Object.entries(REQUIRED_ENTRY_FIELDS)) {
      expect(typeof (ENTRY as Record<string, unknown>)[field], `${field} 应是 ${kind}`).toBe(kind)
    }
  })

  it('投影只发线上形状里那几格：清册八格 + releaseBytes，可选的那几格缺席就是缺席', () => {
    const wire = toWire(ENTRY, { releaseBytes: 4096 })
    // 清册那八格 + `releaseBytes`（必填：计划实测的"这一次会释放多少"，见 ADR-0003）
    expect(Object.keys(wire).sort()).toEqual([...Object.keys(ENTRY), 'releaseBytes'].sort())
    expect(wire.releaseBytes).toBe(4096) // 原样带走：算式住计划，不在这里
    // 其余只读数一格都不出现：缺席 ≠ 0，界面上不许拿 0 冒充"没有"
    expect(Object.keys(wire)).not.toContain('subagentCount')
    expect(Object.keys(wire)).not.toContain('strandedBytes')
    expect(wire).not.toHaveProperty('parentEntryId')
  })

  it('`releaseBytes` 是必填读数列、原样带走：toWire 不再自己算式（口径只住计划）', () => {
    const wire = toWire(ENTRY, {
      releaseBytes: 12_345,
      subagentCount: 2,
      subagentBytes: 4096,
      strandedSubagents: 1,
      strandedBytes: 1024,
    })
    // 不是 `sizeBytes + 4096 + 1024`：实测口径（含目录存在性）住 `planVisibleTrash`，投影只搬运。
    expect(wire.releaseBytes).toBe(12_345)
  })

  it('`releaseBytes` 在 readouts 里是必填：不传编译不过（没有 0 缺省）', () => {
    // @ts-expect-error releaseBytes 是计划算好的那一格：缺席 = 没算过，不许拿 0 冒充
    const missing: Parameters<typeof toWire>[1] = {}
    expect(missing).toEqual({})
  })

  it('只读数与 `parentEntryId` 在场时才过线，值原样带走', () => {
    const wire = toWire({ ...ENTRY, parentEntryId: 'root-id' }, {
      releaseBytes: 2048,
      subagentCount: 2,
      subagentBytes: 4096,
      strandedSubagents: 1,
      strandedBytes: 1024,
      workspaceMissing: true,
    })
    expect(wire).toMatchObject({
      parentEntryId: 'root-id',
      releaseBytes: 2048,
      subagentCount: 2,
      subagentBytes: 4096,
      strandedSubagents: 1,
      strandedBytes: 1024,
      workspaceMissing: true,
    })
  })

  it('投影的产物就是 `TrashRowWire`（类型层，加字段时编译不过）', () => {
    const wire: TrashRowWire = toWire(ENTRY, { releaseBytes: ENTRY.sizeBytes })
    // 反向也要成立：`TrashRowWire` 的每一格都是投影会填的（或可选缺席的）
    const back: Parameters<typeof toWire>[0] = ENTRY
    expect(wire.id).toBe(back.id)
  })
})

describe('两半共用同一份形状（不是两份互相镜像）', () => {
  it('浏览器半的条目/回执/详情都是 wire 的别名，不是重写的接口', () => {
    // 这三个断言是**类型层**的：谁再抄一份接口，Exact 变成 false，编译不过。
    const entryMirror: Exact<TrashEntryLike, TrashRowWire> = true
    const purgeMirror: Exact<PurgeResultLike, PurgeStatsWire> = true
    const detailMirror: Exact<TrashDetailLike, TrashDetailWire> = true
    expect([entryMirror, purgeMirror, detailMirror]).toEqual([true, true, true])
  })

  it('详情块的附件字段是必填数组；附件统计是可选字段', () => {
    const block: TrashDetailWire['blocks'][number] = {
      kind: 'user', id: '0', time: 1, text: '', truncated: false, attachments: [],
    }
    const purge: PurgeStatsWire = { removed: 1, freedBytes: 2, attachments: { removed: 1, freedBytes: 2, failed: 0 } }
    expect(block.attachments).toEqual([])
    expect(purge.attachments?.failed).toBe(0)
  })

  it('附件读数的线上形状：图像段可选名字/类型/尺寸，文件段必有名字，清理回执可带跳过原因', () => {
    const image: TrashDetailAttachmentWire = {
      attachmentId: `sha256:${'a'.repeat(64)}`, kind: 'image', name: 'x.png', mediaType: 'image/png',
      bytes: 3, width: 1, height: 2,
    }
    const file: TrashDetailAttachmentWire = {
      attachmentId: `sha256:${'b'.repeat(64)}`, kind: 'file', name: 'x.txt', bytes: 3,
    }
    const cleanup: AttachmentCleanupWire = { removed: 1, freedBytes: 2, failed: 0, skipped: '日志不完整' }
    expect([image.kind, file.kind, cleanup.skipped]).toEqual(['image', 'file', '日志不完整'])
  })

  it('孤儿附件报告只有两格：数量与总字节（不把对象名单发上线）', () => {
    const report: AttachmentOrphanReportWire = {
      count: 1,
      totalBytes: 4096,
      items: [{ attachmentId: `sha256:${'a'.repeat(64)}`, bytes: 4096 }],
    }
    expect(Object.keys(report).sort()).toEqual(['count', 'items', 'totalBytes'])
    expect(report).toEqual({
      count: 1,
      totalBytes: 4096,
      items: [{ attachmentId: `sha256:${'a'.repeat(64)}`, bytes: 4096 }],
    })
  })

  it('归档三形状的键集与 ADR-0060 / wire 契约一致（缺席字段不造 0）', () => {
    const full: ArchiveRowWire = {
      sessionId: 'session-a', projectDir: '--p--', title: '标题', label: '子任务名',
      updatedAt: 1, updatedAtSource: 'prompt', sizeBytes: 10, subagent: false,
    }
    expect(Object.keys(full).sort()).toEqual(
      ['label', 'projectDir', 'sessionId', 'sizeBytes', 'subagent', 'title', 'updatedAt', 'updatedAtSource'].sort())
    // 缺席 = 键不在：sizeBytes / label 都不许拿 0 或空串冒充「有读数」。
    const sparse: ArchiveRowWire = {
      sessionId: 'session-b', projectDir: '--p--', title: '', updatedAt: 2, updatedAtSource: 'created', subagent: true,
    }
    expect(Object.keys(sparse)).not.toContain('sizeBytes')
    expect(Object.keys(sparse)).not.toContain('label')
    const list: ArchiveListWire = { available: true, rows: [full], totalBytes: 10, missingSizeCount: 0 }
    expect(Object.keys(list).sort()).toEqual(['available', 'missingSizeCount', 'rows', 'totalBytes'].sort())
    const detail: ArchiveDetailWire = {
      sessionId: 'session-a', archived: true, cwd: 'C:/p', createdAt: 1, lastActivity: 2, logTitle: '', models: [],
      turnCount: 0, userMessageCount: 0, assistantMessageCount: 0, toolCallCount: 0, injectedCount: 0,
      blocks: [], olderCursor: null,
    }
    // 归档详情 = 基座 + sessionId + 可选子会话三件；没有清册身份格。
    const base: SessionDetailWire = detail
    expect(base.createdAt).toBe(1)
    expect(Object.keys(detail)).not.toContain('entryId')
    const child: ArchiveSubagentWire = {
      sessionId: 'kid-1', archived: false, projectDir: '--p--', title: '孩子一', label: '子任务名',
      updatedAt: 1, updatedAtSource: 'prompt', sizeBytes: 10,
    }
    expect(Object.keys(child).sort()).toEqual(
      ['archived', 'label', 'projectDir', 'sessionId', 'sizeBytes', 'title', 'updatedAt', 'updatedAtSource'].sort())
    const withKids: ArchiveDetailWire = {
      ...detail,
      subagents: [child],
      subagentsTotal: 2,
      subagentsSizeBytes: 10,
    }
    expect(withKids.subagents?.[0]?.sessionId).toBe('kid-1')
    expect(withKids.subagentsTotal).toBe(2)
    expect(withKids.subagentsSizeBytes).toBe(10)
  })
})

describe('响应信封的运行期判形（isRemoteResult）', () => {
  // 中间层（反代 / SPA 兜底）会回非信封 JSON：判形不过就该走「回的不是信封」诊断，
  // 而不是把垃圾喂给 `requestOutcome` 的信封解析炸出 TypeError / "undefined"（issue #8 第 1 条）。
  it('非信封一律判 false：空对象、ok 非布尔、两臂缺格、error 是字符串或 null、数组、null', () => {
    expect(isRemoteResult({})).toBe(false)
    expect(isRemoteResult({ ok: 'yes' })).toBe(false)
    expect(isRemoteResult({ ok: true })).toBe(false)
    expect(isRemoteResult({ ok: false })).toBe(false)
    expect(isRemoteResult({ ok: false, error: null })).toBe(false)
    expect(isRemoteResult({ ok: false, error: 'boom' })).toBe(false)
    expect(isRemoteResult({ ok: false, error: { message: 'm' } })).toBe(false)
    expect(isRemoteResult({ ok: false, error: { code: 1, message: 'm' } })).toBe(false)
    expect(isRemoteResult([])).toBe(false)
    expect(isRemoteResult(null)).toBe(false)
    expect(isRemoteResult('ok')).toBe(false)
  })

  it('合法信封两臂都放行：value 任意（含 null），error 是带 string code/message 的对象', () => {
    expect(isRemoteResult({ ok: true, value: null })).toBe(true)
    expect(isRemoteResult({ ok: true, value: 1 })).toBe(true)
    expect(isRemoteResult({ ok: true, value: [{ id: 'a' }] })).toBe(true)
    expect(isRemoteResult({ ok: false, error: { code: 'sessiondelete/io', message: 'm' } })).toBe(true)
  })
})

describe('段名表 `ROUTES` 是结构化常量（路径 / 方法 / 请求体形状各一格，ADR-0004 就地订正后的家）', () => {
  // 一条 wire 事实（某段的 path + method + body）只住这一张表；键集漂了（多一格、少一格、
  // 某段退化回纯字符串）两半的投影就会静默分叉——这类漂移运行期不报错，只有键集比对抓得住。
  it('每项恰有 path / method / body 三键，且 path 以 / 开头、body 是字段组描述的键', () => {
    for (const [name, seg] of Object.entries(ROUTES)) {
      expect(`${name}:${Object.keys(seg).sort().join('+')}`).toBe(`${name}:body+method+path`)
      expect(`${name}:${seg.path.startsWith('/')}`).toBe(`${name}:true`)
      // 「body 在册」的判据是字段组描述本身的键集：不在 `BODY_GROUPS` 里有格子的 body 值，
      // 就是没有字段描述的空名——不另抄一份 body 名单（`Record<RouteBody, …>` 的类型闸同管这条）。
      expect(`${name}:${Object.hasOwn(BODY_GROUPS, seg.body)}`).toBe(`${name}:true`)
    }
  })

  // `body` 与方法是**同一件事的两格**：带 JSON 字段的段只能是 POST（GET 不带体），查询串段只能是
  // GET。这条配对是浏览器半唯一读得见的判据（它只投影 path / method，请求字段由 interface 签名决定），
  // 配对漂了就意味着某一格的投影不再描述真实线上形状。「哪一格带 JSON 字段」的判据是 `bodyOf`
  // （预读判定的家），不在这里抄一份 body 名单。
  it('body 与方法配对：JSON 字段段是 POST，GET 段不预读 JSON，查询串段是 GET', () => {
    for (const [name, seg] of Object.entries(ROUTES)) {
      const carriesJson = bodyOf(seg) === 'json'
      if (carriesJson) expect(`${name}:${seg.method}`, '带 JSON 字段的段必须是 POST').toBe(`${name}:POST`)
      if (seg.method === 'GET') expect(`${name}:${bodyOf(seg)}`, 'GET 段不带 JSON 字段').toBe(`${name}:none`)
      if (seg.body === 'query') expect(`${name}:${seg.method}`, '查询串段必须是 GET').toBe(`${name}:GET`)
    }
  })

  // 「有字段 ⇒ 必须预读」是 `BODY_KIND` 的派生判据：带字段的组在 `BODY_KIND` 里填 `none`，
  // 请求体就永远不预读、字段闸静默失效，而没有任何一条用例会红。`config` 是唯一例外：
  // 组是空的（三只旋钮由 Standard Schema 自校验），但它仍是 json 段。
  it('有字段的组必然预读 JSON；config 是「空组但 json」的唯一例外', () => {
    for (const [name, seg] of Object.entries(ROUTES)) {
      const fields = Object.keys(BODY_GROUPS[seg.body]).length
      if (fields > 0) expect(`${name}:${bodyOf(seg)}`, '有字段的组必须预读 JSON').toBe(`${name}:json`)
    }
    const configSegs = Object.entries(ROUTES).filter(([, seg]) => seg.body === 'config')
    expect(configSegs.length).toBeGreaterThan(0)
    expect(Object.keys(BODY_GROUPS.config)).toEqual([])
    for (const [name, seg] of configSegs) expect(`${name}:${bodyOf(seg)}`).toBe(`${name}:json`)
  })

  // 字段组描述是线上形状的一部分（浏览器半的 interface 签名按它写）：键名字面量只许出 `PARAMS`，
  // 组里另写一个字符串就是第二份键名，两半会在改名时各走各的。种类不在运行期验——`BodyGroup`
  // 的类型闸把每格收窄成五种 kind，写错种类编译不过。
  it('字段组描述：每组的字段键都是 `PARAMS` 的成员', () => {
    const paramNames = new Set<string>(Object.values(PARAMS))
    for (const [name, group] of Object.entries(BODY_GROUPS)) {
      for (const field of Object.keys(group)) {
        expect(`${name}:${paramNames.has(field)}`, `${name} 组的字段 ${field} 应是 PARAMS 的成员`).toBe(`${name}:true`)
      }
    }
  })
})

describe('失败的运行期判别（isDSHRemoteError）', () => {
  // 消费这一判别的是 Node 半（`src/remote/map-error.ts` 的 `toRemoteFailure`）：浏览器半不抛失败、
  // 也不补标记，所以判别按它自己的家测，不挂在某一端的用例文件里。
  it('官方标记位才认失败；普通 {code,message} 对象不算', () => {
    expect(isDSHRemoteError(Object.assign(new Error('x'), { code: 'sessiondelete/io', isDSHRemoteError: true }))).toBe(true)
    // 这正是上一版自造鸭子判别的地方：普通 `{code, message}`（不是官方 RemoteError 实例）不认。
    expect(isDSHRemoteError({ code: 'sessiondelete/io', message: 'x' })).toBe(false)
    expect(isDSHRemoteError({ isDSHRemoteError: true })).toBe(false)
    expect(isDSHRemoteError(new Error('x'))).toBe(false)
    expect(isDSHRemoteError(null)).toBe(false)
    expect(isDSHRemoteError('sessiondelete/io')).toBe(false)
  })
})

describe('线上值的轻量判形（WIRE_VALUE_GUARDS）', () => {
  // 浏览器半在用成功信封之前问一次形状：形状漂移（少一格、对象回成数组）不许喂给渲染层。
  // 这里钉两件事：**表跟段名表逐段对齐**（加 JSON 段必须补一格），以及判形本身只认
  // 「数组 / 对象 / 必备字段」这一层（合法最小形状放行、缺必备格拒绝）。

  /** 齐全的详情基座（判形要的必填格，两档共用）。 */
  const DETAIL_VALUE = {
    cwd: 'C:/p',
    createdAt: 1,
    lastActivity: 2,
    logTitle: '',
    models: [] as string[],
    turnCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    toolCallCount: 0,
    injectedCount: 0,
    blocks: [] as unknown[],
    olderCursor: null as number | null,
  }

  /** 每个 JSON 段一份**合法最小值**（可选字段一律缺席：判形不该逼着可选出线）。 */
  const VALID_VALUES: Record<string, unknown> = {
    list: [{ ...ENTRY, releaseBytes: 1 }],
    ping: 'pong',
    config: { orphanPreviewLimit: 1, maxAttachmentBytes: 1, maxJsonRefBytes: 1 },
    detail: { ...DETAIL_VALUE, entryId: 'entry-a' },
    apply: [{ id: 'session-a', action: 'restore', ok: true, value: null }],
    empty: { removed: 0, freedBytes: 0 },
    orphans: { roots: [], totalSessions: 0, totalBytes: 0, missingParents: 0, groups: [] },
    attachmentOrphans: { count: 0, totalBytes: 0, items: [] },
    attachmentClean: { removed: 0, freedBytes: 0, failed: 0 },
    projectionOrphans: { count: 0 },
    projectionClean: { removed: 0, failed: 0 },
    archiveList: { available: false },
    archiveDetail: { ...DETAIL_VALUE, sessionId: 'session-a', archived: true },
    progress: { status: 'idle' },
  }

  const guardsOf = (): Record<string, (value: unknown) => boolean> => WIRE_VALUE_GUARDS

  it('表与段名表逐段对齐：JSON 段每段一格，二进制段 `attachment` 不进表', () => {
    const jsonRoutes = Object.keys(ROUTES).filter((name) => name !== 'attachment').sort()
    expect(Object.keys(WIRE_VALUE_GUARDS).sort()).toEqual(jsonRoutes)
    // 合法最小值全部放行（判形不拿可选字段当必填）。
    for (const [name, value] of Object.entries(VALID_VALUES)) {
      expect(`${name}:${guardsOf()[name]?.(value) === true}`, `${name} 应放行合法值`).toBe(`${name}:true`)
    }
  })

  it('缺必备格 / 类型不对 / 把行集回成对象或 null：一律拒绝', () => {
    const invalid: Record<string, unknown> = {
      list: [{ id: 'a' }],
      ping: 1,
      config: {},
      detail: { entryId: 'entry-a' },
      apply: [{ id: 'session-a', action: 'restore', ok: true, value: { id: 'session-a' } }],
      empty: { removed: 0 },
      orphans: { roots: [] },
      attachmentOrphans: { count: 0 },
      attachmentClean: { removed: 0, freedBytes: 0 },
      projectionOrphans: {},
      projectionClean: { removed: 0 },
      archiveList: { available: true, rows: [{}] },
      archiveDetail: { ...DETAIL_VALUE, sessionId: 'session-a' },
      progress: { status: 'running' },
    }
    for (const [name, value] of Object.entries(invalid)) {
      expect(`${name}:${guardsOf()[name]?.(value) === true}`, `${name} 应拒绝不合法值`).toBe(`${name}:false`)
    }
    expect(WIRE_VALUE_GUARDS.list(null)).toBe(false)
    expect(WIRE_VALUE_GUARDS.detail([])).toBe(false)
  })

  it('`apply` 的成功值按动作校形：null 幂等只属于 delete / restore；失败支要带 code + message', () => {
    const outcome = (action: string, value: unknown): unknown => ({ id: 'e1', action, ok: true, value })
    expect(WIRE_VALUE_GUARDS.apply([outcome('delete', null)])).toBe(true)
    expect(WIRE_VALUE_GUARDS.apply([outcome('restore', null)])).toBe(true)
    expect(WIRE_VALUE_GUARDS.apply([outcome('count', 3)])).toBe(true)
    expect(WIRE_VALUE_GUARDS.apply([outcome('unarchive', 1)])).toBe(true)
    expect(WIRE_VALUE_GUARDS.apply([outcome('purge', { removed: 1, freedBytes: 2 })])).toBe(true)
    expect(WIRE_VALUE_GUARDS.apply([outcome('orphan-clean', { removed: 1, freedBytes: 2 })])).toBe(true)

    // 解构联合：null 只允许在两个幂等动作上；`count` 不能回对象；purge 不能回 null。
    expect(WIRE_VALUE_GUARDS.apply([outcome('delete', { id: 'e1' })])).toBe(false)
    expect(WIRE_VALUE_GUARDS.apply([outcome('count', {})])).toBe(false)
    expect(WIRE_VALUE_GUARDS.apply([outcome('purge', null)])).toBe(false)
    expect(WIRE_VALUE_GUARDS.apply([outcome('不存在的动作', 1)])).toBe(false)
    // 失败支：信封对但 error 只有一半 ⇒ 拒绝。
    expect(WIRE_VALUE_GUARDS.apply([{ id: 'e1', action: 'restore', ok: false, error: { code: 'x' } }])).toBe(false)
    expect(WIRE_VALUE_GUARDS.apply([{ id: 'e1', action: 'restore', ok: false, error: { code: 'x', message: 'm' } }])).toBe(true)
  })

  it('详情块按判别键校：未知 kind、缺正文格、附件不是数组都拒绝', () => {
    const block = (over: Record<string, unknown>): unknown => ({
      kind: 'user', id: '0', time: 0, text: '', truncated: false, attachments: [], ...over,
    })
    const withBlock = (value: unknown): unknown => ({ ...DETAIL_VALUE, entryId: 'entry-a', blocks: [value] })
    expect(WIRE_VALUE_GUARDS.detail(withBlock(block({})))).toBe(true)
    expect(WIRE_VALUE_GUARDS.detail(withBlock(block({ kind: 'nope' })))).toBe(false)
    expect(WIRE_VALUE_GUARDS.detail(withBlock(block({ text: undefined })))).toBe(false)
    expect(WIRE_VALUE_GUARDS.detail(withBlock(block({ attachments: 'x' })))).toBe(false)
    expect(WIRE_VALUE_GUARDS.detail(withBlock(block({
      kind: 'tool', callId: 'c', name: 'n', status: 'ok', args: '', result: '',
      argsTruncated: false, resultTruncated: false,
    })))).toBe(true)
  })
})

describe('写入进度的判形（isWriteProgressWire）', () => {
  // 进度形状不走 `/apply` 值那套 schema DSL：它是遥测快照，判形与 `list`/`ping` 同法手写。
  // 表里那一格就是这枚谓词（浏览器半判形只问 `WIRE_VALUE_GUARDS`），钉住别名防止两处各长各的。
  const RUNNING = {
    status: 'running',
    action: 'purge',
    ids: ['a', 'b'],
    done: 1,
    total: 2,
    step: 'deleting',
    startedAt: 1_760_000_000_000,
  }

  it('idle 与 running 两臂的完整形状都放行；表里那一格就是这枚谓词', () => {
    expect(isWriteProgressWire({ status: 'idle' })).toBe(true)
    expect(isWriteProgressWire(RUNNING)).toBe(true)
    expect(WIRE_VALUE_GUARDS.progress).toBe(isWriteProgressWire)
  })

  it('缺 ids、step 不在 WRITE_PROGRESS_STEPS、status:running 却没有 done 都回 false', () => {
    expect(isWriteProgressWire({ ...RUNNING, ids: undefined })).toBe(false)
    // 在册的每个 step 都放行（名单与判形同源），名单外的一律拒。
    for (const step of WRITE_PROGRESS_STEPS) {
      expect(isWriteProgressWire({ ...RUNNING, step })).toBe(true)
    }
    expect(isWriteProgressWire({ ...RUNNING, step: 'nope' })).toBe(false)
    expect(isWriteProgressWire({ ...RUNNING, done: undefined })).toBe(false)
  })

  it('计数必须是安全非负整数且 done 不越过 total，起点时间必须是非负安全整数', () => {
    const invalid = [
      { done: -1 },
      { done: 0.5 },
      { total: -1 },
      { total: 1.5 },
      { done: 3 },
      { done: Number.MAX_SAFE_INTEGER + 1 },
      { total: Number.MAX_SAFE_INTEGER + 1 },
      { startedAt: -1 },
      { startedAt: 0.5 },
      { startedAt: Number.MAX_SAFE_INTEGER + 1 },
    ]
    for (const patch of invalid) {
      expect(isWriteProgressWire({ ...RUNNING, ...patch }), JSON.stringify(patch)).toBe(false)
    }
    expect(isWriteProgressWire({ ...RUNNING, done: 0, total: 0, startedAt: 0 })).toBe(true)
  })

  // `resuming` 不在册：步骤码→动作点的映射表里没有「冷 resume」这个动作点（ADR-0008 的冷 resume 归宿主
  // 按需自己做，动词不碰）——码只表达动作点，不给既有事实挪造第二个名字；这是未发布契约的收窄。
  it('步骤码名单收窄：resuming 不在册（映射表没有它的动作点）', () => {
    expect(WRITE_PROGRESS_STEPS).not.toContain('resuming')
  })
})

describe('失败码与回收站目录名', () => {
  it('每个动词码与路由自检码都有完整码，且都在本插件的域里', () => {
    for (const code of [...VERB_CODES, ...ROUTE_CODES]) {
      expect(SESSION_DELETE_CODES[code]).toBe(`${SESSION_DELETE_ERROR_DOMAIN}/${code}`)
    }
  })

  it('完整码的表不多不少：键集就是两个后缀表的并集', () => {
    expect(Object.keys(SESSION_DELETE_CODES).sort()).toEqual([...VERB_CODES, ...ROUTE_CODES].sort())
  })

  it('回收站目录名的两版同源（Node 半拼路径、浏览器半念文案用的是同一处）', () => {
    expect(TRASH_DIR_LABEL).toBe(`${TRASH_DIR_NAME}/`)
    expect(TRASH_DIR_NAME).toBe('session-trash')
  })
})
