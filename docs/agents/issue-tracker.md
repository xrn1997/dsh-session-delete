# Issue tracker: GitHub

本仓的 issue 与 spec 住在 GitHub Issues。所有操作走 `gh` CLI；仓库从 `git remote -v` 推断，在 clone 内运行时自动命中。

## 约定

- **建 issue**：`gh issue create --title "..." --body "..."`，多行 body 用 heredoc。
- **读 issue**：`gh issue view <number> --comments`，并取回 labels。
- **列 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需加 `--label`、`--state`。
- **做成子 issue**：`gh issue create --parent <parent> ...`，或 `gh issue edit <parent> --add-sub-issue <child>`（`gh` 2.94+）。
- **评论**：`gh issue comment <number> --body "..."`
- **加/去标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

## PR

**PRs as a request surface: no.**（外部 PR 不当作功能请求；`/triage` 读这一行。）

功能请求先开 issue；PR 只对已讨论或已关联 issue 的改动开放。审 PR 时用 `gh pr view` / `gh pr diff`，评论、标签、关闭走 `gh pr comment` / `gh pr edit` / `gh pr close`。

GitHub 的 issue 与 PR 共用一个编号空间，裸 `#42` 可能是两者之一：先 `gh pr view 42`，失败再 `gh issue view 42`。

## 技能里的两种说法

- 「publish to the issue tracker」→ 建一个 GitHub issue。
- 「fetch the relevant ticket」→ 跑 `gh issue view <number> --comments`。

## Wayfinding 操作

供 `wayfinder` 使用。**地图**是单个 issue，**子票**是它的子 issue。

- **地图**：一个打了 `wayfinder:map` 标签的 issue，装 Notes / Decisions-so-far / Fog。
- **子票**：作为地图的 GitHub sub-issue 关联；标签 `wayfinder:<type>`（`research` / `prototype` / `grilling` / `task`），认领后指派。
- **阻塞**：用 GitHub 原生 issue dependencies；`Blocked by: #<n>` 只在不可用时兜底。
- **前沿查询**：列地图的未闭子票，丢掉有未闭阻塞方或已有指派人的；地图顺序最前的胜出。
- **认领**：`gh issue edit <n> --add-assignee @me`。
- **了结**：评论答案、关闭子票，再把要点与链接追加到地图的 Decisions-so-far。