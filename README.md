# dsh-session-delete

给 DeepSeek Harness（DSH）加一个**删除会话**的能力。DSH 官方有归档，没有删除——归档只是把会话从列表里挪走，文件还在。本插件补上删除，并且让删除**可恢复**：删除 = 移入回收站，另有一个显式的"彻底删除"。

> **状态：已实现并接通**，四个动词（`list` / `delete` / `restore` / `purge`）走宿主 web server 上的插件专属前缀路由 `/dsh-session-delete-api`。
> 设计（触点、边界、错误形状、验证门、界面规格 §7）：[`docs/design/2026-09-30-session-delete-design.md`](docs/design/2026-09-30-session-delete-design.md)

## 安装

插件走宿主自己的插件管理（`dsh plugin`）。**宿主对插件有一道安装闸**：拿运行中的宿主版本逐项比对插件的 `@deepseek-ai/dsh*` peer 区间，不满足就拒绝并回滚——所以本插件只声明**真的跑过**的宿主版本（见下"兼容性"）。

本仓（本地开发，已实测）：

```bash
pnpm build                    # lib/ 是构建产物、不入库；从源码目录 link 进去不会替你构建
dsh plugin --profile <profile> add "link:<本仓绝对路径>"
```

按名安装（需该包对 profile 的包管理器可达）：

```bash
dsh plugin --profile <profile> add @xrn1997/dsh-session-delete
```

装完**重启宿主**（Node 半改动不走 HMR）。

## 用法

两个入口：

- **删除**：会话条目右边的「…」菜单 → 「删除」→ 确认框 → 会话进回收站。**正在运行的会话这一行是置灰的**（提示"会话正在运行，先停止再删除"）——不替用户终止正在进行的活。
- **回收站**：侧栏面板列表里常驻的「回收站」一行（与「插件 / 任务 / 小说」同层；**不带计数角标**，条数与合计占用在面板头部）。清单按项目分组，每条可以**恢复**或**彻底删除**，也可以整站清空。

回收站本体在 `~/.dsh/session-trash/<时间戳>-<原目录名>/`，清单在宿主 storage domain（介质在 `~/.dsh/storages/`）。**不自动过期**——不设天数上限，清空是显式动作；界面显示条数与占用。

取数通道拿不到时（例如插件没装成功），四个入口**一个都不注册**：页面上看不出本插件的存在，但**不会因此把宿主拖死**。

## 兼容性

只声明当前 desktop 发行版：**DSH Desktop 0.2.0-rc.2**（`package.json` 的 `dsh.compatibility.dshReleases`，状态 `compatible`）。跟版策略未裁定——每跟一个 rc 都要在新宿主上重跑验证门（设计稿 §8）。

## 开发

```bash
pnpm test        # vitest run
pnpm typecheck   # tsc --noEmit
pnpm build       # tsdown（含浏览器半的纯度门）
```

## 许可

Apache-2.0，见 [`LICENSE`](LICENSE)。
