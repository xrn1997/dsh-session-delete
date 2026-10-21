# 开发与验证

这份文档是贡献者的入口：构建、本地调试、门控、真机验证与发版；提交信息与 PR 约定见 `CONTRIBUTING.md`。用户怎么装、怎么用，见 `README.md`；模块为什么这么切、某条语义归谁，见 `docs/architecture.md`；界面规格见 `docs/ui-spec.md`；裁决见 `docs/adr/`。这里只写「怎么做」与「怎么验」。

## 构建与日常开发

```powershell
git clone https://github.com/xrn1997/dsh-session-delete.git
cd dsh-session-delete
pnpm install
pnpm build        # 两步：tsdown 出台面 JS + tsc 出 lib/types/**/*.d.ts；顺序不能反
pnpm test         # vitest run
pnpm typecheck    # tsc --noEmit
```

**`lib/` 是构建产物且不入库**，任何从源码目录链进 profile 的安装方式都不会替你构建它——先 `pnpm build`。三条分发路：`link:` 要自己构建；npm 发布由 `prepack` 兜；源码 git 直装没有构建（本仓没有 `prepare`，那条路现在是死的）。

改动生效分两半：**浏览器半**（`src/client/`）由宿主 HMR 推到浏览器，无需重启；**Node 半**不在热重载链路内，必须重启宿主。

> **跑门取退出码，别看管道说了什么**：`pnpm test | tail` 之后退出码是管道工具的，红会被吃掉。先把输出灌进文件、再单独打印退出码；**跑门与提交必须是两条命令**。

`pnpm test` 里还有一道**文档门**（`tests/docs.test.ts`）：它扫 `AGENTS.md` / `CONTEXT.md` / `README.md` / `CONTRIBUTING.md` / `CHANGELOG.md`、`docs/**` 与 `src/**`、`tests/**` 的正文与注释，钉住点名的 `src/`、`tests/`、`docs/`、`locale/` 路径真实存在、已废的文档称呼不再出现、`§N` 指路活着、相对链接与锚点指得到东西、ADR 索引双向完整、README 截图清单与兼容性投影一致、主人清单/界面规格/文档标准各只有一份、根 `AGENTS.md` 预算；具体判据以该文件为准。路径若有意保留历史名走 `ALLOWED` 白名单，加一条要写清为什么；死名没有豁免。

## 复核门（改过那一层就要过）

- **界面保真复核门**（改动 `src/client/ui/*` 之后）：与官方明文**逐属性比对零差异**；来源表与已知差异（含条目与条数）只住 `src/client/ui/ui.css` 文件头那一处，`tests/skeleton.test.ts` 钉那张表点名的自造差异与浮层层级——差异只许文件头点名的那几类，别处不抄条目也不抄条数。
- **纯度门**（浏览器半的 import 面）：白名单是 `tsdown.config.ts` 的 `PLATFORM_MODULES`，只列真正在用的宿主冻结模块；非宿主的 npm 依赖落 `dependencies`（不是 `peerDependencies`）、不进 `PLATFORM_MODULES`，可以 inline，但带 `imports` 分流的依赖走同文件的 `resolveBrowserBranchImport`——只认那类 `#` 请求，且同级真有 `.browser.js` 才接，否则返回 `null` 让纯度门重新响（`unified → vfile` 的 `#minpath` 分流就是实例）。为什么这么收，见 `docs/architecture.md` §1 与 §2。

## 本地源码调试

```powershell
pnpm build        # 必须在源码目录手动跑一次
dsh plugin --profile <profile> add "link:<本仓绝对路径>"
```

`link:` 只建目录链接、不替你构建；卸载只移除插件，`~/.dsh/session-trash/` 下的已有目录不会被清理。

## 真机验证（硬约束，别跳）

**客户端半的条目激活失败 = 宿主进程死**（`web boot: N entry did not activate` ⇒ 桌面壳 `reportFatal`）。所以：

1. **改动 `src/client/` 后**，先在**有可见浏览器的隔离 home**（临时 `DSH_HOME`，镜像目标 profile 的插件组成）上验「页面加载 + 槽位注册 + 控制台零 error/warn」，再装进任何 live profile。台架走法：`DSH_HOME=<临时目录> dsh --profile <名> --from-default-profile web --no-open --port 0`，浏览器看控制台；指针驱动的交互在没有可视视口的环境里测不了，那部分交真机目视。
2. **改动 Node 半后**必须重启宿主。
3. **`dshReleases` 只列桌面真机跑过的代次**（`tests/skeleton.test.ts` 双向钉）；CLI 台架读数只用于定 `engines.dsh` 地板，不进那份名单。
4. 真机验收清单随对应 issue/PR 或提交说明走（本仓不再存批次日志）——**代签不了**：构建绿与单测绿只证形状与逻辑，不证激活。
5. **删除 → 恢复后的对话门（2026-10-21 真机事故）**：删除一个**打开过**的会话 → 从回收站恢复 → 直接发一条消息。**已触发**的信号是消息出现在对话里、会话日志增长并得到回复；只有重启宿主后才恢复 = 旧 agent 没被完整摘掉（ADR-0008）。恢复后若仍停在「会话不可用」，那是宿主常驻 `Session` 的 `removed` 粘性状态——当前实现会在删除当前视图时关掉它、撤销后重开（`src/client/main-view.ts`，ADR-0008）。单测覆盖插件侧的收尾判据（handle 捕获、主视图收尾）；宿主 `ctx.agents` 的生命周期与宿主客户端常驻 `Session` 的 `removed` 粘性仍只能真机走。

## 发版流程

1. **三道门**：`pnpm typecheck`、`pnpm test`、`pnpm build`，退出码逐个看过（0/0/0）。
2. **写发布记录**：在 `CHANGELOG.md` 追加这一版（新增 / 变更 / 修复 / 升级注意）；未发布改动不预写，逐提交明细留 git。
3. **版本前移**：`package.json` 的 `version` 提一笔 `chore: 发版 x.y.z`；提交、打 annotated tag `Vx.y.z`、push。
4. **`npm publish`**：`prepack` 会跑 `build`；`files` 是**精确清单**——构建每新多出一个要发布的产物，就要同时加进 `files`（`lib/client.js.map` 就是故意留在盘上不进包的）。发完核对 npm 清单上的 `engines.dsh` 与 `dshReleases` 是否已落到产物上。
   - 清单里的 `locale/`（`locale/zh.json` + `locale/en.json`）是插件自己的**展示元信息**（`meta.title` / `meta.description`），与界面文案字典 `src/client/copy.ts` 是两样东西，改一边不必动另一边。
   - 根目录 `screenshots.json` 列的是 README 那些真机图的清单；文档门会钉住 README、清单与本地文件三方一致，换图时同批更新。
5. **README 徽章**与「真跑过」名单按当次实测代次更新（徽章读 npm `latest` 清单，工作树改了不会变）。

   商店牌子读 npm `latest` 清单（`engines.dsh`；超过 256 字符的范围串会被整条丢弃）；`dsh.compatibility.dshReleases` 只是真机账本，宿主与市场都不读它。发版后现查 npm `latest`，别把某次读数写死。

## 已知的环境坑

- **Windows 沙箱下 node 的子进程 spawn 一律 EPERM**：vitest 起 esbuild 服务会撞上——那不是本仓代码的问题，换个不受限的执行环境即可。
- **npm cache EPERM**：`npm view` 偶尔撞 `AppData\Local\npm-cache` 临时文件锁，重试或换查询方式。
- 回收站的运行时数据不在本仓：`~/.dsh/session-trash/`（本体）与 `~/.dsh/storages/`（内部索引，别手碰）。
- 会话文件是**多帧** zstd，Node 自带 API 只给第一帧——读法与用例住 `src/log/zstd-frames.ts` 与 `tests/zstd-frames.test.ts`。
- **冒烟启动宿主时日志里那行带 token 的 URL 是活的凭据**：别留在日志或会话输出里，测完删文件。
- **`.qoder/repowiki` 是生成的知识库快照**：它的基线 commit 只记在 `.qoder/repowiki/knowledge/zh/_index.yaml` 里（要对照就现查那份，篇数与 hash 都不在这里抄——抄一次就多一个会腐烂的镜像）。仓内**没有**再生成它的路径（只能在 Qoder 里重跑），所以它永远可能落后于代码；它不是事实源，判断口径见 `docs/AGENTS.md`。
