# Domain docs

工程技能探索代码库时，如何消费本仓的领域文档。

## 探索之前先读这些

- 仓根的 **`CONTEXT.md`**，或
- 仓根的 **`CONTEXT-MAP.md`**（若存在）：它指向每个上下文各一份 `CONTEXT.md`，只读与当前话题相关的那些。
- **`docs/adr/`**：读与你即将改动的区域相关的 ADR。多上下文仓还要看 `src/<context>/docs/adr/` 里的上下文级决策。

这些文件若不存在，**静默继续**：不要指出缺失，也不要主动提议先建。它们是 `/domain-modeling`（经 `/grill-with-docs`、`/improve-codebase-architecture` 到达）在术语或决策真正落定时才惰性创建的。

## 文件结构

本仓是单上下文（多数仓如此）：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-....md
│   └── 0002-....md
└── src/
```

多上下文仓（仓根有 `CONTEXT-MAP.md`）：

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← 全系统决策
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← 上下文级决策
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## 用词表里的词

输出里要点名一个领域概念时（issue 标题、重构提案、假设、测试名），用 `CONTEXT.md` 里定义的词，别漂到术语表明确避开的同义词。

需要的概念还不在术语表里，本身是个信号：要么你在发明项目不用的语言（重新考虑），要么真有缺口（记下来交给 `/domain-modeling`）。

## ADR 冲突要挑明

你的输出若与既有 ADR 相矛盾，显式挑明，别静默覆盖：

> _与 ADR-0007（event-sourced orders）矛盾，但值得重开，因为……_
