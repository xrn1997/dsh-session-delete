# 宿主会话列表批量删除（第十三批）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在宿主会话列表的行尾悬停排加勾选开关 + 浮条，勾 N 条一次 `POST /apply` 移入回收站，配批量确认框与批量撤销横幅（含部分失败的原地重试）。

**Architecture:** 纯浏览器半。选中集住模块级 store（`useSyncExternalStore`，与 `delete-confirm.tsx` / `undo-toast.tsx` 的现场同款）；三条新槽位贡献——`sidebar.workspaces.session.row.action` 的勾选开关、`shell.overlay` 的浮条与批量确认框。执行复用现成的 `/apply` 批量面（`applyOutcomes`），**Node 半零改动**；单删三件（菜单行 / 单删确认框 / 单删撤销横幅）一行不动。

**Tech Stack:** React 18 + TypeScript；vitest（node / jsdom 两个 project）+ @testing-library/react；样式只用 `--dsw-*` token；图标几何逐字抄官方。

**Spec:** `docs/design/2026-09-30-session-delete-design.md` 的 **第十三批（2026-10-17 宿主列表批量删除批）**，§7 末尾的「批量删除的四个态」指路也在那份里。本计划从那节出发，两处冲突以代码为准并回写那节。

## Global Constraints

- **Node 半零改动**：`src/api/`、`src/verbs/`、`src/shared/`、`src/ports/`、`src/trash/`、`src/log/`、`src/index.ts` 一行不动。
- **浏览器半不许 import 任何 `@deepseek-ai/*`**（type-only 也不留）；宿主侧只经本地窄镜像（`src/client/context.ts` / `src/client/remote.ts` 那条既有的窄面）。
- **可见文案只住 `src/client/copy.ts`**：`ZH` 真源 + `EN` 逐键镜像（`tests/client/copy.test.ts` 钉键集合逐字相同）；组件里只许 `t(key, params)`，不许字面量上屏。同句复用既有键，不造第二句（`dialog.hint` / `dialog.subagents` / `menu.live` / `trash.row.subagents` 照旧复用）。
- **颜色/圆角/描边只用 `--dsw-*` token**，零颜色字面量。
- **单删三件的行为与文案不动**：`delete-menu-item.tsx`、`delete-confirm.tsx` 的单条形、`undo-toast.tsx` 的单条形；既有用例必须全程绿。
- **TDD**：先写失败用例 → 跑出红 → 最小实现 → 跑绿。红检如实记进提交说明。
- **每任务收尾跑三道门**（逐个 capture，不接管道）：`npm test`、`npx tsc --noEmit`、`npm run build`，退出码全 0。
- **提交信息中文**（仓库现有风格：`feat: …` / `fix: …` / `docs: …`）。
- **文档与代码注释不写机器绝对路径**（用 `~` / `$DSH_HOME`）。
- **真机门归用户**：只交编号判据；浏览器半改动**先在带可见浏览器的隔离 home 验，再装 live**（AGENTS.md 硬约束，不许跳）。

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/client/copy.ts` | 文案字典（zh 真源 + en 镜像） | 改（+8 键） |
| `src/client/ui/icons.tsx` | 官方图标几何（逐字抄） | 改（+`IconCheckOutlineRegular`） |
| `src/client/ui/ui.css` | 控件皮肤（抄官方 + 已声明的自造） | 改（+`sd-rowaction-button`，来源表第十张） |
| `src/client/batch-select.tsx` | 选中集 store + 行勾选开关 + 浮条 + `fetchCounts` | 新建 |
| `src/client/batch-confirm.tsx` | 批量删除的现场 + 确认框 + 执行/失败/重试 | 新建 |
| `src/client/undo-toast.tsx` | 撤销横幅：加批量形（单条形不动） | 改 |
| `src/client/index.tsx` | 槽位注册（+3 条贡献）+ 头注的贡献账 | 改 |
| `tests/client/batch-select.test.tsx` | store 与行开关 | 新建 |
| `tests/client/undo-toast-batch.test.tsx` | 批量撤销横幅 | 新建 |
| `tests/client/batch-confirm.test.tsx` | 批量确认框全流程 | 新建 |
| `tests/client/batch-bar.test.tsx` | 浮条（含计数竞态） | 新建 |
| `tests/client/index.test.tsx` | 装配面：注册与端到端 | 改 |
| `docs/design/2026-09-30-session-delete-design.md` | 第十三批键表校准 + 落地后读数 | 改 |
| `AGENTS.md` | `ui.css` 自造差异的枚举（两处→三处） | 改 |

---

### Task 1: 文案键 + 对勾图标 + 行开关皮肤 + 选中集 store + `BatchPickButton`

**Files:**
- Modify: `src/client/copy.ts`（`ZH` / `EN` 各 +8 键）
- Modify: `src/client/ui/icons.tsx`（+`IconCheckOutlineRegular`）
- Modify: `src/client/ui/ui.css`（`sd-rowaction-button` 一族 + 文件头来源表第十张与自造账）
- Create: `src/client/batch-select.tsx`
- Modify: `AGENTS.md`（自造差异「两处」→「三处」）
- Modify: `docs/design/2026-09-30-session-delete-design.md`（第十三批③键表校准，见 Step 3 末）
- Test: `tests/client/batch-select.test.tsx`

**Interfaces:**

- Consumes: `./copy.js` 的 `Translate` / `zhTranslate`；`./ui/icons.js` / `./ui/Tooltip.js`（既有导出，签名不动）。
- Produces（后续任务按这些名字消费，一个字都别改）:

```ts
export interface PickItem { sessionId: string; title: string }
export function getPicks(): readonly PickItem[]
export function usePicks(): readonly PickItem[]
export function togglePick(item: PickItem): void
export function clearPicks(): void
export function shrinkPicksToFailures(failedSessionIds: readonly string[]): void
export interface BatchPickButtonProps { sessionId: string; title: string; live?: boolean; t?: Translate }
export function BatchPickButton(props: BatchPickButtonProps): ReactElement
```

语义：`getPicks()` 保持**勾选顺序**；`togglePick` 对已选的是**取消**（列表不许出现重复 id）；再选回 = 排到队尾；`shrinkPicksToFailures` 只留失败名单里的（空数组 = 全清）。

- [ ] **Step 1: 写失败用例**

`tests/client/batch-select.test.tsx`：

```tsx
// 选中集 store + 行尾勾选开关（第十三批①）
// store 是模块级现场（跨用例存活）：每个用例前清一次。
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  BatchPickButton,
  clearPicks,
  getPicks,
  shrinkPicksToFailures,
  togglePick,
} from '../../src/client/batch-select.js'

beforeEach(() => {
  clearPicks()
})

describe('选中集', () => {
  it('按勾选顺序记；对已勾的再勾一次是取消，不出现重复', () => {
    togglePick({ sessionId: 'a', title: 'A' })
    togglePick({ sessionId: 'b', title: 'B' })
    expect(getPicks().map((p) => p.sessionId)).toEqual(['a', 'b'])
    togglePick({ sessionId: 'a', title: 'A' })
    expect(getPicks().map((p) => p.sessionId)).toEqual(['b'])
    togglePick({ sessionId: 'a', title: 'A' })
    expect(getPicks().map((p) => p.sessionId)).toEqual(['b', 'a'])
  })

  it('shrinkPicksToFailures 只留失败名单；空名单 = 全清', () => {
    togglePick({ sessionId: 'a', title: 'A' })
    togglePick({ sessionId: 'b', title: 'B' })
    togglePick({ sessionId: 'c', title: 'C' })
    shrinkPicksToFailures(['c'])
    expect(getPicks().map((p) => p.sessionId)).toEqual(['c'])
    shrinkPicksToFailures([])
    expect(getPicks()).toEqual([])
  })
})

describe('行勾选开关', () => {
  it('点一下 aria-pressed 翻转，并进/出选中集', () => {
    render(<BatchPickButton sessionId="s1" title="重构日志读取代次" />)
    const button = screen.getByRole('button', { name: '勾选「重构日志读取代次」以批量删除' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(getPicks().map((p) => p.sessionId)).toEqual(['s1'])
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(getPicks()).toEqual([])
  })

  it('会话在跑时置灰点不动，悬停把原因摆出来', () => {
    render(<BatchPickButton sessionId="s" title="t" live />)
    expect(screen.getByRole('button', { name: '勾选「t」以批量删除' })).toBeDisabled()
    fireEvent.focus(screen.getByRole('button', { name: '勾选「t」以批量删除' }))
    // Tooltip 走 portal 异步渲染时用 findByText（预裁：两种写法都算过，红过再改）
    expect(await screen.findByText('会话正在运行，先停止再删除')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 跑出红**

Run: `npx vitest run tests/client/batch-select.test.tsx`
Expected: FAIL，`Cannot find module '../../src/client/batch-select.js'`（或同义的解析失败）。

- [ ] **Step 3: 最小实现**

① `src/client/copy.ts` —— 在 `ZH` 里 `menu.*` 那一族附近加（`EN` 逐键镜像，键集合不许差一个）：

```ts
  // ── 宿主列表批量删除（第十三批）──
  'batch.row.pick': '勾选「{title}」以批量删除',
  'batch.bar.count': '已选 {n} 条',
  'batch.bar.kids': '含 {k} 个子会话，跟着整组走',
  'batch.bar.clear': '清空',
  'batch.run': '移入回收站 {n} 条',
  'dialog.batch.title': '删除这些 {n} 个会话？',
  'dialog.batch.retry': '重试这 {n} 条',
  'undo.movedBatch': '{n} 条会话已移入回收站',
```

```ts
  'batch.row.pick': 'Select “{title}” for batch delete',
  'batch.bar.count': '{n} selected',
  'batch.bar.kids': '{k} subagent sessions come along',
  'batch.bar.clear': 'Clear',
  'batch.run': 'Move {n} to trash',
  'dialog.batch.title': 'Delete these {n} sessions?',
  'dialog.batch.retry': 'Retry these {n}',
  'undo.movedBatch': '{n} sessions were moved to the trash',
```

（子会话那两句**复用**既有键：行内 chip = `trash.row.subagents`，汇总句 = `dialog.subagents`；hint = `dialog.hint`；n=1 的标题 = `dialog.title`；运行中 tooltip = `menu.live`。）

② `src/client/ui/icons.tsx` —— 加官方 `IconCheckOutlineRegular`（几何逐字取自 `dsh-client-ui-primitives` 明文产物；`stroke` 图，`IconFrame` 已给 `strokeWidth={1}`）：

```tsx
/** 行尾悬停排「勾选开关」那枚对勾（官方 `IconCheckOutlineRegular`，`viewBox`/`d` 逐字）。 */
export function IconCheckOutlineRegular({ size }: IconProps): ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4"
        stroke="currentColor"
      />
    </IconFrame>
  )
}
```

③ `src/client/ui/ui.css` —— 文件头来源表加一行「2026-10-17 又加一张：`dsh-client-ui-workspace` 的 `Rows.module.css` 的 `iconButton` 那一族（行尾勾选开关的基底）」，并把「两处不是抄本」改成「**三处**不是抄本」（新增的那处写明：`.sd-rowaction-button` 的 `[aria-pressed='true']` 与 `:disabled` 两档是自造状态，官方那颗只有常态与 hover）。正文加（基底逐字抄 `Rows.module.css` 的 `iconButton` 与 `iconButton:hover`，只改类名；自造两档只用 token）：

```css
/* 行尾悬停排的勾选开关（基底逐字抄 dsh-client-ui-workspace 的 Rows.module.css 的 iconButton / iconButton:hover，
   只改类名；[aria-pressed='true'] 与 :disabled 两档是自造状态——官方那颗没有按下/禁用档，token 与回收站
   选中行同源：--dsw-alias-button-ghost-active-*）。 */
.sd-rowaction-button {
  border-radius: var(--dsw-radius-xs);
  cursor: pointer;
  width: 16px;
  height: 16px;
  color: var(--dsw-alias-label-tertiary);
  background: 0 0;
  border: none;
  flex: none;
  justify-content: center;
  align-items: center;
  padding: 0;
  display: inline-flex;
}
.sd-rowaction-button:hover {
  color: var(--dsw-alias-label-primary);
}
.sd-rowaction-button[aria-pressed='true'] {
  background: var(--dsw-alias-button-ghost-active-fill);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border);
  color: var(--dsw-alias-label-primary);
}
.sd-rowaction-button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
```

④ `AGENTS.md` —— 硬约束里 `ui.css` 那条的「文件头点名的**那两处自造**（`.sd-resizing`；行的 `[data-dsh-session-delete="trash-row"]:focus-visible`）」改成「**那三处自造**（…；行尾勾选开关 `.sd-rowaction-button` 的 `[aria-pressed='true']` / `:disabled` 两档）」。

⑤ `src/client/batch-select.tsx`：

```tsx
/**
 * 宿主列表批量删除的选择面（第十三批①）：选中集 + 行尾勾选开关。
 *
 * 选中集是**模块级现场**（本仓既有的客户端模式，见 `delete-confirm.tsx` / `undo-toast.tsx`）：
 * 勾选开关住在每行的 `sidebar.workspaces.session.row.action` 槽位里、浮条与确认框住在
 * `shell.overlay` 上——三处隔着槽位边界，只有模块级 store 能让他们看见同一份名单。
 * 状态源用 React 自带的 `useSyncExternalStore`，不引新的状态库。
 *
 * 名单只收槽位投影原样给的 `sessionId` / `displayTitle`（浏览器半不自己拼 id），**顺序 = 勾选顺序**。
 */
import { useSyncExternalStore, type ReactElement } from 'react'
import { zhTranslate, type Translate } from './copy.js'
import { IconCheckOutlineRegular } from './ui/icons.js'
import { Tooltip } from './ui/Tooltip.js'

export interface PickItem {
  /** 宿主槽位投影的会话 id，原样透给 `applyOutcomes('delete', …)`。 */
  sessionId: string
  /** 删除那一刻的会话名（投影的 `displayTitle`）：只用于文案与确认框，不参与请求。 */
  title: string
}

let picks: readonly PickItem[] = []
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const listener of listeners) listener()
}

export function getPicks(): readonly PickItem[] {
  return picks
}

export function togglePick(item: PickItem): void {
  const at = picks.findIndex((candidate) => candidate.sessionId === item.sessionId)
  picks =
    at === -1
      ? [...picks, item]
      : picks.filter((candidate) => candidate.sessionId !== item.sessionId)
  emit()
}

export function clearPicks(): void {
  if (picks.length === 0) return
  picks = []
  emit()
}

/** 执行后收缩：只留失败名单（空数组 = 全清）。成功的随通告从侧栏消失，不该留在名单里。 */
export function shrinkPicksToFailures(failedSessionIds: readonly string[]): void {
  const keep = new Set(failedSessionIds)
  picks = picks.filter((candidate) => keep.has(candidate.sessionId))
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function usePicks(): readonly PickItem[] {
  return useSyncExternalStore(subscribe, getPicks, getPicks)
}

export interface BatchPickButtonProps {
  sessionId: string
  title: string
  /** 会话在跑：置灰 + 悬停原因（与单删菜单行同款，级联遇在跑成员整组拒绝）。 */
  live?: boolean
  t?: Translate
}

export function BatchPickButton({
  sessionId,
  title,
  live = false,
  t = zhTranslate,
}: BatchPickButtonProps): ReactElement {
  const picks = usePicks()
  const on = picks.some((candidate) => candidate.sessionId === sessionId)
  // Tooltip 注入 ref，普通函数组件接不住 ⇒ 套一层 span（`delete-menu-item.tsx` 同款）。
  return (
    <Tooltip label={t('menu.live')} side="right" portal disabled={!live}>
      <span>
        <button
          type="button"
          className="sd-rowaction-button"
          aria-pressed={on}
          aria-label={t('batch.row.pick', { title })}
          disabled={live}
          onClick={() => togglePick({ sessionId, title })}
        >
          <IconCheckOutlineRegular size={14} />
        </button>
      </span>
    </Tooltip>
  )
}
```

⑥ `docs/design/2026-09-30-session-delete-design.md` 第十三批③键表校准：`dialog.batch.subagents` 一行删掉，改说「汇总句**复用** `dialog.subagents`」；「四个就近并入既有命名空间的键」改「**三个**（`dialog.batch.title` / `dialog.batch.retry` / `undo.movedBatch`）」。

- [ ] **Step 4: 跑绿（连同文案键集合的既有用例）**

Run: `npx vitest run tests/client/batch-select.test.tsx tests/client/copy.test.ts`
Expected: PASS，全绿。

- [ ] **Step 5: 三道门 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add src/client/copy.ts src/client/ui/icons.tsx src/client/ui/ui.css src/client/batch-select.tsx tests/client/batch-select.test.tsx AGENTS.md docs/design/2026-09-30-session-delete-design.md
git commit -m "feat: 宿主列表批量删除——勾选开关与选中集（第十三批①）"
```

---

### Task 2: 撤销横幅的批量形

**Files:**
- Modify: `src/client/undo-toast.tsx`
- Test: `tests/client/undo-toast-batch.test.tsx`

**Interfaces:**

- Consumes: 既有 `Toast` / `IconWarningOutlineRegular` / `invalidateTrash` / `callRemote`（签名不动）。
- Produces:

```ts
export type UndoToastDeps = Pick<SessionDeleteRemote, 'restore' | 'applyOutcomes'>
export function publishUndoBatchNotice(input: { entryIds: readonly string[]; n: number }): void
```

单条形 `publishUndoNotice({ entryId, title })` 与它的渲染**一个字不改**；批量形走同一个 `Toast` 宿主、同一个 `UNDO_HOLD_MS`（6000），撤销 = **一次** `applyOutcomes('restore', entryIds)`。撤销失败横幅只剩原文、没有撤销按钮（与单条同款）。

- [ ] **Step 1: 写失败用例**

`tests/client/undo-toast-batch.test.tsx`：

```tsx
// 批量撤销横幅（第十三批②）：「N 条会话已移入回收站 · 撤销」，撤销 = 一次批量 restore。
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApplyOutcome } from '../../src/client/remote.js'
import {
  UndoToast,
  clearUndoNotice,
  publishUndoBatchNotice,
} from '../../src/client/undo-toast.js'

beforeEach(() => {
  clearUndoNotice()
})

function restoreOutcomes(ids: readonly string[]): ApplyOutcome[] {
  return ids.map((id) => ({ id, action: 'restore', ok: true, value: { id: `entry-${id}` } }) as ApplyOutcome)
}

describe('批量撤销横幅', () => {
  it('报条数、撤销只发一次批量 restore', async () => {
    const applyOutcomes = vi.fn(async (_action: string, ids: readonly string[]) => restoreOutcomes(ids))
    const restore = vi.fn(async () => ({}))
    publishUndoBatchNotice({ entryIds: ['e1', 'e2'], n: 2 })
    render(<UndoToast deps={{ applyOutcomes, restore } as never} />)
    expect(screen.getByText('2 条会话已移入回收站')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() =>
      expect(applyOutcomes).toHaveBeenCalledTimes(1),
    )
    expect(applyOutcomes).toHaveBeenCalledWith('restore', ['e1', 'e2'])
    expect(restore).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('2 条会话已移入回收站')).not.toBeInTheDocument())
  })

  it('撤销失败只剩原文，不再有撤销按钮', async () => {
    const applyOutcomes = vi.fn(async () => {
      throw Object.assign(new Error('原项目目录已不在'), { code: 'sessiondelete/io' })
    })
    publishUndoBatchNotice({ entryIds: ['e1'], n: 1 })
    render(<UndoToast deps={{ applyOutcomes, restore: vi.fn() } as never} />)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(await screen.findByText(/原项目目录已不在/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 跑出红**

Run: `npx vitest run tests/client/undo-toast-batch.test.tsx`
Expected: FAIL（`publishUndoBatchNotice` 未导出 / `applyOutcomes` 不在 deps 类型上）。

- [ ] **Step 3: 实现**

`src/client/undo-toast.tsx`：通知改判别联合（`kind: 'one' | 'batch'`），单条形的字段与渲染原样保留；新增批量形与它的发布口。要点（把既有实现里对应处改写成下面的形状，别动单条支）：

```ts
export type UndoToastDeps = Pick<SessionDeleteRemote, 'restore' | 'applyOutcomes'>

export type UndoNotice = { seq: number; failure?: string } & (
  | { kind: 'one'; entryId: string; title: string }
  | { kind: 'batch'; entryIds: readonly string[]; n: number }
)

/** 删除成功后发布一条撤销提示（单条；签名与行为不动）。 */
export function publishUndoNotice(input: { entryId: string; title: string }): void {
  notice = { seq: (nextSeq += 1), kind: 'one', entryId: input.entryId, title: input.title }
  emit()
}

/** 批量删除成功后发布一条撤销提示：n = 那一次成功支的条数（含"被同批带走"的幂等条）。 */
export function publishUndoBatchNotice(input: { entryIds: readonly string[]; n: number }): void {
  notice = { seq: (nextSeq += 1), kind: 'batch', entryIds: input.entryIds, n: input.n }
  emit()
}
```

`undo` 分两支（`entryIds` 为空时批量支不发撤销按钮——没有落点的撤销是假按钮）：

```ts
async function undo(deps: UndoToastDeps, current: UndoNotice): Promise<void> {
  const outcome =
    current.kind === 'one'
      ? await callRemote(() => deps.restore(current.entryId))
      : await callRemote(() => deps.applyOutcomes('restore', current.entryIds))
  if (outcome.ok) {
    invalidateTrash()
    clearUndoNotice()
    return
  }
  notice = { ...current, seq: (nextSeq += 1), failure: outcome.failure.message }
  emit()
}
```

渲染：批量支的正文 `t('undo.movedBatch', { n: current.n })`，动作按钮只在 `kind === 'batch' ? entryIds.length > 0 : entryId !== ''` 时给；失败支（`failure !== undefined`）两形共用现有的"只出原文"那条。`key={seq}`、`holdMs={UNDO_HOLD_MS}`、`tone="success"` 照旧。

- [ ] **Step 4: 跑绿（单条那批用例必须原样绿）**

Run: `npx vitest run tests/client/undo-toast-batch.test.tsx tests/client/delete-menu-item.test.tsx`
Expected: PASS。

- [ ] **Step 5: 三道门 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add src/client/undo-toast.tsx tests/client/undo-toast-batch.test.tsx
git commit -m "feat: 撤销横幅加批量形，撤销一次批量 restore（第十三批②）"
```

---

### Task 3: 批量确认框（现场 + 执行 + 失败面 + 重试）

**Files:**
- Modify: `src/client/batch-select.tsx`（+`fetchCounts`，浮条也要用）
- Create: `src/client/batch-confirm.tsx`
- Test: `tests/client/batch-confirm.test.tsx`

**Interfaces:**

- Consumes: Task 1 的 `PickItem` / `getPicks` / `clearPicks` / `shrinkPicksToFailures`；Task 2 的 `publishUndoBatchNotice`；既有 `Modal` / `Button` / `Tag` / `callRemote` / `invalidateTrash`。
- Produces:

```ts
// batch-select.tsx 新增
export async function fetchCounts(
  deps: Pick<SessionDeleteRemote, 'applyOutcomes'>,
  ids: readonly string[],
): Promise<Map<string, number> | null>   // null = 有一条读不到 ⇒ 调用方整句不说

// batch-confirm.tsx
export interface BatchDeleteRequest { seq: number; items: readonly PickItem[] }
export function requestDeleteBatch(items?: readonly PickItem[]): void   // 缺省 = 当前选中集
export function clearDeleteBatchRequest(): void
export function useDeleteBatchRequest(): BatchDeleteRequest | null
export type BatchConfirmDeps = Pick<SessionDeleteRemote, 'applyOutcomes'>
export function BatchConfirmHost(props: { deps: BatchConfirmDeps; t?: Translate }): ReactElement | null
```

- [ ] **Step 1: 写失败用例**

`tests/client/batch-confirm.test.tsx`（假 adapter 驱动真组件，与 `delete-menu-item.test.tsx` 同款；`beforeEach` 清 `clearDeleteBatchRequest()` / `clearPicks()` / `clearUndoNotice()`）：

```tsx
// 批量删除确认框（第十三批②）：数说清自己的、失败原文落行、重试只发失败 id。
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearPicks, togglePick } from '../../src/client/batch-select.js'
import {
  BatchConfirmHost,
  clearDeleteBatchRequest,
  requestDeleteBatch,
} from '../../src/client/batch-confirm.js'
import type { ApplyOutcome } from '../../src/client/remote.js'
import { UndoToast, clearUndoNotice } from '../../src/client/undo-toast.js'

beforeEach(() => {
  clearDeleteBatchRequest()
  clearPicks()
  clearUndoNotice()
})

function countOutcomes(ids: readonly string[], kids: Record<string, number> = {}): ApplyOutcome[] {
  return ids.map((id) => ({ id, action: 'count', ok: true, value: kids[id] ?? 0 }) as ApplyOutcome)
}

function deleteOutcomes(ids: readonly string[], failIds: readonly string[] = []): ApplyOutcome[] {
  return ids.map((id) =>
    failIds.includes(id)
      ? ({ id, action: 'delete', ok: false, error: { code: 'sessiondelete/io', message: '会话目录不在盘上' } } as ApplyOutcome)
      : ({ id, action: 'delete', ok: true, value: { id: `entry-${id}` } } as ApplyOutcome),
  )
}

describe('批量确认框', () => {
  it('标题随条数：1 条是单删那句，多条是「删除这些 N 个会话？」', async () => {
    const applyOutcomes = vi.fn(async (action: string, ids: readonly string[]) =>
      action === 'count' ? countOutcomes(ids) : deleteOutcomes(ids),
    )
    requestDeleteBatch([{ sessionId: 'a', title: 'A' }])
    render(<BatchConfirmHost deps={{ applyOutcomes } as never} />)
    expect(await screen.findByRole('heading', { name: '删除这个会话？' })).toBeInTheDocument()
  })

  it('子会话两句只在有数时说：chip 有才标、汇总句 K>0 才出；读不到整句不说且主按钮照常可点', async () => {
    const applyOutcomes = vi.fn(async (_action: string, ids: readonly string[]) =>
      countOutcomes(ids, { a: 2 }),
    )
    requestDeleteBatch([
      { sessionId: 'a', title: 'A' },
      { sessionId: 'b', title: 'B' },
    ])
    render(<BatchConfirmHost deps={{ applyOutcomes } as never} />)
    expect(await screen.findByText('删除这些 2 个会话？')).toBeInTheDocument()
    expect(screen.getByText('含 2 个子会话')).toBeInTheDocument()          // a 的 chip
    expect(screen.queryByText('含 0 个子会话')).not.toBeInTheDocument()   // b 一个都没得标
    expect(screen.getByText('含 2 个子会话，将一起移入回收站。')).toBeInTheDocument()

    clearDeleteBatchRequest()
    const failing = vi.fn(async () => {
      throw Object.assign(new Error('读不到'), { code: 'sessiondelete/io' })
    })
    requestDeleteBatch([{ sessionId: 'c', title: 'C' }])
    render(<BatchConfirmHost deps={{ applyOutcomes: failing } as never} />)
    expect(await screen.findByText('删除这个会话？')).toBeInTheDocument()
    expect(screen.queryByText(/将一起移入回收站/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '移入回收站 1 条' })).toBeEnabled()
  })

  it('成功路径：一次 applyOutcomes、行收工、发批量撤销横幅、选中集清空', async () => {
    const applyOutcomes = vi.fn(async (action: string, ids: readonly string[]) =>
      action === 'count' ? countOutcomes(ids) : deleteOutcomes(ids),
    )
    togglePick({ sessionId: 'a', title: 'A' })
    togglePick({ sessionId: 'b', title: 'B' })
    requestDeleteBatch()
    render(
      <>
        <BatchConfirmHost deps={{ applyOutcomes } as never} />
        <UndoToast deps={{ applyOutcomes, restore: vi.fn() } as never} />
      </>,
    )
    fireEvent.click(await screen.findByRole('button', { name: '移入回收站 2 条' }))
    await waitFor(() => expect(screen.getByText('2 条会话已移入回收站')).toBeInTheDocument())
    expect(applyOutcomes).toHaveBeenCalledWith('delete', ['a', 'b'])
    expect(screen.queryByRole('button', { name: '移入回收站 2 条' })).not.toBeInTheDocument()
  })

  it('部分失败：原文落它自己那行、按钮变「重试这 1 条」、重试只发失败 id、选中集收缩', async () => {
    const applyOutcomes = vi.fn(async (action: string, ids: readonly string[]) =>
      action === 'count' ? countOutcomes(ids) : deleteOutcomes(ids, ['b']),
    )
    togglePick({ sessionId: 'a', title: 'A' })
    togglePick({ sessionId: 'b', title: 'B' })
    requestDeleteBatch()
    render(
      <>
        <BatchConfirmHost deps={{ applyOutcomes } as never} />
        <UndoToast deps={{ applyOutcomes, restore: vi.fn() } as never} />
      </>,
    )
    fireEvent.click(await screen.findByRole('button', { name: '移入回收站 2 条' }))
    expect(await screen.findByText(/会话目录不在盘上/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试这 1 条' })).toBeInTheDocument()
    expect(screen.getByText('1 条会话已移入回收站')).toBeInTheDocument()   // 成功那半照走
    fireEvent.click(screen.getByRole('button', { name: '重试这 1 条' }))
    await waitFor(() =>
      expect(applyOutcomes).toHaveBeenLastCalledWith('delete', ['b']),
    )
    expect(applyOutcomes).toHaveBeenCalledTimes(3)   // count 一次 + delete 两次
  })
})
```

- [ ] **Step 2: 跑出红**

Run: `npx vitest run tests/client/batch-confirm.test.tsx`
Expected: FAIL（`batch-confirm.js` 不存在）。

- [ ] **Step 3: 实现**

① `src/client/batch-select.tsx` 追加（import 区加 `callRemote` / `type SessionDeleteRemote`）：

```ts
/**
 * 一组会话的子会话计数（`/apply` 的 `action:'count'`，纯读）。
 * **一条读不到就整句返回 null**——K 是合计，缺一条就是假数；「不许拿 0 冒充没有」。
 */
export async function fetchCounts(
  deps: Pick<SessionDeleteRemote, 'applyOutcomes'>,
  ids: readonly string[],
): Promise<Map<string, number> | null> {
  if (ids.length === 0) return new Map()
  const outcome = await callRemote(() => deps.applyOutcomes('count', ids))
  if (!outcome.ok) return null
  const counts = new Map<string, number>()
  for (const item of outcome.value) {
    if (item.action !== 'count' || !item.ok) return null
    counts.set(item.id, item.value)
  }
  return counts.size === ids.length ? counts : null
}
```

② `src/client/batch-confirm.tsx`（头注要点：确认框必须住在 `shell.overlay`——菜单行/行开关随槽位卸载，理由同 `delete-confirm.tsx`；现场是模块级 + `useSyncExternalStore`）：

```tsx
/**
 * 批量删除的确认框（第十三批②）——挂在 `shell.overlay` 上的宿主，加它读的那个模块级现场。
 *
 * 与单删确认框同一套语法（`delete-confirm.tsx`）：现场只存"要删哪几条"，框自己持 busy / 失败面；
 * 失败**不关框**、原文落在它自己那一行、主按钮变「重试这 M 条」。差别只有三件：标题随条数、
 * 目标卡逐条列（有子会话才标）、执行是**一次** `applyOutcomes('delete', ids)`。
 */
import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'
import { zhTranslate, type Translate } from './copy.js'
import { clearPicks, fetchCounts, shrinkPicksToFailures, getPicks, type PickItem } from './batch-select.js'
import { callRemote, type SessionDeleteRemote } from './remote.js'
import { invalidateTrash } from './trash-store.js'
import { Button } from './ui/Button.js'
import { Modal } from './ui/Modal.js'
import { Tag } from './ui/Tag.js'
import { publishUndoBatchNotice } from './undo-toast.js'

export interface BatchDeleteRequest {
  /** 每次发布递增：换一批就重挂载，busy / 失败面不带着上一批的记忆。 */
  seq: number
  items: readonly PickItem[]
}

let request: BatchDeleteRequest | null = null
let nextSeq = 0
const listeners = new Set<() => void>()
const emit = (): void => {
  for (const listener of listeners) listener()
}

export function requestDeleteBatch(items: readonly PickItem[] = getPicks()): void {
  if (items.length === 0) return
  request = { seq: (nextSeq += 1), items: [...items] }
  emit()
}

export function clearDeleteBatchRequest(): void {
  if (request === null) return
  request = null
  emit()
}

/** 重试轮之后把现场收缩到失败名单（框里只剩还没办成的）。 */
function shrinkRequestToFailures(failedSessionIds: readonly string[]): void {
  if (request === null) return
  const keep = new Set(failedSessionIds)
  request = { ...request, items: request.items.filter((item) => keep.has(item.sessionId)) }
  emit()
}

function getBatchRequest(): BatchDeleteRequest | null {
  return request
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function useDeleteBatchRequest(): BatchDeleteRequest | null {
  return useSyncExternalStore(subscribe, getBatchRequest, getBatchRequest)
}

export type BatchConfirmDeps = Pick<SessionDeleteRemote, 'applyOutcomes'>

export function BatchConfirmHost({ deps, t = zhTranslate }: { deps: BatchConfirmDeps; t?: Translate }): ReactElement | null {
  const current = useDeleteBatchRequest()
  if (current === null) return null
  return <BatchConfirmDialog key={current.seq} request={current} deps={deps} t={t} />
}
```

`BatchConfirmDialog` 的行为（组件体照 `delete-confirm.tsx` 的 `ConfirmDialog` 配方展开，`TARGET_CARD` 那套卡片 token 原样用）：

- 挂载即 `fetchCounts(deps, ids)`（带 `alive` 守卫），`counts === null` 时 chip 与汇总句**整句不出现**；
- `title`：`items.length === 1 ? t('dialog.title') : t('dialog.batch.title', { n: items.length })`；
- 目标卡逐条：`title || t('common.untitled')` +（`counts?.get(id)` 大于 0 时）chip `t('trash.row.subagents', { n })`；
- 汇总句：合计 K > 0 时 `<p>{t('dialog.subagents', { n: K })}</p>`；然后 `<p>{t('dialog.hint')}</p>`；
- 失败面：每条失败一行下挂 `<Tag tone="danger">{message}</Tag>`（message = 信封原文，不改写）；
- footer：`<Button variant="outline">{t('common.cancel')}</Button>`（= `clearDeleteBatchRequest`）+ 主按钮：无失败 `t('batch.run', { n })` / 有失败 `t('dialog.batch.retry', { m })`，`disabled={busy}`；
- 执行（含重试）：

```ts
const run = async (): Promise<void> => {
  const failedIds = [...failures.keys()]
  const targetIds = failedIds.length > 0 ? failedIds : current.items.map((item) => item.sessionId)
  setBusy(true)
  setFailures(new Map())
  const outcome = await callRemote(() => deps.applyOutcomes('delete', targetIds))
  setBusy(false)
  if (!outcome.ok) {
    // 整次调用没办成：全部落原文、框不关
    setFailures(new Map(targetIds.map((id) => [id, outcome.failure.message])))
    return
  }
  const moved: string[] = []
  const failed = new Map<string, string>()
  let okCount = 0
  for (const item of outcome.value) {
    if (!item.ok) {
      failed.set(item.id, item.error.message)
      continue
    }
    okCount += 1
    // value === null 是"已被同批前一条带走"的幂等条：跟着组走，不单列进撤销名单
    if (item.value !== null) moved.push(item.value.id)
  }
  if (okCount > 0) publishUndoBatchNotice({ entryIds: moved, n: okCount })
  invalidateTrash()
  shrinkPicksToFailures([...failed.keys()])
  if (failed.size === 0) {
    clearDeleteBatchRequest()
    return
  }
  setFailures(failed)
  shrinkRequestToFailures([...failed.keys()])
}
```

（`item.value` / `item.error` 按 `ApplyOutcome` 的 `ok` 收窄——TS 自己认；`delete` 动作成功值是 `TrashEntryWire | null`。）

- [ ] **Step 4: 跑绿**

Run: `npx vitest run tests/client/batch-confirm.test.tsx`
Expected: PASS。

- [ ] **Step 5: 三道门 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add src/client/batch-select.tsx src/client/batch-confirm.tsx tests/client/batch-confirm.test.tsx
git commit -m "feat: 批量删除确认框——数说清自己的、失败原文落行、重试只发失败（第十三批②）"
```

---

### Task 4: 浮条（`BatchBar`）

**Files:**
- Modify: `src/client/batch-select.tsx`（+`BatchBar`）
- Test: `tests/client/batch-bar.test.tsx`

**Interfaces:**

- Consumes: 本文件的 `usePicks` / `clearPicks` / `getPicks` / `fetchCounts`；Task 3 的 `requestDeleteBatch` / `BatchConfirmHost`（后者仅测试里同屏挂）。
- Produces:

```ts
export type BatchBarDeps = Pick<SessionDeleteRemote, 'applyOutcomes'>
export function BatchBar(props: { deps: BatchBarDeps; t?: Translate }): ReactElement | null
```

行为：选中空 = 不渲染；「已选 {n} 条」恒有；「含 {k} 个子会话，跟着整组走」只在合计 k > 0 说（计数 = 勾选变化后**防抖 300ms** 的一次 `fetchCounts`，**序号守卫**：旧响应不落地；读不到整句不说）；按钮 =「清空」（`clearPicks`）+「移入回收站 {n} 条」（`requestDeleteBatch(getPicks())`）。

- [ ] **Step 1: 写失败用例**

`tests/client/batch-bar.test.tsx`：

```tsx
// 批量删除浮条（第十三批①）：计数两句的有无、竞态守卫、进确认框。
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BatchBar,
  clearPicks,
  togglePick,
} from '../../src/client/batch-select.js'
import { BatchConfirmHost, clearDeleteBatchRequest } from '../../src/client/batch-confirm.js'
import type { ApplyOutcome } from '../../src/client/remote.js'

beforeEach(() => {
  clearPicks()
  clearDeleteBatchRequest()
})

function countOutcomes(ids: readonly string[], kids: Record<string, number> = {}): ApplyOutcome[] {
  return ids.map((id) => ({ id, action: 'count', ok: true, value: kids[id] ?? 0 }) as ApplyOutcome)
}

describe('浮条', () => {
  it('没选时整个不渲染', () => {
    render(<BatchBar deps={{ applyOutcomes: vi.fn() } as never} />)
    expect(screen.queryByText(/已选/)).not.toBeInTheDocument()
  })

  it('选了报条数；有子会话才多说半句，没有就只有条数', async () => {
    const applyOutcomes = vi.fn(async (_action: string, ids: readonly string[]) =>
      countOutcomes(ids, { a: 2 }),
    )
    togglePick({ sessionId: 'a', title: 'A' })
    togglePick({ sessionId: 'b', title: 'B' })
    render(<BatchBar deps={{ applyOutcomes } as never} />)
    expect(screen.getByText('已选 2 条')).toBeInTheDocument()
    expect(await screen.findByText('含 2 个子会话，跟着整组走')).toBeInTheDocument()
  })

  it('计数读不到就整句不说（不拿 0 冒充没有）', async () => {
    const applyOutcomes = vi.fn(async () => {
      throw Object.assign(new Error('读不到'), { code: 'sessiondelete/io' })
    })
    togglePick({ sessionId: 'a', title: 'A' })
    render(<BatchBar deps={{ applyOutcomes } as never} />)
    expect(screen.getByText('已选 1 条')).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(screen.queryByText(/子会话/)).not.toBeInTheDocument()
  })

  it('旧响应不落地：后发的勾选才是准的', async () => {
    const deferred: Array<(value: ApplyOutcome[]) => void> = []
    const applyOutcomes = vi.fn(
      (_action: string, _ids: readonly string[]) =>
        new Promise<ApplyOutcome[]>((resolve) => deferred.push(resolve)),
    )
    togglePick({ sessionId: 'a', title: 'A' })
    const view = render(<BatchBar deps={{ applyOutcomes } as never} />)
    await waitFor(() => expect(applyOutcomes).toHaveBeenCalledTimes(1))
    togglePick({ sessionId: 'b', title: 'B' })
    await waitFor(() => expect(applyOutcomes).toHaveBeenCalledTimes(2))
    // 第二次的响应先回（b：无子会话）……
    deferred[1](countOutcomes(['a', 'b']))
    await screen.findByText('已选 2 条')
    // ……第一次的后回（a：2 个子会话）——旧响应，不许把「含 2 个」盖回来
    deferred[0](countOutcomes(['a'], { a: 2 }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByText(/子会话/)).not.toBeInTheDocument()
    view.unmount()
  })

  it('点「移入回收站 N 条」进确认框；点「清空」把名单和浮条一起收掉', async () => {
    const applyOutcomes = vi.fn(async (action: string, ids: readonly string[]) =>
      action === 'count' ? countOutcomes(ids) : [],
    )
    togglePick({ sessionId: 'a', title: 'A' })
    render(
      <>
        <BatchBar deps={{ applyOutcomes } as never} />
        <BatchConfirmHost deps={{ applyOutcomes } as never} />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: '移入回收站 1 条' }))
    expect(await screen.findByText('删除这个会话？')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '清空' }))
    await waitFor(() => expect(screen.queryByText(/已选/)).not.toBeInTheDocument())
  })
})
```

- [ ] **Step 2: 跑出红**

Run: `npx vitest run tests/client/batch-bar.test.tsx`
Expected: FAIL（`BatchBar` 未导出）。

- [ ] **Step 3: 实现**

`src/client/batch-select.tsx` 追加（import 区加 `useEffect` / `useRef` / `useState`、`Button`、`requestDeleteBatch`）：

```tsx
/** 浮条（第十三批①）：选中非空才渲染。计数 = 勾选变化后防抖 300ms 的一次批量 count，序号守卫。 */
export function BatchBar({ deps, t = zhTranslate }: { deps: BatchBarDeps; t?: Translate }): ReactElement | null {
  const picks = usePicks()
  const [counts, setCounts] = useState<Map<string, number> | null>(null)
  const seqRef = useRef(0)

  useEffect(() => {
    const ids = picks.map((item) => item.sessionId)
    const seq = (seqRef.current += 1)
    const timer = setTimeout(() => {
      void fetchCounts(deps, ids).then((result) => {
        if (seq === seqRef.current) setCounts(result)
      })
    }, 300)
    return () => clearTimeout(timer)
  }, [deps, picks])

  if (picks.length === 0) return null
  const kids = counts === null ? 0 : [...counts.values()].reduce((sum, n) => sum + n, 0)
  return (
    <div data-dsh-session-delete="batch-bar">
      <span>{t('batch.bar.count', { n: picks.length })}</span>
      {kids > 0 ? <span>{t('batch.bar.kids', { k: kids })}</span> : null}
      <Button variant="outline" onClick={clearPicks}>
        {t('batch.bar.clear')}
      </Button>
      <Button variant="primary" onClick={() => requestDeleteBatch(getPicks())}>
        {t('batch.run', { n: picks.length })}
      </Button>
    </div>
  )
}
```

（几何/排版用 `ui.css` 里已有的按钮与布局类即可，**不新抄官方 CSS**；浮条容器的定位样式可用文件头声明过的自造模式补一条 `.sd-batch-bar`，同样只用 token——它不是官方控件的抄本，是本插件自己的浮层，与 `UndoToast` 同类。实现时把这条并进 ui.css 文件头"不是抄本"的账里。）

- [ ] **Step 4: 跑绿**

Run: `npx vitest run tests/client/batch-bar.test.tsx`
Expected: PASS。

- [ ] **Step 5: 三道门 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add src/client/batch-select.tsx src/client/ui/ui.css tests/client/batch-bar.test.tsx
git commit -m "feat: 批量删除浮条——防抖计数、旧响应不落地（第十三批①）"
```

---

### Task 5: 槽位注册接线（`index.tsx`）与装配面用例

**Files:**
- Modify: `src/client/index.tsx`
- Modify: `tests/client/index.test.tsx`

**Interfaces:**

- Consumes: Task 1 的 `BatchPickButton`、Task 3 的 `BatchConfirmHost`、Task 4 的 `BatchBar`（全部已在库）。
- Produces: 三条新槽位贡献（注册形状，index.test 按这些断言）：
  - `sidebar.workspaces.session.row.action`，id `@xrn1997/dsh-session-delete.batch-pick`，**order 300**，投影 `{ sessionId, displayTitle }`；
  - `shell.overlay`，id `@xrn1997/dsh-session-delete.batch-bar`；
  - `shell.overlay`，id `@xrn1997/dsh-session-delete.batch-confirm`。

- [ ] **Step 1: 写失败用例（装配面）**

`tests/client/index.test.tsx` 里沿用既有辅助（名字不动：`okOutcomes` / `rawRemote` / `installFetch` / `settle` / `Scene` / `Registration`），加常量与两条断言/用例：

```ts
const ROW_ACTION_SLOT = 'sidebar.workspaces.session.row.action'
```

注册形状断言（放进既有的"探测通过才注册"那组，`bootstrap()` 返回 `{ registered, fetchCalls, seat }`）：

```ts
const rowAction = registered.find((r) => r.name === ROW_ACTION_SLOT)
expect(rowAction).toMatchObject({
  id: '@xrn1997/dsh-session-delete.batch-pick',
  order: 300,
})
```

端到端用例（`Scene` 里把 `ROW_ACTION_SLOT` 的占用者按真宿主形状渲染进一个假的行尾按钮排，投影 `{ sessionId, displayTitle }` 与菜单槽同款的 `useSessions`；`Scene` 的 `rowProps` 透给两者）：

```tsx
it('行尾勾选 → 浮条 → 确认 → count/delete 各一条 POST /apply → 行收工出横幅', async () => {
  const { registered, fetchCalls } = await bootstrap()
  render(
    <Scene registered={registered} rowProps={{ sessionId: 'session-1', displayTitle: '会话一' }} />,
  )
  fireEvent.click(screen.getByRole('button', { name: '勾选「会话一」以批量删除' }))
  // 浮条那颗（此时对话框还没开，全页只此一颗）
  fireEvent.click(await screen.findByRole('button', { name: '移入回收站 1 条' }))
  // 确认框里那颗（与浮条同句同键 ⇒ 只能在 role="dialog" 里找，Modal 自带该 role）
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: '移入回收站 1 条' }))
  await waitFor(() => expect(screen.getByText('1 条会话已移入回收站')).toBeInTheDocument())
  const applyCalls = fetchCalls.filter((c) => c.path.endsWith('/apply') && c.method === 'POST')
  // 序断言只钉"最后一次是 delete"：浮条的防抖 count 与开框的 count 谁先落地不定（预裁记档）
  expect(applyCalls.map((c) => (c.body as { action: string }).action)).toContain('count')
  expect(applyCalls[applyCalls.length - 1].body).toMatchObject({ action: 'delete', ids: ['session-1'] })
})
```

（`within` 从 `@testing-library/react` 导入，与文件里既有的 `render` / `screen` 同一来源。）

- [ ] **Step 2: 跑出红**

Run: `npx vitest run tests/client/index.test.tsx`
Expected: 新断言/用例 FAIL（注册数还是五条、`batch-pick` 找不到）。

- [ ] **Step 3: 实现**

`src/client/index.tsx`：import 三个新组件；`activate()` 里在菜单行之后追加（写法与既有的 `client.slots.inject(...)` 同形）：

```ts
  // ④ 行尾勾选开关：批量删除的选择面（第十三批①）。投影与菜单行同款（sessionId / displayTitle），
  // live 读法复用 DeleteRow 那套 root hook 防御式收法；order 300 落在宿主 archive(100)/pin(200) 之后。
  client.slots.inject(ROW_ACTION_SLOT, () =>
    client.slots.register(
      {
        name: ROW_ACTION_SLOT,
        id: `${PLUGIN_ID}.batch-pick`,
        order: 300,
        inject: () => ({ t }),
      },
      PickRow,
    ),
  )

  // ④' 浮条（选中非空才渲染）
  client.slots.inject(OVERLAY_SLOT, () =>
    client.slots.register(
      { name: OVERLAY_SLOT, id: `${PLUGIN_ID}.batch-bar`, inject: () => ({ deps, t }) },
      BatchBarSlot,
    ),
  )

  // ④'' 批量确认框（与单删确认框同理：必须脱离行子树的生命周期）
  client.slots.inject(OVERLAY_SLOT, () =>
    client.slots.register(
      { name: OVERLAY_SLOT, id: `${PLUGIN_ID}.batch-confirm`, inject: () => ({ deps, t }) },
      BatchConfirmSlot,
    ),
  )
```

`PickRow` 照 `DeleteRow` 收投影（`sessionId` / `displayTitle` / `useSessions`，`NEVER_LIVE` 兜底），回 `<BatchPickButton sessionId={sessionId} title={displayTitle} live={live} t={t} />`；`BatchBarSlot` / `BatchConfirmSlot` 与 `UndoToastSlot` / `DeleteConfirmSlot` 同形（只吃 `deps` 与 `t`）。文件头注那本账改成逐条列数（不写模糊的总数对）：「共交付**八个**槽位贡献：菜单删除行 / 单删确认框 / 单删撤销横幅 / 回收站一对座位 / **行尾勾选开关 / 浮条 / 批量确认框**（后三条是第十三批的批量删除，四态形状住设计稿第十三批）」。`ROW_ACTION_SLOT = 'sidebar.workspaces.session.row.action'` 加进顶部常量区。

- [ ] **Step 4: 跑绿**

Run: `npx vitest run tests/client/index.test.tsx`
Expected: PASS（既有用例含"探测不过零注册"照旧绿）。

- [ ] **Step 5: 三道门 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add src/client/index.tsx tests/client/index.test.tsx
git commit -m "feat: 批量删除三条槽位贡献接线（第十三批①②）"
```

---

### Task 6: 收尾——门、读数、真机门交他

**Files:**
- Modify: `docs/design/2026-09-30-session-delete-design.md`（第十三批末「落地后补读数」换真数）
- Modify: `package.json`（仅当发版需要 bump；**不发版就别动**）

- [ ] **Step 1: 三道门 + 纯度 + 读数**

```bash
npm test
npx tsc --noEmit
npm run build
grep -oE 'require\("[^"]+"\)' lib/client.js | sort -u
node -e "const z=require('zlib'),f=require('fs');for(const p of ['lib/index.js','lib/client.js']){const b=f.readFileSync(p);console.log(p,b.length,z.gzipSync(b).length)}"
```

Expected: 三道门退出码 0；`require` 逐字三条 `react` / `react-dom` / `react/jsx-runtime`，`node:` 与裸内建 0 条。把单测数、三道门退出码、Node 半/浏览器半的 kB 与 gzip 读数写回第十三批末（沿用第十二批那本账的口径；`ui.css` 若动过，注明门 4 逐属性比对**只跑新加那一块**）。

- [ ] **Step 2: 真机门交用户（编号判据照第十三批，未跑就写未跑）**

把第十三批「用例与真机门」里的**「全部未跑」**如实留着（或按实际改成部分已跑），四条判据一字不改地交给他。**不要**自行装 live profile——隔离 home → live 的顺序归他自己走（AGENTS.md 硬约束 + 他的验收习惯：live 最小路径）。

- [ ] **Step 3: 提交**

```bash
git add docs/design/2026-09-30-session-delete-design.md
git commit -m "docs: 第十三批读数落账（批量删除）"
```

（发版 bump / tag / push 与 npm publish **不在本计划内**——发布边界归用户。）

---

## Self-Review 记录

- **Spec 覆盖**：第十三批①（座位/开关/浮条/计数）、②（确认框/执行/失败/撤销）、③（文案键/模块/皮肤）、④（不做项无需任务）、用例与真机门 ⇒ Task 1–6 全覆盖。键表的两处校准（复用 `dialog.subagents`、"三个就近并入"）在 Task 1 Step 3⑥ 回写设计稿。
- **占位符**：无 TBD；Task 5 的 `Scene` 扩写点名了既有辅助的真名与要挂的投影形状。
- **类型一致性**：`PickItem` / `getPicks` / `usePicks` / `togglePick` / `clearPicks` / `shrinkPicksToFailures` / `fetchCounts` / `requestDeleteBatch` / `clearDeleteBatchRequest` / `useDeleteBatchRequest` / `publishUndoBatchNotice` / `BatchBar` / `BatchConfirmHost` / `BatchPickButton` 全文同名同签名；`ApplyOutcome` 的 `ok` 收窄在三处用法一致。
