# dsh-session-delete — 给 agent 的工作须知

DSH 的「会话删除」插件。需求的来由、已定的选择与实测边界都在设计稿里，这里只放**跨改动复用的不变量**与**实现前必须先验的前提**。

## 真相在哪（按顺序读）

1. **`docs/design/2026-09-30-session-delete-design.md`** — 现状设计：四个触点、边界、错误形状、验证门、已定的选择与被否决的替代。
2. **`docs/design/session-delete-ui.html`** — 界面稿（五个状态）。
3. **代码与测试** — 最终真相。文档与代码冲突时以代码为准，并顺手把上面两处改正。

## 硬约束（本仓不变量）

- **`peerDependencies` 是宿主的安装闸，不是自述**：`dsh plugin add` 拿运行中的宿主版本逐项比对插件的 `@deepseek-ai/dsh*` peer 区间，不满足即拒绝并回滚 ⇒ 区间只能逐代显式开口，semver 预发布规则下没有"免维护写法"；`dsh.compatibility.dshReleases` 只列**真跑过**的宿主、状态词只许 `compatible`；编译所依用精确版本。**两层的分工别混**：混了就会出现"声明兼容却装不进去"。
- **宿主类型面用本地窄镜像**（只声明用到的成员 + 一次强转），**不装宿主类型包、不做 `declare module` 增强**：npm 上的宿主包与运行中的宿主不同代，引包等于拿错了契约；`extends Context` 还会撞 TS2717。
- **跨插件一律 `import type`**，值 import 是与生态的红线；浏览器半只能 require 宿主**冻结平台模块表**内的东西，该表取各代宿主的**交集**（并集里的每条多出来的都是纯度门的一次豁免）。
- **工具名/服务名带插件专属前缀**：宿主对重名**直接抛错**（不是显示难看，是整个工具面挂掉）。
- **槽位只挂官方已声明的**：向未声明槽位注册、或重复声明别人已拥有的 child，都会在**插件激活时**失败——所以撞槽位是响亮失败，不是静默降级。
- **`lib/` 是构建产物，不入库**；从源码目录链进 profile 的安装方式不会替你构建它。

## 实现前必须先验的前提（未成立，别当已成立）

- **两个槽位名未经撞击验证**：`sidebar.workspaces.session.menu.item`、`sidebar.footer.action` 是从宿主包字符串读出来的（官方文档没有槽位清单）。
- **`ctx.workspaceController` / `attachSession` 在第三方插件里能否注入**：官方文档只说 "GUI clients interact via the controller"。若注入不到，退化路径是只做文件层 + 自维护账本——**届时先回来改设计，不擅自降级**。
- **删除后投影缓存会不会留幽灵行**：设计稿验证门 1 的实验，结论决定要不要连缓存行一起丢。

## 环境坑

- **运行时数据不在本仓**：会话本体 `~/.dsh/sessions/<转义cwd>/<会话目录>/session.vN.jsonl.zstd`；账本与缓存 `~/.dsh/storages/`；回收站计划在 `~/.dsh/session-trash/`。会话文件是 zstd 压缩的 JSONL，**第一行即 header**（含 `id` 与 `cwd`），Node 24 自带 `zlib.zstdDecompressSync` 可直接读。
- **改动的生效路径分两半**：浏览器半走宿主 HMR；Node 半必须重启宿主。
- **验证要有界**：冒烟启动宿主时日志里那行带 token 的 URL 是活的凭据，别留在日志或会话输出里，测完删文件。
