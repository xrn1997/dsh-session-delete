# ADR-0028 — 清单的 ARIA 模式是 grid，行内动作不进 option

Status: accepted

回收站清单曾是 `listbox`/`option`（整行 `role=option`，行内住动作按钮与勾选框，组用具名 `section` 包），它在 AT 上有两个解不开的错（issue #8 第 2 条）。决定换成 grid 模式：组 `rowgroup`、行 `row`、内容与动作各住 `gridcell`——交互模型一行不动，语义载体换成行级 grid。

## 背景

两个问题，一轻一重：

1. **所有权链断裂**：具名 `section` 映射成 `region`，`option` 由 `region` 中转会断掉「option 由 listbox/group 所有」的链，读屏可能不把行报成列表项。
2. **行内按钮被抹平**：`option` 的后代按 ARIA 是 presentational children，AT 会把它们连同语义一起抹平——「恢复 / 彻底删除」与勾选框在读屏下**根本够不着**。这不是可记录的边界，是功能缺失；而「列表语义」与「点行=选中、行内有动作」的交互模型在 option 语义下本就互斥。

## 决定

1. 清单 ARIA 模式定为 **grid**：容器只在真有行时挂 `role=grid` 与它的 aria（`aria-label` / `aria-colcount` / `aria-activedescendant` / `aria-multiselectable`）；失败、加载、空态是普通内容块，不是「空的 grid」（generic 上不背 aria 名字）。
2. 组是**带名字的 `rowgroup`**（`aria-label` = 项目名）；条目行与组头行都是 `row`；行内内容、动作与勾选框各自住进一格 `gridcell`（按模式取其中两格）——交互内容在 cell 里才被 AT 真实暴露。
3. **键盘契约不动**（`src/client/trash-nav.ts` 仍是行级分工：↑↓ 走环、Enter/Space 说行、Esc 交还焦点）；只把事件判据从 `role=option` 改成 `role=row`。grid 允许行级导航，`aria-selected` / `aria-multiselectable` 语义与原模型一一对应。

## 边界

- **不改成格子级导航**：行级 ↑↓ 是既定交互（`docs/ui-spec.md`「键盘」），这次只换语义载体。容器上的 `aria-activedescendant` 不是实际光标载体：焦点落在行上（roving tabindex），它保留原状，不替代行焦点。
- 多选语义不变：勾选仍映射 `aria-selected` + `aria-multiselectable`，勾选框仍是行内控件。
- 行的 DOM id 由 DOM 侧编码保证合法（`domRowId`），不改 `makeEntryId`——那个 id 的形状是目录名往返契约（恢复要反推原目录名），归数据层。
- **列数一致靠显式声明**：条目行恒为两格（常态：内容 + 动作；多选态：勾选框占内容前的一格、动作列退场），组头行只有一格——容器挂 `aria-colcount`、组头格挂 `aria-colspan` 横跨整行，读屏的列播报因此不乱；组头行也是 `row`（界面家见 `docs/ui-spec.md` ④）。

## 被否掉的替代

- **最小修法：`section` 改 `role=group` + 在 ui-spec 把「行内按钮」记成已知边界**：所有权链能修好，但 presentational children 只是被写进文档、没被解决——读屏用户仍然够不着行内动作，等于把 bug 存档。
- **保留 listbox、把按钮挪出 option**（行 wrapper + option 只包文本）：所有权链要靠 generic wrapper 穿针，按钮在 group 里的合法性没有 spec 依据；option 只盖文本后「点行=选中」的点击区与选中语义还要另找载体。
- **给行内按钮挂 `aria-hidden` 或只留键盘快捷键**：按钮仍要可聚焦，藏可聚焦元素本身违规，且鼠标用户与 AT 用户的可见面会分叉。

## 后果

按 ARIA 语义，读屏播报从「选项」变成「行、n/N、选中」，行内按钮以真实按钮暴露（AT 实测仍属真机边界）。`tests/client/trash-panel.test.tsx` 钉住 grid/row/rowgroup/gridcell 四层、「树里没有 option」与列数声明（`aria-colcount` / 组头 `aria-colspan`）；`docs/ui-spec.md` 的④与「键盘」两段是这条语义的界面家。

锚点：`src/client/trash-panel.tsx`（`gridActive`、`LIST_COLUMN_COUNT`、`role="rowgroup"`、`role="gridcell"`）、`src/client/trash-nav.ts`（`isListOwnedEvent`）、`tests/client/trash-panel.test.tsx`、`docs/ui-spec.md` 的④与「键盘」。
