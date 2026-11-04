# ADR-0038 — 组员判据是 origin:'subagent'，parentSession 只是谱系记录

Status: accepted

删除、计数与永久删除带走的「组员」只由 `origin:'subagent'` 判定；`parentSession` 只记录来源，不能单独把一条会话判成子会话。否则已发布宿主的普通 fork（分支会话）会在删父时被一起搬走。

## 背景

兼容窗口 `>=0.1.7-rc.2 <0.3.0-0` 内，宿主对 `parentSession` 的含义变过一次：

- `0.1.7-rc.2` ～ `0.2.1-rc.5`：fork 显式把源会话写进 `parentSession`；列表投影 `flattenLineage` 也按它分组。
- `0.2.2-alpha.2`（`b096659245`）起：fork 不再写 `parentSession`，列表谱系只认 `origin`。

但同一窗口里，生命周期语义从地板代次起就是 origin-only：归档闸、归档准入与持久化找子日志都只沿 `origin:'subagent'` 的血缘走，注释原文是 "never a fork"。`sessionQuery.filterSessions` 的 `kind:'parent'` 与 `traceSession` 是原始谱系原语：前者只比 `parentSession`，后者连普通 fork 也当祖先——它们不是「子会话」分类器。

插件曾把 `filterSessions(kind:'parent')` 直接当组员判据，于是删父会把普通 fork 一起搬进回收站；2026-11-04 在 `0.2.1-rc.5` 隔离 home 复现：父 + 分支 + subagent 的 `count` 是 2，分支目录被一起搬走。

## 决定

1. `src/ports/host-port.ts` 的 `descendantsByParent` 只把 `origin:'subagent'` 的记录收进闭包，并只沿这些记录继续向下问；非 subagent 的 fork 整条跳过，不穿透它的 subagent 孩子。
2. `src/domain/closure.ts` 的 `orphanRootsOf` 建 children 索引时只收 `subagent` 记录：后代里出现的普通 fork 不进组，也不穿过它收孩子。
3. 删除、计数、purge、孤儿扫描共用这两处；动词层不再各写一份判据。

## 边界

- 不改写任何 session header：删除/恢复仍只搬目录，分支的 `parentSession` 原样保留；恢复父后旧宿主按自己的列表规则重新分组，新宿主本来就不分组。
- 已有回收站里的存量分支不自动迁移：它仍按 `parentEntryId` 折叠在原组里，恢复父会连带恢复；要单独留下它，恢复整组后按修复后的行为再删一次父。
- 宿主记录缺 `origin` 时按非 subagent 处理：组变窄而不是变宽。这类残留不会被无主子会话扫描识别（它同样只认 origin），需要人工处理或等宿主记录补上 origin。
- `parentSession` 继续用于身份、列表顺序/深度与 `traceSession` 的原始谱系；它不再是组员判据。

## 被否掉的替代

- **按宿主版本分支**：旧宿主 fork 会写 parentSession、列表也分组，就在旧宿主上继续连带删分支——把展示行为抄进不可逆删除；同一份数据换个宿主版本行为就变。
- **只给 `filterSessions` 结果加一层 parentSession 过滤**：仍是 parentSession 判据，分支照样进组。
- **用 `traceSession` 找后代**：父进回收站后宿主认不出目标，且它把普通 fork 也当祖先。
- **删除时改写分支 header 去掉 parentSession**：破坏删除/恢复的对称，恢复后无法回到删除前。
- **改成整表 `listSessions` 再过滤**：多一次全量读，且改变语料缺席的失败形状；逐层 BFS 已够用。

锚点：`src/ports/host-port.ts` 的 `descendantsByParent`；`src/domain/closure.ts` 的 `orphanRootsOf`；`tests/assembly.test.ts`；`tests/closure.test.ts`；`tests/orphan-subagents.test.ts`。
