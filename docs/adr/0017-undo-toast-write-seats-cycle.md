# 撤销横幅与写入座位之间的 import 环按 init-safe 收下

Status: accepted

`src/client/undo-toast.tsx` 要调 `src/client/write-seats.ts` 的恢复座位（`restoreFromUndo`），`write-seats.ts` 要调 `undo-toast.tsx` 的横幅发布与熄灭（`publishUndoNotice` / `publishUndoBatchNotice` / `dismissUndoNotice`）——两端互为依赖，成环。决定：**收下这条环**，约束是两边都不得在模块求值期读对方绑定。它是 init-safe 的：`write-seats.ts` 的顶层只有 import、类型与函数声明，`undo-toast.tsx` 的顶层只调 `store.ts` 的 `createStore`，且浏览器半打成一颗 CJS 工厂、函数声明提升，环先转起来也撞不上未初始化的绑定。

## 边界

- 横幅的**现场、seq 与按条目熄灭**仍只住 `undo-toast.tsx`；**落地名单与 `anySuccess` 门**仍只住 `write-settlement.ts`，座位只决定发布哪一形（单条带标题、批量带条数）。环不改变任何语义归属。
- 新增跨这两个 module 的引用时，必须保持「求值期不读对方绑定」。这条只有散文约束：测试面钉不住——在座位顶层探针读一个横幅的 `const` 导出，两种入口顺序都是绿的（跑测试时环里另一颗已被求值完），所以别为它加「两种顺序都装得起来」那类假守卫。环若长出第三个成员，要回来重写本篇。

## 被否掉的替代

- **让 settlement 自己发布横幅**：`undo-toast → write-seats → write → write-settlement → undo-toast` 照样成环，还把「只算落地条目 id」的 settlement 拖进呈现职责。
- **横幅改事件总线、座位订阅**：为一对固定的调用引入一条间接层，发布时序从直读变成监听，横幅的现场与熄灭反而更难追踪。
- **把 `restoreFromUndo` 挪进 `undo-toast.tsx`**：呈现材质按调用位置各归一个座位是本仓的收法（ADR-0013），撤销恢复的座位就该住在 `write-seats.ts`。

锚点：`src/client/write-seats.ts`；`src/client/undo-toast.tsx`；`tests/client/write-seats.test.ts`；`docs/architecture.md` §4；ADR-0013。
