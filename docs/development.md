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

**`lib/` 是构建产物且不入库**，任何从源码目录链进 profile 的安装方式都不会替你构建它——先 `pnpm build`。分发路：`link:` 要自己构建；npm 与 `pnpm pack` 由 `prepack` 兜；GitHub Release 资产由发版工作流在 tag 上预构建（见「发版流程」）；源码 git 直装没有构建（本仓没有 `prepare`，那条路现在是死的）。

改动生效分两半：**浏览器半**（`src/client/`）由宿主 HMR 推到浏览器，无需重启；**Node 半**不在热重载链路内，必须重启宿主。

## 本地源码调试

```powershell
pnpm build        # 必须在源码目录手动跑一次
dsh plugin --profile <profile> add "link:<本仓绝对路径>"
```

`link:` 只建目录链接、不替你构建；卸载只移除插件，`$DSH_HOME/session-trash/`（默认 `~/.dsh/session-trash/`）下的已有目录不会被清理。

## 门（自动）

门的唯一入口是 `pnpm gates`（typecheck / lint / test / build / pack dry-run，任一红即红；pack 不重复跑 build）；`pnpm typecheck` 与 `pnpm test` 仍必须同批跑。最后一格 `pack:dry` 的执行体是 `scripts/verify-pack.mjs`：期望树从 `files` 展开，并加上包必带的 `package.json` 与它声明的挂载面（main / types / icon / exports / dsh.bundle.patch），与 `npm pack --dry-run --json` 的实际文件集**双向对账**（缺一件红、多一件也红、混进 sourcemap 红），再把 `lib/` 构建树逐文件对回 `files`，最后做语法检查与 `import lib/index.js` 的模块面冒烟。发版 tarball 用同一支脚本的 `--tarball` 模式，判据只有一份。

### 编译器档位与 lint 归属

`tsconfig.json` 在 `strict` 之上开着 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`erasableSyntaxOnly`、`noFallthroughCasesInSwitch`、`noImplicitOverride`；取舍与弃选项住 `ADR-0030`。纪律：

- `engines.node >= 24` 是不可擦除语法判据的前提，不是装饰。
- 测试夹具取位走 `tests/support/fixture.ts` 的 `must` / `pick`，越界即抛；不许改成 `?.`。
- `no-unnecessary-condition` 的「保留」命中（闭包写入、宿主窄镜像、`lib.dom` 撒谎）逐条带注释；确证误报的 `eslint-disable` 逐条带理由。
- lint 与 tsc 的分工：`tsc` 管类型形状，**`any` 归 ESLint**。

GitHub Actions 在 push 到 `main` 与每个 PR 上跑 `pnpm gates`（`.github/workflows/ci.yml`，Ubuntu 与 Windows 两条腿；主开发平台是 Windows，只在 Linux 上跑会放过路径分隔符一类回归）；pnpm 版本由 `package.json` 的 `packageManager` 指定。发版工作流 `.github/workflows/release.yml` 在 `V*` tag 上调同一个 `gates`。**真机验证不在 CI 内**。

> **跑门取退出码，别看管道说了什么**：`pnpm test | tail` 之后退出码是管道工具的，红会被吃掉。先把输出灌进文件、再单独打印退出码；**跑门与提交必须是两条命令**。

**文档门是三件套**：`tests/docs-liveness.test.ts`（文档与代码注释的路径活性与引用形态、职责边界、ADR 形状、README 投影与截图清单）、`tests/context-terms.test.ts`（`CONTEXT.md` 点名的符号在生产代码里现查得到）与 `tests/comment-altitude.test.ts`（注释不抄代码表达式）；三者共用的解析器契约住 `tests/doc-anchors.test.ts`，它比较的路径一律是仓内 POSIX 写法。**具体判据以这些测试本身为准**：路径若有意保留历史名走 `ALLOWED` 白名单，加一条要写清为什么；死名没有豁免。

`pnpm typecheck` 也带一道门：`tsconfig.json` 开着 `isolatedModules` 与 `verbatimModuleSyntax`，所以「跨插件一律 `import type`」不是风格建议——把类型面写成值 import 直接编译红。另一条「浏览器半一条 `@deepseek-ai/*` 的 import 都不许有，type-only 也不留」不归编译器管：宿主包就装在 `devDependencies` 里，值 import 照样解析得到。那一半的门是 `pnpm test` 里 `tests/skeleton.test.ts` 的「跨插件 import 红线」源码扫描。

### 复核门（改过那一层就要过）

- **界面保真复核门**（改动 `src/client/ui/*` 之后）：与官方明文**逐属性比对零差异**（token 引用按 `--sd-*` 别名层还原成它引用的 `--dsw-*` 再比，见 `src/client/ui/ui.css` 文件头的别名层说明）；来源表与已知差异只住 `src/client/ui/ui.css` 文件头那一处，`tests/skeleton.test.ts` 钉那张表点名的自造差异与浮层层级。
- **纯度门**（浏览器半的 import 面）：白名单是 `tsdown.config.ts` 的 `PLATFORM_MODULES`，只列真正在用的宿主冻结模块；非宿主的 npm 依赖落 `devDependencies`（构建期内联，生产依赖必须为空）、不进 `PLATFORM_MODULES`，可以 inline；带 `imports` 分流的依赖走同文件的 `resolveBrowserBranchImport`——只认那类 `#` 请求，且同级真有 `.browser.js` 才接，否则返回 `null` 让纯度门重新响。
- **宿主换代**：先跑 storage domain 的真实 `open` 冒烟；记录 schema 只依赖 `valueSchema.parse` 的契约见 `src/trash/storage-manifest.ts` 头注与 `tests/assembly.test.ts` 的 storage 用例。

### 宿主换代复核（升级前逐条看）

- **通道**：`ConnectionFetchRoute`（本仓窄镜像 `ConnectionFetchRouteLike`）的形状与宿主 `/api` 的 owner / 鉴权行为；锚点 `src/api/connection-route.ts`、ADR-0033。
- **槽位**：贡献表点名的槽位仍是宿主已声明的官方槽位；名单与出处住 `src/client/index.tsx` 头注。
- **主题**：用 `Theme.listTokens` 对照公开 token 面；新 token 的落法与已知差异见 `src/client/ui/ui.css` 头注，`tests/skeleton.test.ts` 钉别名层。
- **行归属**：`data-row-key` 仍以 `session:` 前缀命名（点击守卫、范围勾选与拖放起拖都读它）；锚点 `src/client/batch-pick.ts`、`src/client/trash-entry.tsx`、ADR-0034 / ADR-0071。
- **面板行结构**：`sidebar.panellist` 的行仍是包含 glyph 的 `<button>`（拖放命中与红色高亮按它收口）；锚点 `src/client/trash-entry.tsx`、ADR-0071。
- **维护卡**：`plugins.bundle.config` 仍是宿主提供的 bundle 配置槽；理由住 ADR-0021。

## 真机验证（硬约束，别跳）

**客户端半的条目激活失败 = 宿主进程死**（`web boot: N entry did not activate` ⇒ 桌面壳 `reportFatal`）。所以：

1. **改动 `src/client/` 后**，先在**有可见浏览器的隔离 home**（临时 `DSH_HOME`，镜像目标 profile 的插件组成）上验「页面加载 + 槽位注册 + 控制台零 error/warn」，再装进任何 live profile。台架走法：`DSH_HOME=<临时目录> dsh --profile <名> --from-default-profile web --no-open --port 0`，浏览器看控制台。指针驱动的交互在没有可视视口的环境里测不了，那部分交真机目视。0.2.2+ 的菜单数据动作还要目视确认「归档 → 多选 → 移入回收站」顺序、没有 legacy 重复行、运行中显示「移入回收站（运行中）」；≤0.2.1 的 legacy 路径（tooltip + order 850/900）由单测覆盖，有旧宿主时再补一次真机。归档档另目视：切档、宽/窄自动选中与下钻、已归档父会话的子会话只读打开、未归档孩子的状态行、解除归档后清单消失、移入回收站后撤销回归档；宿主归档旁路观察缺席时只留 `console.info`、不出现 error/warn。
2. **改动 Node 半后**必须重启宿主。
3. **`xrn1997.dshReleases` 只列桌面真机跑过的代次**（`tests/skeleton.test.ts` 双向钉）；CLI 台架读数只用于定 `engines.dsh` 地板，不进那份名单。
4. 真机验收清单随对应 issue/PR 或提交说明走——**代签不了**：构建绿与单测绿只证形状与逻辑，不证激活。
5. **移入回收站 → 恢复后的对话门（2026-10-21 真机事故）**：把一个**打开过**的会话移入回收站 → 从回收站恢复 → 直接发一条消息。**已触发**的信号是消息出现在对话里、会话日志增长并得到回复；只有重启宿主后才恢复 = 旧 agent 没被完整摘掉（ADR-0008）。恢复后若仍停在「会话不可用」，那是宿主常驻 `Session` 的 `removed` 粘性状态——当前实现会在把当前视图的会话移入回收站时关掉它、撤销后重开（`src/client/main-view.ts`）。单测覆盖插件侧的收尾判据；宿主 `ctx.agents` 的生命周期与宿主客户端常驻 `Session` 的 `removed` 粘性仍只能真机走。
6. **附件门**：造一条带图片（和普通文件）的会话 → 移入回收站 → 打开详情确认图片可见、可放大、文件可下载 → 恢复 → 再移入回收站 → 彻底删除 → 确认 `.dsh/attachments/v1/objects` 里该对象消失、源文件仍在；另一条会话共享同一张图时，彻底删除一条后另一条仍能看图。
7. **设置页维护卡门**：重启宿主 → 打开插件详情页 → 「维护」卡出现，三段都在「尚未检查」（挂载不发请求）→ 点「检查」孤儿附件：报告应显示当前本机已有的无引用对象数与体积（应与盘上当下真实孤儿一致；清完重查归零）→ 「查看并清理」先列图片缩略图（点开可放大、关闭不删），正文说清只清 `.dsh` 内无引用图片副本、源文件不受影响、共享引用保留 → 清理后重查为 0。孤儿会话段同样走「检查 → 预览 → 清理」。投影缓存段走「检查 → 确认 → 清理」：刚彻底删除的会话会被顺手清缓存，**不会留下记录**；清理后重查为 0，还在册与还在回收站的会话记录不受影响；确认框是普通主按钮（派生数据可重建），清理不改写清册。最后看一眼回收站面板：没有孤儿横幅、也没有孤儿提示，挂载与写后重读都不发 `GET /orphans`。
8. **LAN / 反代门（改动 `src/api/connection-route.ts` 之后）**：宿主绑到具体 LAN IP（宿主拒绝 `0.0.0.0`），用另一台机器打开 `dsh web` 打印的 URL → 入口出现，移入回收站 / 恢复 / 回收站全通；同一地址在**未带**宿主 cookie 的形态下打 exact 路由（`GET /api/dsh-session-delete-api/ping`）应被宿主 `/api` 拒（**401** 纯文本；个别代次可能是 403）；再从**同 IP 不同端口**的页面拿 `<img>` 打附件段（或带 `Sec-Fetch-Site: same-site` 复用 cookie 打 `/attachment`），应回 **403 + 失败信封**（插件的同源取数闸，ADR-0033）。
9. **Release 资产装机门（改动 `.github/workflows/release.yml` 或 README「安装」的 Release 那条之后）**：拿一个真实 tag 的资产从干净 profile 装一次。第一件要验的是宿主收不收 URL 形态的 `add` 参数——桌面 0.2.2-rc.3（2026-11-15）实测**不通**：宿主把 URL 原样交给 bundled pnpm，`fetchDirect` 连败（同一条 URL 用仓库 pnpm 直装能过）；README 已按这条读数退回离线分发，离线分发（`pnpm pack` 出 `.tgz` 再 `add <tgz>`）同机实测装得上、激活正常。宿主代次变了要重验这条，通了再改回 README。装完重启宿主，按本节第 1、2 条验激活与日志。
10. **可调项卡门（改动 `src/client/config-settings.tsx` 或 `/config` 段之后）**：打开插件详情页 → 「可调项」卡读出三只当前值 → 改一个值保存 → Node 半这一行重启、卡片显示保存回执里的值；离开再回到插件详情页，卡片重新读取并显示落盘值；**重启宿主后仍生效**。再验两条失败面：输入 0 / 小数 / 超上限时保存禁用、那一行报「需为 min–max 的整数」，不调 `/config`；用一个没有 `configEditor` 的 profile 保存，应回 `io` 原文，不假装成功。

## 发版流程

1. **门**：`pnpm gates`，退出码看过。
2. **写发布记录**：在 `CHANGELOG.md` 追加这一版（新增 / 变更 / 修复 / 升级注意）；未发布改动不预写，历史版本不回溯改写，逐提交明细留 git。
3. **版本前移**：`package.json` 的 `version` 提一笔 `chore: 发版 x.y.z`；提交并 push。
4. **GitHub Release 资产（自动）**：给第 3 步的提交打 annotated tag `Vx.y.z` 并 push，触发 `.github/workflows/release.yml`——校验 tag = `V` + `package.json` 版本 → `pnpm gates` → `pnpm pack` → `node scripts/verify-pack.mjs --tarball` → 挂到 Release。**Release 正文**由 `scripts/release-notes.mjs` 从 `CHANGELOG.md` 该版条目与 `package.json` 事实投影（`--notes-file`，不用 `--generate-notes` 的 commit 列表；CHANGELOG 里没有该版条目就发不出来），`workflow_dispatch` 干跑也把正文随 artifact 传回预览。每个 Release 两份资产：版本名 `xrn1997-dsh-session-delete-<版本>.tgz` 与稳定别名 `dsh-session-delete.tgz`；tag 带 `-` 的按 prerelease 处理；Release 已存在时资产覆盖。**tag 排在 npm 之前**：GitHub 侧删了能重来，npm 同版本覆不回去。
5. **`npm publish`**：`prepack` 会跑 `build`；`files` 是**精确清单**——构建每新多出一个要发布的产物，就要同时加进 `files`。两半都不产 sourcemap，因此产物里不会留一个指向不进包文件的 `//# sourceMappingURL`。发完核对 npm 清单上的 `engines.dsh` 与 `xrn1997.dshReleases` 是否已落到产物上。`lib/types/**/*.d.ts` 对 `@deepseek-ai/cordis` 只有 type-only 引用：它在 `devDependencies` 里供本仓与声明文件解析，不是 peer、也不在运行期加载。
   - `locale/`（`locale/zh.json` + `locale/en.json`）是插件自己的**展示元信息**（`meta.title` / `meta.description` / `meta.detail`），与界面文案字典 `src/client/copy.ts` 是两样东西，改一边不必动另一边。`meta.detail` 点名插件详情页渲染的一行插图文档（`docs/DETAIL.zh.md`、`docs/DETAIL.md`，每语言一份）；不合规或文件缺失宿主按 `invalid` 报错、不回退 README（判据住 `tests/skeleton.test.ts`）。
   - 根目录 `screenshots.json` 列的是 README 那些真机图的清单；文档门钉住 README、清单与本地文件三方一致，换图时同批更新。详情短文档自带的插图（`docs/preview.zh.svg`、`docs/preview.svg`）与截图一样要进 `files`（判据住 `tests/skeleton.test.ts`）。
6. **README 徽章与「真跑过」名单**：真机徽章是手写字面量，必须按当次实测代次手改（文档门会从 `package.json` 校）；版本徽章读 npm `latest` 清单，工作树改了不会变。商店牌子读 npm `latest` 的 `engines.dsh`（超过 256 字符的范围串会被整条丢弃）；`xrn1997.dshReleases` 只是真机账本，宿主与市场都不读它。

## 已知的环境坑

- **Windows 沙箱下 node 的子进程 spawn 一律 EPERM**：vitest 起 esbuild 服务会撞上——那不是本仓代码的问题，换个不受限的执行环境即可。
- **npm cache EPERM**：`npm view` 偶尔撞 `AppData\Local\npm-cache` 临时文件锁，重试或换查询方式。
- **浏览器会缓存插件的 `lib/client.js`**（产物 URL 无哈希）：改浏览器半后，宿主重启、插件重装都可能仍在跑旧 bundle，**硬刷新页面**（Ctrl+Shift+R）才换新——「build 了没生效」先查这里。
- **同版本 tarball 重装会被 pnpm 静默跳过**：`dsh plugin add` 对同版本号视为已满足；真机台架换包要先 `remove` 再 `add`，装完用 `grep` 构建产物里的新符号确认。
- 回收站的运行时数据不在本仓：`$DSH_HOME/session-trash/`（本体）与 `$DSH_HOME/storages/`（内部索引，别手碰）；`DSH_HOME` 缺省是 `~/.dsh`。
- 会话文件是**多帧** zstd，Node 自带 API 只给第一帧——读法与用例住 `src/log/zstd-frames.ts` 与 `tests/zstd-frames.test.ts`。
- **冒烟启动宿主时日志里那行带 token 的 URL 是活的凭据**：别留在日志或会话输出里，测完删文件。
- **入库文本的换行由 `.gitattributes` 固定为 LF**；工作树可能被本机工具写成 CRLF，git 按属性归一后再入库。测试与文档门按 `/\r?\n/` 处理，不依赖工作树形态。
- **`.qoder/repowiki` 是生成的知识库快照，而且不入库**：它既不是事实源、也不随 clone 走；本机那份可能落后于代码，判断口径见 `docs/AGENTS.md`。
