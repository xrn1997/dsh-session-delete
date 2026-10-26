# 在场能力从宿主端口里拆成 CoreDeps.presence

Status: accepted

ADR-0007 把宿主能力按身份 / 在场 / 语料切成三片；它当时把「不拆依赖字段」写进边界，`DeleteDeps.host` 是整颗 `HostPort`。但摘活体与两向通告仍只许经 `src/verbs/member-presence.ts` 调用，这条边界此前只能靠源码扫描维持——动词在类型上完全够得到 `evictLive` / `announce*`。决定：`CoreDeps.host` 收成 `HostCorePort`（不含在场三件），在场能力改由 `CoreDeps.presence` 交一份 `PresenceCapability`；身份与语料两片、`CorpusRead` 与缺席策略照 ADR-0007。

## 边界

- 取代范围：ADR-0005 与 ADR-0007 整篇转为 `superseded by 0019`；0005 的「离场 / 归位通告只住 `member-presence` 一个家」、0007 的角色切分与语料面照旧，本篇反转的是 0007 的「不拆依赖字段」与 0005 的「批量通告不进来」。
- 实现仍只有 `src/verbs/member-presence.ts` 一份，端口形状住 `src/ports/presence-port.ts`；`announceRestored(ids)` 仍是批量恢复的唯一通告口（ADR-0014）。
- 三处类型名不是三份实现：`HostPresencePort` 是宿主角色面（ADR-0007），`PresenceCapability` 是动词面，`MemberPresenceHost` 只是宿主面的 `Pick` 窄化（端口将来长出新方法时不被动变宽）；方法体只有 `createMemberPresence` 一份，`tests/deps.test.ts` 钉住能力面恰三条与实现唯一。
- 不拆 adapter：`createHostPort` 仍是一颗对象；组合根只在装配时用整颗 host 造 presence。
- 不拆身份与语料字段：`HostCorePort` 仍把这两片合在一颗 `host` 上；一条动词流程里它们本来就连着用。

## 被否掉的替代

- **维持整颗 `HostPort` + 源码扫描**：类型面继续把三条危险方法交给每个动词，扫描只能事后发现。
- **三片各给一个依赖字段**（identity / presence / corpus）：身份与语料在一条流程里连着用，拆开只是把装配搬到每个调用点；只拆在场这一片已够把危险能力收口。

锚点：`src/ports/presence-port.ts`；`src/verbs/member-presence.ts`；`src/deps.ts`；`tests/deps.test.ts`；ADR-0005；ADR-0007。
