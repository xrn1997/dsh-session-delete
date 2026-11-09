# 会话菜单注册为什么从组合根分出去

Status: accepted

客户端条目注册仍只有 `src/client/index.tsx` 一张贡献表 + 一个注册循环；唯一例外是会话菜单那两行与 `contextMenu.icon` 的两个 key，归 `src/client/context-menu-actions.tsx` 的 `installSessionMenus`，由 `index.tsx` 调一次。例外只到「菜单这一项贡献什么」，不把勾选行的 live 读法也塞进菜单模块（后者住 `src/client/session-live.ts`）。

## 背景

0.2.2 起会话菜单有两条轨：`ctx.contextMenus` 数据动作与旧宿主的 legacy 槽位行。两条轨互斥、数据动作要恢复 Archive → 多选 → 删除的顺序、`contextMenu.icon` 的两个 key 与菜单贡献共用同一份注册身份；这套协商放进 `index.tsx` 会让组合根同时承担「十一个槽位怎么注册」与「菜单这一项怎么双轨协商」两件无关的事。与此同时，十一段手写 `slots.inject` 收成一张贡献表 + 一个注册循环：装配面只写一遍，菜单是唯一例外。

## 决定

1. **注册表与注册循环仍住 `index.tsx`**：槽位 / 元数据 / 注入面 / 组件各一格，`index.tsx` 仍是唯一知道「本插件占了哪些座位」的地方。
2. **菜单两行与两个 icon key 归 `installSessionMenus`**：双轨互斥、迟到切换、数据动作与 legacy 行的顺序只在这个文件回答；`index.tsx` 只调一次，不再展开菜单细节。
3. **例外不外溢**：勾选行的 live 读法住 `session-live.ts`，菜单模块不因为勾选行而变；`plugin.ts` 只放两份与包名同源的注册身份（包名与点号前缀），调用点不另写字面量。

## 边界

- 不是把所有槽位拆成每文件一个模块：贡献表仍是唯一的装配面，`index.tsx` 仍是唯一注册点。
- 不是让菜单模块自己决定「要不要注册」：探测与激活仍归 `index.tsx`；`installSessionMenus` 只在激活后调用。
- legacy 路径没有 `disabledReason`，运行中禁用只能改 label；这条既有边界不因分文件而改变。

## 被否方案

- **把双轨协商留在 `index.tsx`**：组合根继续长；菜单的顺序与互斥藏在十一段注册之间，下一次改菜单要读完整张表。
- **把勾选行也搬进菜单模块**：两类变化绑在一起，菜单模块会因勾选行的读法而变（Divergent Change）。
- **抽一个事件总线 / 全局 store 给菜单与勾选行**：多一层间接，仍然没有回答「菜单这一项贡献什么」；现有 `useSessionLive` 的 root hook 读法已经够窄。

锚点：`src/client/index.tsx`；`src/client/context-menu-actions.tsx` 的 `installSessionMenus`；`src/client/session-live.ts`；`src/client/plugin.ts`；`AGENTS.md` 的客户端注册硬约束；`docs/architecture.md` §3；`tests/client/index.test.tsx`；`tests/client/context-menu-actions.test.tsx`。
