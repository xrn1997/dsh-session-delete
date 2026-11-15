# 贡献指南

## 提交信息

提交信息用 conventional commits：

```
type(scope): 描述
```

- `type`：`feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `build` / `perf`；没有合适的类型就先看最近的历史，别硬套。
- `scope` 可省；按模块或类型切提交，跨模块时用逗号并列（如 `api,client`）。
- 描述用中文、尽量动词前置、不写句号；一个提交只做一类改动，正文讲为什么。
- 过程计划、审查草稿、采样脚本不入库；留在本机 `.superpowers/`，见 `.gitignore`。

## Issue 与 PR

- 工单住 GitHub Issues，用 `gh` CLI；标签与 triage 约定见 `docs/agents/issue-tracker.md` 与 `docs/agents/triage-labels.md`。
- 功能请求走 Issue，说清场景与期望；PR 建议关联已有 Issue，并写清改动面与验证证据。外部 PR 不当作功能请求。
- 维护者可能要求先讨论再合并；外部 PR 与功能请求分开处理。

## 提交前

- 至少跑 `pnpm typecheck` 与 `pnpm test`，**两条命令同批跑并确认退出码**；完整门控 `pnpm gates` 与文档门三件套的判据见 `docs/development.md` 的「门（自动）」。
- 客户端半改动必须先在有可见浏览器的隔离 home 验过；Node 半改动要重启宿主。走法见 `docs/development.md` 的「真机验证」。
- 行为变化同步更新测试与相关文档；架构级决定写 ADR，格式见 `docs/adr/ADR-FORMAT.md`。

## 发版边界

- 版本号、tag 与 `npm publish` 由维护者执行；贡献者不要自行 bump 或发布。
- 发版步骤、两条渠道的资产与 `files` 精确清单全住 `docs/development.md` 的「发版流程」；这里只规定谁能发。
- 发布历史见 `CHANGELOG.md`；贡献按 Apache-2.0 授权，与仓库许可一致。
