# 面板两档共用一条「档」装配线，四格版面只写一份

Status: accepted

回收站面板里的回收站档与归档档，原先在 `trash-panel.tsx` 里各写一遍「清单读数 → 分组 → 选择面 → 控制器 → 键盘导航 → 意图预取 → 详情帧」的接线，四格版面（工具行 / 清单 / 详情 / 页脚）也各拼一遍；两台面板控制器另有十六个同名成员各自转一层。决定把这层装配命名成**档**：一条共享装配线、两档差异全交 adapter、四格版面只写一次；两档**状态**仍各一份（ADR-0060 决定第 4 条不翻）。

## 背景

两档的判据本来已经各自分家：查询、选择面、详情读路、详情帧、键盘契约、预取都已有自己的 module，ADR-0060 也裁过「两档状态完全独立」。但把这些 module 接成一档的那一段没有任何主人：面板里两份接线平行展开，同一判据写两遍（`split`、`drillEnabled`、详情栏挂载、行身份、预取参数域），两台控制器 25 / 21 个成员里 16 个同名同义。重复的装配线让「改一档的键盘/详情行为」要横跨面板、控制器、查询、视图件四处，也让面板测试只能整块渲染 740 行才够得着档内语义。

## 决定

1. **新增「档」：`src/client/use-panel-tab.ts` 的 `usePanelTab(adapter, ctx)`。** 一档 = 清单读数 → 分组 → 选择面 → 控制器 → 键盘导航 → 意图预取 → 详情帧；共享判据只写一份（`split = wide && rows 非空`、详情栏挂载、`drillEnabled = !split && active` 等）。两个实例在面板顶层**无条件调用**：常驻挂载、切档保留已读缓存的语义不变。
2. **两档差异全交 `PanelTabAdapter`。** 行身份、行读数投影、分组键、两个 hook、活动行 id、键盘的 drilled / select、预取参数域、窄档详情挂载判据、详情帧挂载判据——每一条只回答「本档与另一档不同的那一点」；装配线本身不认识任何一档的具体形状。
3. **控制器收成共有面。** `PanelTabController` 只声明两档共有（busy / selected / detail / canNavigate / 分页 / detailNav / openChild / closeChild / actionFailure / back / loadOlder / retry）；两档控制器改为 `extends` 它，只声明本档差异（待确认动作、光标、下钻位、解除归档、删除座位）。`panelDetailNav` 与 `useGuardedLoadOlder` 收掉两档各写一遍的详情导航装配与保持期守卫。
4. **四格版面只写一次：`src/client/panel-tab.tsx` 的 `PanelTabFrame`。** 容器、分栏/下钻分支、详情栏外壳接线与样式集中；返回 fragment，不新增 DOM 容器。两档视图件搬到 `trash-tab.tsx` / `archive-pane.tsx`，面板只留页面骨架、两档分段、布局几何与互斥（Esc 归属、切档清勾选、归档惰性读）与 header / notice / 确认框宿主。

## 边界

- 两档**状态**各一份、互不读写（ADR-0060 决定第 4 条不翻）；共享的是装配线与判据，不是状态机。
- 各机制判据仍住原 module：`use-panel-list-read.ts`（一次读怎么落地）、`use-list-selection.ts`（勾选与折叠）、`use-gated-refresh.ts`（什么时候重读）、`trash-nav.ts`（键盘契约）、`use-prefetch.ts`（意图预取延时）、`use-detail-frame.ts`（详情帧接线）。档只拥有「谁接给谁」。
- 面板仍拥有：页面骨架、宽窄断点与列宽拖拽、两档分段与 header 副标题、切档清勾选、附件回执与确认框宿主。
- **不改** DOM 结构、内联样式、文案、键盘语义与 `docs/ui-spec.md`；面板 123 例逐条保持。
- 孩子视图的槽位与 open/close/back 状态仍在两台控制器里：两档孩子类型不同（`TrashEntryWire` vs `ArchiveChildView`），归档另有 ADR-0061 的「id 在清单里就选那一行」分派；本轮只把共有面与导航装配收进档，未把两档孩子状态机合并。

## 后果

- 面板只剩页面骨架与跨档互斥；两档装配线与四格版面在仓里各只剩一条，改档内行为只改 `use-panel-tab.ts` 或对应 adapter / 视图件。
- 面板测试只保留跨档组合（Esc 归属、切档清勾选、惰性 M）与布局；档内状态机在各自控制器 / 视图件的 seam 上验。
- 新增第三档（若来）不再复制一条装配线：交一个 adapter + 一个视图件即可。

## 被否方案

- **继续两档各写一遍装配线**：现状；同一判据两份，一边补了另一档忘了是迟早的漂移。
- **把两档状态合成一台状态机 / 一个 controller**：违反 ADR-0060 决定第 4 条；两档的键、详情账本、选中语义本来不同，合并会把两条数据语义压成条件分支。
- **只抽四格版面、装配线留在面板**：版面是重复的一小半，装配线（查询/选择/控制器/导航/预取/帧的接线）才是主要重复；只抽版面等于把大头留在原处。
- **adapter 走运行时注册表 / 依赖注入容器**：两档是编译期已知的两份，不是插件生态；静态 interface + 两个常量 adapter 已够，容器只会多一层运行期查找。
- **把 hook 也做成运行时对象**：两档 hook 仍是模块级自定义 hook 引用，由装配线按固定顺序顶层调用；改成运行时函数对象不会减少代码，还会让 rules-of-hooks 更难审。

锚点：`src/client/use-panel-tab.ts`（`usePanelTab` / `PanelTabAdapter` / `PanelTabController` / `panelDetailNav` / `useGuardedLoadOlder`）；`src/client/panel-tab.tsx`（`PanelTabFrame` / `PanelTabFrameLayout`）；`src/client/trash-tab.tsx`（`TRASH_TAB_ADAPTER` / `TrashTabView` / `useTrashTab`）；`src/client/archive-pane.tsx`（`ARCHIVE_TAB_ADAPTER` / `ArchiveTabView` / `useArchiveTab`）；`src/client/trash-panel.tsx`（`TrashPanel`）；`tests/client/trash-panel.test.tsx`；`tests/client/use-trash-panel-controller.test.tsx`；`tests/client/use-archive-panel-controller.test.tsx`；`docs/architecture.md` §3 / §4.3；`CONTEXT.md` 的「档」；ADR-0060（两档状态独立）。
