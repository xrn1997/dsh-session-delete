# 各张确认框共用一个页脚壳

Status: accepted

各张确认框（单删、批量删除、清空/批量彻底删除、批量恢复、孤儿会话清理、孤儿附件清理、投影缓存清理）只共用页脚与关框规则：一个 `ConfirmDialog` 壳负责「描边取消 / 主按钮确认」、`useIdleClose` 与危险层级；各框的标题、正文、列什么、确认键文案与状态机仍归各自。共壳的边界只到这一层，不再往上收。

## 背景

这几张框从两张一路长起来，页脚、`closeLabel`、`useIdleClose` 与「未命名」兜底逐份复制；差异只有标题、一到三段正文、列什么、确认键文案、危险层级与 `busy` 来源。`batch-confirm.tsx` 的头注曾明确否过共壳，但那次否的是把单删的 `busy` / 失败面拖进批量形——否的是**业务合并**，不是页脚这一层。

## 决定

1. **共的只有壳。** `ConfirmDialog` 拥有 `Modal` 的打开、标题、`closeLabel`、页脚按钮与 `useIdleClose`；调用方只交标题、正文、取消/确认文案、`busy` 与危险层级。
2. **各框的状态机不合并。** 单删/批量的失败面、清空的聚合回执、维护卡各段的手动清理各自留在原处；壳不读远程面、不拼句、不认识 `pending`。
3. **危险层级是一个布尔旋钮。** `danger: true` 用实心红（`BULK_DANGER`）；普通主按钮与「移入回收站」同款，不另造一档。

## 为什么值得一篇 ADR

共壳边界只到页脚，且各框的状态机明确不合并——这条边界容易被下一次「顺手统一」越过去；前一轮已经否过业务合并，这次要留下「壳可以共、状态机不共」的判据。回退要同时改各张框，不是一行样式。

## 边界

- 不是把这些框合成一个组件：标题与正文的措辞、条目卡片、预览清单仍由各框给。
- 附件放大预览有自己的页脚（保存动作），不走这个壳。
- 关框规则仍归 `useIdleClose`；壳只是它唯一的调用点，不再逐框手写。

## 被否方案

- **继续逐框复制页脚**：差异只有几个旋钮，页脚与关框规则却各写一份；改一处危险层级或按钮材质要逐张动。
- **把这些框合成一张「通用确认框」**：状态机、失败面与正文结构差异太大，合成会把不相干的判据绑在一起，正是上一轮否掉的那种共壳。

锚点：`src/client/confirm-dialog.tsx` 的 `ConfirmDialog`；`src/client/delete-confirm.tsx`；`src/client/batch-confirm.tsx`；`src/client/trash-confirm.tsx` 的 `TrashConfirm` / `OrphanConfirm`；`src/client/maintenance-settings.tsx` 的 `AttachmentConfirm` / `ProjectionConfirm`；`src/client/confirm-close.ts` 的 `useIdleClose`；`docs/ui-spec.md` 的危险层级；`tests/client/delete-menu-item.test.tsx`；`tests/client/batch-confirm.test.tsx`；`tests/client/trash-panel.test.tsx`；`tests/client/maintenance-settings.test.tsx`。
