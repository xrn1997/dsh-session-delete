# Issue tracker: GitHub

本仓的 issue 与 spec 住在 GitHub Issues。所有操作走 `gh` CLI。

## 约定

- **建 issue**：`gh issue create --title "..." --body "..."`，多行 body 用 heredoc。
- **读 issue**：`gh issue view <number> --comments`，评论用 `jq` 过滤，并取回 labels。
- **列 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需加 `--label`、`--state`。
- **评论**：`gh issue comment <number> --body "..."`
- **加/去标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

仓库从 `git remote -v` 推断；在 clone 内运行时 `gh` 自动这么做。

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

设为 `yes` 时，PR 走与 issue 同套的标签与状态，命令换成 `gh pr` 等价物：

- **读 PR**：`gh pr view <number> --comments`，diff 用 `gh pr diff <number>`。
- **列待 triage 的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，只留 `authorAssociation` 为 `CONTRIBUTOR` / `FIRST_TIME_CONTRIBUTOR` / `NONE` 的（去掉 `OWNER` / `MEMBER` / `COLLABORATOR`）。
- **评论 / 打标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label` / `--remove-label`、`gh pr close`。

GitHub 的 issue 与 PR 共用一个编号空间，裸 `#42` 可能是两者之一：先 `gh pr view 42`，失败再 `gh issue view 42`。

## 技能说「publish to the issue tracker」时

建一个 GitHub issue。

## 技能说「fetch the relevant ticket」时

跑 `gh issue view <number> --comments`。

## Wayfinding 操作

供 `/wayfinder` 使用。**地图**是单个 issue，**子票**是它的子 issue。

- **地图**：一个打了 `wayfinder:map` 标签的 issue，装 Notes / Decisions-so-far / Fog 正文。`gh issue create --label wayfinder:map`。
- **子票**：作为地图的 GitHub sub-issue 关联（`gh api` 打 sub-issues 端点）。sub-issue 未启用处，把子票加进地图正文的任务列表，并在子票正文顶部写 `Part of #<map>`。标签：`wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。认领后指派给驱动的开发。
- **阻塞**：用 GitHub **原生 issue dependencies**（规范且 UI 可见的表示）。加边：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻塞方的数字**数据库 id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，**不是** `#number` 也不是 `node_id`）。GitHub 报 `issue_dependencies_summary.blocked_by`（只含未闭合的阻塞方，即活闸门）。dependencies 不可用处，退回在子票正文顶部写 `Blocked by: #<n>, #<n>`。每个阻塞方都关闭时，票才是解锁的。
- **前沿查询**：列出地图的未闭子票（`gh issue list --state open`，限定在地图的 sub-issues / 任务列表内），丢掉有未闭阻塞方（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行里有未闭 issue）或已有指派人的；地图顺序最前的胜出。
- **认领**：`gh issue edit <n> --add-assignee @me`，是本会话的第一次写。
- **了结**：`gh issue comment <n> --body "<answer>"`，然后 `gh issue close <n>`，再把一条上下文指针（要点 + 链接）追加到地图的 Decisions-so-far。
