/**
 * 线上形状的**一条事实一个家**（ADR-0003）。
 *
 * 这一份钉的不是行为，是**形状**：加一个字段、少一个字段、在两个地方各写一份，都要在这里红。
 * 为什么值得单独一份：形状漂移在运行期是静默的（多发一个键没人读、少发一个键界面上半句消失），
 * 只有类型层与键集比对能当场抓住它。
 */
import { describe, expect, it } from 'vitest'
import { toWire } from '../src/api/trash-rows.js'
import { REQUIRED_ENTRY_FIELDS, type TrashEntry } from '../src/trash/entry.js'
import {
  ROUTE_CODES,
  SESSION_DELETE_CODES,
  SESSION_DELETE_ERROR_DOMAIN,
  TRASH_DIR_LABEL,
  TRASH_DIR_NAME,
  VERB_CODES,
  type TrashRowWire,
} from '../src/shared/wire.js'
import type { PurgeResultLike, TrashDetailLike, TrashEntryLike } from '../src/client/remote.js'
import type { PurgeStatsWire, TrashDetailWire } from '../src/shared/wire.js'

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
    const wire = toWire(ENTRY)
    // 清册那八格 + `releaseBytes`（必填：存储侧的"这一次会释放多少"，见 ADR-0003）
    expect(Object.keys(wire).sort()).toEqual([...Object.keys(ENTRY), 'releaseBytes'].sort())
    expect(wire.releaseBytes).toBe(ENTRY.sizeBytes) // 没有孩子、没有盘上后代 ⇒ 就是它自己那一格
    // 其余只读数一格都不出现：缺席 ≠ 0，界面上不许拿 0 冒充"没有"
    expect(Object.keys(wire)).not.toContain('subagentCount')
    expect(Object.keys(wire)).not.toContain('strandedBytes')
    expect(wire).not.toHaveProperty('parentEntryId')
  })

  it('`releaseBytes` 是唯一算式：本行 + 孩子 + 盘上后代（浏览器半不再各算一遍）', () => {
    const wire = toWire(ENTRY, { subagentCount: 2, subagentBytes: 4096, strandedSubagents: 1, strandedBytes: 1024 })
    expect(wire.releaseBytes).toBe(ENTRY.sizeBytes + 4096 + 1024)
  })

  it('只读数与 `parentEntryId` 在场时才过线，值原样带走', () => {
    const wire = toWire({ ...ENTRY, parentEntryId: 'root-id' }, {
      subagentCount: 2,
      subagentBytes: 4096,
      strandedSubagents: 1,
      strandedBytes: 1024,
      workspaceMissing: true,
    })
    expect(wire).toMatchObject({
      parentEntryId: 'root-id',
      subagentCount: 2,
      subagentBytes: 4096,
      strandedSubagents: 1,
      strandedBytes: 1024,
      workspaceMissing: true,
    })
  })

  it('投影的产物就是 `TrashRowWire`（类型层，加字段时编译不过）', () => {
    const wire: TrashRowWire = toWire(ENTRY)
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
