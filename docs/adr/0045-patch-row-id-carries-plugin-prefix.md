# ADR-0045 — patch 行 id 带插件专属前缀，接受一次有意的破坏性改名

Status: accepted

`cordis.patch.yml` 里那一行的 `id` 过去叫裸名 `session-delete`。宿主按 id 寻址这一行：`configEditor` 只编辑「唯一寻址」的行，插件行的配置卡 key 是 `<包名>#<行 id>`，用户自己的 profile 覆盖也按它命中。本决定把它改成 `xrn1997-session-delete`，代价是旧 profile 里按旧 id 写的覆盖不再命中。

## 背景

`session-delete` 是一个通用词，任何装进同一个 profile 的包都可能给自己那行取同名。撞上的后果不是显示难看：那一行不再唯一可寻址，宿主的编辑与覆盖寻址都失去确定的目标，而这两件事都发生在用户看不见的地方。上一轮合规审计建议「不改」，理由是改名会打断已有 profile；两种代价都在用户身上，这条把天平压向「自带前缀」，因为撞名的概率随生态增长，而改一次名只付一次。

## 决定

1. **行 id 与工具名、服务名同规则**：带插件专属前缀，`xrn1997-session-delete`。同一枚前缀串也是包名的 owner 段，用户在 profile 里看到它就看出这一行归谁。
2. **破坏面写在 README**：0.6.1 及更早的行 id 是 `session-delete`；覆盖过这一行的 profile 升级后要同步改名，否则那份覆盖静默失效。
3. **三处同字**：`cordis.patch.yml`、README 的示例与 `tests/skeleton.test.ts` 的断言一起改，钉住它是为了避免下一次改名只改一半。

## 边界

- 不改 npm 包名、`SESSION_DELETE_API_PREFIX` 与 `$DSH_HOME` 下的目录名：那些是通道与已有数据的家，动它们会把破坏面从「一份覆盖」扩大到「用户已有数据」。
- 不改回收站条目 id 与会话 id 的形态。
- 撞名时宿主到底以什么形态失败（拆卸启动、还是保留其余插件并响亮警告），本仓没有真机读数；`tests/skeleton.test.ts` 的注释只说「行 id 是寻址键」，不把没跑过的失败形状写成事实。上游要的是 Loader 给第三方行做命名空间隔离。

## 后果

- 下一个版本的 `CHANGELOG.md` 必须把这条写进「升级注意」：它是对已发布 0.6.1 的破坏性改名。
- `docs/development.md` 与 README 里凡引用这一行的地方同字（文档门校验相对链接与点名路径）。
- 已经改过的 profile 不会被本插件替它迁移：本仓不写 profile，改 profile 归宿主（见 ADR-0043 边界的同一条判据）。

## 被否掉的替代

- **保持裸名、等宿主给行 id 命名空间**：根因确实在宿主没有分区，但上游不可控；在拿到之前，本仓能做的只有自带前缀。
- **只在文档里提醒用户别撞名**：把可机械避免的撞名留给用户发现，而发现方式是配置静默不生效。
- **改成包名全写 `@xrn1997/dsh-session-delete`**：id 不是 `name` 的镜像，那一行另有 `name` 承载包名；重复它会让寻址多一个歧义源。

锚点：`cordis.patch.yml`；`package.json` 的 `dsh.bundle.patch`；`README.md`「可调项」；`tests/skeleton.test.ts`；`docs/development.md` 的「真机验证」；ADR-0043。
