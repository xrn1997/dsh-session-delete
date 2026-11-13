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
  isDSHRemoteError,
  isRemoteResult,
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
