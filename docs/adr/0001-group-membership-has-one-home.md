# ADR-0001 — 组语义只有一个家：`src/trash/groups.ts`

Status: accepted

## 背景

「回收站里这一组有谁」被四处各算了一遍：

| 位置 | 当时的规则 |
| --- | --- |
| `src/api/dispatch.ts` `assembleTrashRows` | 只认根行（父自己也是孩子 ⇒ 不折） |
| `src/verbs/apply.ts` `groupOf`（现名 `src/verbs/batch.ts`，改名记在 ADR-0002） | 父不是根 ⇒ 只回自己 |
| `src/verbs/restore-session.ts` `restoreSession` | 与 `groupOf` 同规则（抄了一份） |
| `src/verbs/purge-trash.ts` `purgeTrash` | `id === x \|\| parentEntryId === x`——**不认根行** |

前三处一致、第四处不一致，而且不一致只发生在**嵌套组**（父行自己也是孩子）上：那种形状只可能来自
降级/手工重建的行（`parentEntryId` 在正常路径上永远指向同一次删除里刚生成的**根行**，
见 `delete-session.ts` 里 `parentEntry.id` 的用法），于是它长期没被真机撞上——但一次「彻底删除」
会顺手删掉不属于这一组的孙代目录，且是**不可恢复**的。

## 决定

1. 组语义收进 `src/trash/groups.ts`，**interface 只有三个纯函数**，都吃 `readonly TrashEntry[]`：
   - `visibleGroups(rows): { root, kids }[]`——清单露面的一行 = 组根（`/list` 的行装配要的是 `root` 与
     `kids` 两样，所以给带 `kids` 的那一版，而不是只回一排行）；
   - `groupOf(rows, id): TrashEntry[]`——一条 id 所属的整组（含「父自己是孩子时只回自己」）；
   - `takenByEarlierInBatch(original, current, id): boolean`——幂等判据（「被同批前一条带走」）。
2. 判据原文只在这一个文件里写：**接得住孩子的只有组根**。
3. `purgeTrash` 改用与其余三处同一条判据——这是**行为变化**：嵌套组不再连带删除孙代。
4. 补一条嵌套组的回归测试（父行自己也是孩子时，彻底删除只清它自己）。

## 不做的事

- **不**提供"只有一排露面行"的那个更窄的函数：`/list` 的装配同时要 `root` 与 `kids`（头部合计与
  孩子数都从那两样算），只回一排行会把组又拆成两个函数做同一件事。
- **不**把快照装进一个可变句柄（`createGrouping(rows)`）：`/apply` 那条路会在同一批里多次重问、
  而快照会被就地收缩；把快照当参数传，收缩的时机归调用方，groups module 保持无状态。

## 后果

- 四个调用点各删一段手写规则，「根行才接得住孩子」从注释变成可执行代码。
- `/list` 的行装配与动词的目标集**第一次由同一份代码决定**，界面上的「释放多少」与实际删掉的东西不再可能各说各的。
- 测试落点：一条纯函数测试即可覆盖三种形状（父 + 孩子、父自己是孩子、父行不在）。

## 被否掉的替代

- **只给 `purgeTrash` 加一句注释**：那是打补丁——四处仍各有一份规则，下一次改动照样能漂。
- **把组语义放进 `shared/wire.ts`**：浏览器半没有「这一组有谁」的判据需求（它只念服务端给的数），
  放进去等于给线上契约加一个没人用的概念。

锚点：`CONTEXT.md`（组 / 组根 / 盘上后代）；`src/trash/groups.ts`
