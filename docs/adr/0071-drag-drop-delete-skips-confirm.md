# ADR-0071 — 拖进回收站即删，不弹确认框

Status: superseded by 0072

会话行拖到侧栏「回收站」入口松手即删，**不走确认框**；行菜单删除的确认框原样保留，两条路并存。误拖靠撤销横幅兜底（停留与单删同款）。拖拽本身是「按下—瞄准—松手」的显式手势，再压一层确认是四步换两步的保安心。

## 决定

1. **投放即删**：drop 走既有写入座位（`deleteSessionFromMenu` / `deleteSessionsFromBatch`），成功发撤销横幅，在飞由闸挡回——与确认框路径同一条写入链，只是少了确认那一屏。
2. **拖的行在多选勾选集里 ⇒ 一拖删整集**：拖拽是"把这些带走"的手势，勾选集就是"这些"的声明；拖的行不在勾选集里才是单条。
3. **payload 必须命中宿主行登记表**：宿主拖拽把 session id 写进 `text/plain`，随手拖一段文字进来是同一种 payload——未登记 id 静默忽略，绝不许变成删除。

## 边界

- 行菜单「删除」仍有确认框（`docs/ui-spec.md` §2 ②）：入口在菜单里是"读完再点"的场景，确认框讲的可恢复与含子会话那两句在那里有意义。
- 彻底删除、清空回收站**永远**走确认框：不可恢复的动作不给手势路（危险层级住 `docs/ui-spec.md` §3）。
- 运行中的行 drop 拒绝并出裸失败提示（与勾选框置灰同口径）；触屏没有 HTML5 拖放，走行菜单，不另造手势。
- 行拖不拖得动归宿主（重排权限门；归档行、空白行宿主自己就不给 `draggable`）。

## 受约束偏离（升级宿主代次先核这些形状）

1. **拖拽载荷是宿主私有约定**：宿主会话行的 `dragstart` 把 session id 写进 `text/plain`（宿主 `Rows.tsx` 的 `onDragStart`）。没有公开的会话拖拽 API，插件按这条约定认源；未命中行登记表的 payload 一律忽略（决定 3）。
2. **投放面是宿主行结构**：`sidebar.panellist` 的行是包含 glyph 的 `<button>`；命中与红色高亮靠 `closest('button')` 与 `:has([data-dst-*])` 读宿主行，不向宿主节点写 class / style。
3. **范围勾选的视觉序读宿主列表 DOM**：宿主重排行时不重挂行组件，登记序会过期；`batch-pick.ts` 的 `readVisualSelectableRows` 按 `[data-row-key^="session:"]` 的 DOM 顺序取段。**行集合仍以槽位登记为准**——节点必须已登记且可勾选才入段，ADR-0034 的可见行来源不变，这里只补顺序来源。

## 被否方案

- **拖拽也弹确认框**：手势已经显式到三步，确认是第四步；用户要的 Windows 心智就是松手即成，撤销横幅已经给了反悔路。
- **拖拽直接彻底删除**：投放目标只承载「移入回收站」一个语义；永久释放空间必须看得见"不可恢复"那句话，只有确认框面写得下。
- **Ctrl/Shift+点做成全局手势**：普通点击在宿主会话列表已经是「打开会话」、在回收站清单是「选中看详情」，全局劫持修饰键会和其他插件的行交互、快捷键冲突。范围勾选限定在显式多选模式内生效（`docs/ui-spec.md` §3）。

## 代价

拖拽删除与行菜单删除对"误操作的容错"不一致（一个有确认、一个没有）；接受它是因为两条路的显式程度不同，且撤销横幅对两者一视同仁。

锚点：`src/client/trash-entry.tsx` `TrashPanelIcon`；`src/client/trash-drop.ts` `DropPlan` / `resolveDropPlan`；范围勾选的视觉序 `src/client/batch-pick.ts` 的 `rangePick`；`src/client/write-seats.ts` `deleteSessionFromMenu` / `deleteSessionsFromBatch`；`src/client/undo-notices.ts` `publishFailureNotice`；`tests/client/trash-entry.test.tsx`「拖到回收站入口」；`docs/ui-spec.md` §1。
