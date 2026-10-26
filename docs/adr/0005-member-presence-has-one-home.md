# ADR-0005 — 成员离场 / 归位通告只有一个家：`src/verbs/member-presence.ts`

Status: superseded by 0019

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
2. 调用方只报事实：删除回滚交 `diskBack` / `workspaceBack` 两件事实（`undo.restored('dir')` /
   `undo.restored('workspace')`）；恢复回滚交 `backInTrash: undo.restored('dir')`；
   其余路径不交事实（缺省即「确实已离开」）。
3. **批量通告不进来**：批量恢复由 `src/verbs/batch.ts` 发起、调同一个 `announceRestored(ids)`（ADR-0002；接口为什么收成一条见 ADR-0014）。
4. 不叠第二层 `catch`：`HostPort` 的三条方法按契约不抛；通告失败不翻动词结果这条语义留在端口。
5. **「通告补在 journal 哪一拍」也归这里**：`withPresenceTail(presence, journal, tail)` 给一次成员移动接上在场尾巴——`run` 完全成功之后按 `onDone` 补离场，`undo` 之后按逐步结果发归位或离场。删除与恢复曾各手拼一份逐字相同的匿名 journal，只差键 → 事实的映射；那份顺序留在两处就是第二个家。哪些键算归位仍由动词读 `restored(key)` 交进来。

> **就地订正（2026-10-21，ADR-0008）**：删除不再归档，可见性不是这次删除改过的事实 ⇒
> `memberBack` 的第三件 `visibleBack` 已删除，现在只判 `diskBack && workspaceBack`。
> 正文与表格保留当时的裁决。

## 边界

- 不做通用「在场框架」：它只服务「成员在会话列表里是否可见」这一件事。
- 不读 journal 的键：`withPresenceTail` 拿住 `Journal` 只为把 `run` / `undo` 两拍连上通告，`JournalUndo`
  原样交给调用方的 `onUndone`；哪些键算归位仍由调用方把 `restored(key)` 读成事实再交进来（删除侧同理交
  `dir` / `workspace` 两件事实）。
- 不改事件名、载荷形状与调用顺序（现有用例钉着 `rename → evictLive → announceRemoved`）。

## 后果

- 六处调用各缩成一行事实；删除与恢复不再自己拼那份带通告的 journal，只在 `withPresenceTail` 那一次装配里说「补哪一拍」。`unknown`、「几件写都回去」与「通告落在 run / undo 哪一拍」三条判据各只有一个家。
- 测试落点：module 单测覆盖三态与四种事实组合，尾巴工厂单独覆盖「通告落在 journal 之后」「journal 抛 ⇒ 一条不发、原错误照抛」「逐步结果原样交回」；现有动词用例继续钉调用顺序；
  一条源码扫描用例钉住「`evictLive` / `announceRemoved` 只有 member-presence 调，`announceRestored`
  另许批量恢复一处」（`tests/member-presence.test.ts`）。
- 新增词条「成员在场」与 `docs/architecture.md` §4 的主人行。

## 被否掉的替代

- **只收通告、不收 `evictLive`**：三态判断会留在六处调用，协议仍然散着。
- **调用方算好一个布尔再交给 module**：「三件写都回去」的真值表继续住调用点，正是这次要收的东西。
- **module 直接读 journal 的键来判归位**：那会把 module 耦合到 journal 的键与实现；`withPresenceTail` 只把 `JournalUndo` 原样转交，事实仍由调用方交进来。
- **把批量恢复的通告也收进来**：一个 module 同时拥有单成员与整批两种通告粒度，违背 ADR-0002。

锚点：`CONTEXT.md`（成员在场 / 通告）；`src/verbs/member-presence.ts` 的 `memberGone` / `memberBack` / `withPresenceTail`；`tests/member-presence.test.ts`；`docs/architecture.md` §4
