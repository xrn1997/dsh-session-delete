# 恢复通告收成一条按 id 的方法：预取归 adapter

Status: accepted

`HostPresencePort` 的恢复通告曾分成三条：单条发送、整批预取、整批发送；调用方必须记得先预取再发，才能避免每条一次宿主全表扫。现在只留 `announceRestored(ids)`：实现拉一次宿主会话表，按 id 逐条发 `api-session/added`；单条就是长度为 1 的批。

## 决定

1. 恢复通告只有 `announceRestored(ids)`；预取收进 adapter，调用方不再传 `known`。
2. 批量恢复仍由 `src/verbs/batch.ts` 发起一次；删除组回滚与单成员归位经 `src/verbs/member-presence.ts` 调 `announceRestored([sessionId])`（长度为 1 的批）。
3. 通告是收尾：缺席 id 不发，监听者抛错不翻动词结果。

## 边界

- 不改 `api-session/added` 的载荷形状与“摘要取自宿主会话表”的口径。
- 不改批量归 `src/verbs/batch.ts`（ADR-0002）与单成员归 `src/verbs/member-presence.ts`（ADR-0005）。
- 删除组回滚仍逐成员通告：每个成员一次长度为 1 的批、各拉一次会话表；这一批不回收集合改成一次通告
  （回滚由 journal 逐成员驱动，不在本决定范围）。
- 不把通告失败折成动词失败，也不新增“先问服务在不在”的探针。

## 被否掉的替代

- **保留单条 + 批量预取 + 批量发送三条方法**：调用方仍要记得预取；单条与批量两条路会继续分叉，100 条按条拉表就是 100 遍全表扫。
- **让调用方传 `known`**：预取义务仍在调用方，漏传就退化成每条一次。
- **保留 `announceRestoredBatch` 作为别名**：同一件事两条入口，调用方仍要猜该用哪条。

锚点：`src/ports/host-port.ts`；`src/verbs/batch.ts`；`src/verbs/member-presence.ts`；`tests/assembly.test.ts`；`tests/batch.test.ts`；ADR-0002、ADR-0005、ADR-0007
