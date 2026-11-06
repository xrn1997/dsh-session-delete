# ADR-0046 — 清单的公开面只放官方字段，真机代次账本移入私有命名空间

Status: accepted

`package.json` 顶层 `dsh` 是宿主与商店读的公开面。本仓自己的真机代次账本过去写在 `dsh.compatibility.dshReleases`，形状像平台契约、实际没人读；现在它住在 `xrn1997.dshReleases`，`dsh.*` 只留官方声明过的字段，并把官方标为 optional 的 `dsh.manifestVersion: 1` 补上。

## 背景

`compatibility.dshReleases` 从来不是宿主清单里的字段——它是本仓自造的一格，写在官方命名空间里就有两个后果：别人会照着这个位置抄一份互不兼容的读数；以及本仓以后想加自己的读数时，`dsh.*` 里官方字段与自造字段混在一起，没人能一眼看出哪一格是契约。上一轮合规审计把这条列为「信息级、不改或记录」，同时明确它不是核心宿主要求。

## 决定

1. **`dsh.*` 只放官方清单字段**：`bundle`、`client`、`manifestVersion`。`manifestVersion` 按官方文档声明为 `1`，它独立于 npm 包版本，标的是清单格式。
2. **真机账本住 owner 的私有命名空间** `xrn1997.dshReleases`：内容口径一字不变，仍然只列桌面真机跑过的代次，仍然由 `tests/skeleton.test.ts` 与实测名单**双向**钉住。
3. **「装得上」的家仍是顶层 `engines.dsh`**：这份账本不是兼容窗口，也不是 `engines` 的替代（`AGENTS.md` 的宿主要求那条不变）。

## 边界

- 不改「真跑过」的口径与名单内容：只搬家，不重估。
- 不改 README「兼容性」那段的表述：它是这份名单的投影，文档门校验两边同字。
- 不引第二份账本：CLI 台架的读数只用来定 `engines.dsh` 地板，进不了这份名单（判据见 `docs/development.md` 的「真机验证」）。

## 后果

- 已发布的 0.6.1 及更早的产物里，这份名单在 `dsh.compatibility.dshReleases`；读旧版本清单要按旧位置看，本仓不回填历史包。
- `docs/development.md`（真机验证、发版流程）与 README 同批改指 `xrn1997.dshReleases`；`tests/skeleton.test.ts` 现查 `dsh` 里不再有 `compatibility` 这一格。
- 宿主清单的可选字段仍不改变运行期行为：官方文档写明当前安装器与加载器不强制检查 `dsh.manifestVersion` 或 `engines.dsh`，声明只是声明。

## 被否掉的替代

- **留在 `dsh.compatibility.dshReleases`**：位置本身就是误导，读者会以为宿主认这格；实际宿主与市场都不读。
- **删掉账本，只留 `engines.dsh`**：窗口说「装得上」，不说「跑通过」；真机名单是本仓唯一能回答后者的读数家。
- **把名单挪进 `README.md` 独立维护**：README 是投影，投影不能成为事实源（判据见 `docs/AGENTS.md`）。

锚点：`package.json`；`tests/skeleton.test.ts`；`README.md`「兼容性」；`docs/development.md` 的「真机验证」与「发版流程」；`AGENTS.md` 的宿主要求那条；ADR-0025。
