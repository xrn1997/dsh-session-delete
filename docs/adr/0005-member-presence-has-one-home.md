# ADR-0005 — 成员离场 / 归位通告只有一个家：`src/verbs/member-presence.ts`

- **状态**：已接受（2026-10-20）
- **相关**：`CONTEXT.md`（成员在场 / 通告）；`src/verbs/member-presence.ts`

## 背景

「摘活体 → 判三态 → 如实通告」在四个动词的六处调用里各写一遍：

| 位置 | 当时的规则 |
| --- | --- |
| `src/verbs/delete-session.ts` 成员搬完 | `evictLive` 非 `unknown` ⇒ `announceRemoved` |
| `src/verbs/delete-session.ts` 组回滚 | `movedBack && workspaceBack && visibleBack` ⇒ `announceRestored` |
| `src/verbs/restore-session.ts` 组回滚 | `movedBack` ⇒ `evictLive` 非 `unknown` ⇒ `announceRemoved` |
| `src/verbs/purge-trash.ts` 两个删除分支 | 各写一遍 `evictLive` 非 `unknown` ⇒ `announceRemoved` |
| `src/verbs/orphan-subagents.ts` 清理 | 同上一行 |

`unknown` 的语义（读不到 store / 形状不符 / 摘除抛错 ⇒ 不断言宿主列表干净）在每个调用点都要重新解释一遍；
删除回滚那句「回到可见面」的真值条件也只能靠读三处局部变量才拼得出来。

## 决定

1. 新增 `src/verbs/member-presence.ts`，interface 两个方法：
   - `memberGone(sessionId, facts?)`：`backInTrash === false` 时什么都不做；否则 `evictLive`，
     三态不是 `unknown` 就 `announceRemoved`。
   - `memberBack(sessionId, facts)`：`diskBack && workspaceBack && visibleBack` 才 `announceRestored`。
2. 调用方只报事实：删除回滚交三个布尔（本来就在手边）；恢复回滚交 `backInTrash: movedBack`；
   其余路径不交事实（缺省即「确实已离开」）。
3. **批量通告不进来**：`announceRestoredBatch` 仍归 `src/verbs/batch.ts`（ADR-0002）。
4. 不叠第二层 `catch`：`HostPort` 的三条方法按契约不抛；通告失败不翻动词结果这条语义留在端口。

## 边界

- 不做通用「在场框架」：它只服务「成员在会话列表里是否可见」这一件事。
- 不读 journal 的失败串：那会把 module 耦合到回滚措辞，而且覆盖不了恢复侧「目录回 trash 就算离开」的语义。
- 不改事件名、载荷形状与调用顺序（现有用例钉着 `rename → evictLive → announceRemoved`）。

## 后果

- 六处调用各缩成一行事实；`unknown` 与「三件写都回去」两条判据只有一个家。
- 测试落点：module 单测覆盖三态与四种事实组合；现有动词用例继续钉调用顺序；
  一条源码扫描用例钉住「只有 member-presence 调这三条 host 方法」。
- 新增词条「成员在场」与 `docs/architecture.md` §4 的主人行。

## 被否掉的替代

- **只收通告、不收 `evictLive`**：三态判断会留在六处调用，协议仍然散着。
- **调用方算好一个布尔再交给 module**：「三件写都回去」的真值表继续住调用点，正是这次要收的东西。
- **module 直接读 journal 的 `failures`**：耦合到回滚措辞，且恢复回滚的 `movedBack` 不是 journal 失败串能表达的。
- **把批量 `announceRestoredBatch` 也收进来**：一个 module 同时拥有单成员与整批两种通告粒度，违背 ADR-0002。
