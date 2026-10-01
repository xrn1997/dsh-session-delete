import { describe, expect, it } from 'vitest'
import { makeEntryId, parseEntryId, sessionDirOf, trashDirOf } from '../src/trash/entry.js'
import type { TrashEntry } from '../src/trash/entry.js'

const HOME = 'C:/Users/x/.dsh'

describe('条目命名', () => {
  it('id = 可排序时间戳 + 原目录名，原目录名原样保留（v4 带 session- 前缀）', () => {
    const id = makeEntryId(Date.UTC(2026, 8, 30, 13, 5, 0), 'session-f13e7fa3-b827-888a225c45fb')
    expect(id).toBe('20260930T130500Z-session-f13e7fa3-b827-888a225c45fb')
    expect(parseEntryId(id).sessionDirName).toBe('session-f13e7fa3-b827-888a225c45fb')
    // 时间戳要真的解回删除时刻（面板按它排序/显示），不是夹带 NaN 混过去
    expect(parseEntryId(id).deletedAt).toBe(Date.UTC(2026, 8, 30, 13, 5, 0))
  })

  it('v3 目录名无前缀，同样原样保留', () => {
    const id = makeEntryId(Date.UTC(2026, 8, 30, 13, 5, 0), '02b60f41-c2dd-4595-b76f-528e40ae044e')
    expect(parseEntryId(id).sessionDirName).toBe('02b60f41-c2dd-4595-b76f-528e40ae044e')
  })

  it('不是本函数产出的 id 一律抛错，不返回半截结果', () => {
    for (const bad of ['', 'nope', '20260930T130500Z', '2026-09-30T13:05:00Z-session-abc']) {
      expect(() => parseEntryId(bad)).toThrow(/bad entry id/)
    }
  })

  it('路径：本体在 sessions/<项目>/<原目录名>，回收站在 session-trash/<id>', () => {
    expect(sessionDirOf('--C-develop-GitHub-dsh-ebook--', 'session-abc', HOME))
      .toBe('C:/Users/x/.dsh/sessions/--C-develop-GitHub-dsh-ebook--/session-abc')
    expect(trashDirOf('20260930T130500Z-session-abc', HOME))
      .toBe('C:/Users/x/.dsh/session-trash/20260930T130500Z-session-abc')
  })
})

/** 夹具标注 `TrashEntry`：字段缺一个 `pnpm typecheck` 即红（这里是**类型层面**的约束）。
 *  title / sizeBytes 的运行时契约钉在 `tests/manifest.test.ts` 的 `add`/`list` 上。
 *  最后一条往返断言是**产品契约**：`恢复` 走的就是 `parseEntryId(entry.id).sessionDirName`
 *  与这里的 `deletedAt`（见 `src/verbs/restore-session.ts`），所以 id 编码坏了会真红。 */
const base: TrashEntry = {
  id: makeEntryId(Date.UTC(2026, 8, 30, 13, 5, 0), 'session-abc'),
  sessionId: 'abc',
  projectDir: '--C-develop-GitHub-dsh-ebook--',
  workspaceId: 'ws-1',
  wasArchived: false,
  deletedAt: Date.UTC(2026, 8, 30, 13, 5, 0),
  title: '会话标题',
  sizeBytes: 4096,
}

describe('条目形状', () => {
  it('id 编码的时间戳与记录里的 deletedAt 自洽（往返）', () => {
    expect(parseEntryId(base.id).deletedAt).toBe(base.deletedAt)
  })
})
