# dsh-session-delete

给 DeepSeek Harness（DSH）加一个**删除会话**的能力。DSH 官方有归档，没有删除——归档只是把会话从列表里挪走，文件还在。本插件补上删除，并且让删除**可恢复**：删除 = 移入回收站，另有一个显式的"彻底删除"。

> **状态：设计阶段**，尚无可用产物。
> 设计（触点、边界、错误形状、验证门）：[`docs/design/2026-09-30-session-delete-design.md`](docs/design/2026-09-30-session-delete-design.md)
> 界面稿（自包含 HTML，双击即开）：[`docs/design/session-delete-ui.html`](docs/design/session-delete-ui.html)

## 设计要点

- **删除 = 整目录 `rename` 进自己的回收站**（`~/.dsh/session-trash/`），不销毁数据；恢复就是把目录放回去并重新挂回工作区账本。
- 三个动作：**删除 / 恢复 / 彻底删除**。不做批量、检索、收藏、闲置清理、自动过期、附件回收——这些要加会先问。
- **不 disable、不替换任何官方插件**，只挂官方声明的槽位（会话条目菜单 + 侧栏底部）。
- 正在运行的会话**拒绝删除**，不替用户终止正在进行的活。

## 兼容性

宿主：DSH Desktop / Web（插件层共用）。官方对插件有一道**安装闸**：`dsh plugin add` 会拿运行中的宿主版本逐项比对插件的 `@deepseek-ai/dsh*` peer 区间，不满足就拒绝并回滚——所以兼容声明必须逐代显式开口，没有"免维护写法"。具体声明见实现后的 `package.json`。

## 许可

Apache-2.0，见 [`LICENSE`](LICENSE)。
