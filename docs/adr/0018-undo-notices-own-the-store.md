# 撤销通知台独立于 Toast 组件

Status: accepted

撤销横幅的现场此前住在 `src/client/undo-toast.tsx`，与 Toast 呈现和撤销编排同文件，导致两个数据 module 为了改通知台去 import 一个 `.tsx`，与 `write-seats.ts` 成环。决定：通知台（类型、store、seq、发布 / 熄灭、停留时长）收进无 JSX 的 `src/client/undo-notices.ts`；`undo-toast.tsx` 只做组件并组合通知台与恢复座位；`write-seats.ts` 只依赖通知台。

## 边界

- 发布决定与 `anySuccess` 门仍住 `src/client/write-settlement.ts`；`anySuccess` 与落地名单的派生住 `src/client/receipt.ts` 的 `summarizeReceipt`。座位只决定发布哪一形（单条带标题、批量带条数）。
- 恢复座位仍住 `src/client/write-seats.ts`（ADR-0013）。
- 通知台的按条目熄灭与整条清空仍只由 `undo-notices.ts` 提供；`undo-toast.tsx` 不重新拥有现场。

## 被否掉的替代

- **继续收下 init-safe 环**：环的代价已从两个 module 长成两个数据 module import 一个 `.tsx`，且通知台的测试必须拉起 React 组件。
- **把恢复座位挪进 Toast 组件**：违反 ADR-0013 的座位归属。

锚点：`src/client/undo-notices.ts`；`src/client/undo-toast.tsx`；`src/client/write-seats.ts`；`tests/client/undo-toast-batch.test.tsx`；ADR-0017；ADR-0013。
