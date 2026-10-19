# 开发与验证

这份文档是贡献者的入口：构建、本地调试、门控、真机验证与发版。用户怎么装、怎么用，见 `README.md`；模块为什么这么切、某条语义归谁，见 `docs/architecture.md`；裁决见 `docs/adr/`。这里只写「怎么做」与「怎么验」。

## 构建与日常开发

```powershell
git clone https://github.com/xrn1997/dsh-session-delete.git
cd dsh-session-delete
pnpm install
pnpm build        # 两步：tsdown 出台面 JS + tsc 出 lib/types/**/*.d.ts；顺序不能反
pnpm test         # vitest run
pnpm typecheck    # tsc --noEmit
```

**`lib/` 是构建产物且不入库**，任何从源码目录链进 profile 的安装方式都不会替你构建它——先 `pnpm build`。

改动生效分两半：**浏览器半**（`src/client/`）由宿主 HMR 推到浏览器，无需重启；**Node 半**不在热重载链路内，必须重启宿主。

> **跑门取退出码，别看管道说了什么**：`pnpm test | tail` 之后退出码是管道工具的，红会被吃掉。先把输出灌进文件、再单独打印退出码；**跑门与提交必须是两条命令**。

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
4. 真机验收清单按批次写在两份 `docs/design/` 日志的「真机门（交用户）」段——**代签不了**：构建绿与单测绿只证形状与逻辑，不证激活。

## 发版流程

1. **三道门**：`pnpm typecheck`、`pnpm test`、`pnpm build`，退出码逐个看过（0/0/0）。
2. **版本前移**：`package.json` 的 `version` 提一笔 `chore: 发版 x.y.z`；提交、打 annotated tag `Vx.y.z`、push。
3. **`npm publish`**：`prepack` 会跑 `build`；`files` 是**精确清单**——构建每新多出一个要发布的产物，就要同时加进 `files`（`lib/client.js.map` 就是故意留在盘上不进包的）。发完核对 npm 清单上的 `engines.dsh` 与 `dshReleases` 是否已落到产物上。
4. **README 徽章**与「真跑过」名单按当次实测代次更新（徽章读 npm `latest` 清单，工作树改了不会变）。

## 已知的环境坑

- **Windows 沙箱下 node 的子进程 spawn 一律 EPERM**：vitest 起 esbuild 服务会撞上——那不是本仓代码的问题，换个不受限的执行环境即可。
- **npm cache EPERM**：`npm view` 偶尔撞 `AppData\Local\npm-cache` 临时文件锁，重试或换查询方式。
- 回收站的运行时数据不在本仓：`~/.dsh/session-trash/`（本体）与 `~/.dsh/storages/`（内部索引，别手碰）。
- 会话文件是**多帧** zstd，Node 自带 API 只给第一帧——读法与实测住 `docs/design/2026-10-15-trash-detail-design.md` §1.1 / §1.4。
- **冒烟启动宿主时日志里那行带 token 的 URL 是活的凭据**：别留在日志或会话输出里，测完删文件。
- `.qoder/repowiki` 是生成的知识库快照，仓内没有再生成它的路径——**过期产物，与代码冲突时以代码为准**（状态记录住现状稿第十七批末段）。
