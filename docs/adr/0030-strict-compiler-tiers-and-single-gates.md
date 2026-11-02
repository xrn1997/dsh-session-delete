# 编译器档位一次开齐，lint 门与发版门收成同一条 gates

Status: accepted

本仓此前只有 `strict`、`isolatedModules`、`verbatimModuleSyntax` 与未用变量检查，没有任何 ESLint；CI 与发版各自手写了一份步骤清单（typecheck / test / build）。这留下两个洞：`tsc` 看不见显式 `any`，而两份手写清单必然漂移——漂移的结果是发版门比检查门更宽。

## 决定

- **补满编译器档位**：`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`erasableSyntaxOnly`、`noFallthroughCasesInSwitch`、`noImplicitOverride`。`engines.node >= 24` 已写进 `package.json`，不可擦除语法在本仓不是风格问题，是运行前提。
- **从零建 ESLint**：类型感知的 `strictTypeChecked` + `react-hooks` 两条（`rules-of-hooks` / `exhaustive-deps` 均为 error）。分工写进配置注释：`tsc` 管类型形状，ESLint 管显式 `any`、`any` 扩散、悬浮 Promise、非空断言。
- **发版门复用检查门**：`package.json` 新增 `gates`，`ci.yml` 与 `release.yml` 都只调它，不再各写步骤。

## 被否的方案

- **`unbound-method` 逐点 disable**：命中集中在同一根因——本仓 interface 用方法简写（`m(): T`）给 TS 隐式 `this`，摘下来传出去一律可疑。改声明式为属性声明（`m: () => T`）一次消掉大半，且顺带让函数属性逆变生效；与 `src/api/route-table.ts` 的既有先例同向。
- **按规则建议给 `TrashSelection` 的方法包箭头**：它的值每次渲染换新对象，包一层会让 `src/client/trash-nav.ts` 里 `onListKeyDown` 的 useCallback 依赖抖动（`toggleCheck` 是它的依赖之一，`select` 由控制器进同一张依赖表），每次渲染换一个新处理器——那是行为改动，不是消 lint。（`document` 上那条 Esc 监听不在这条链上：它的依赖是 `drillEnabled` / `drilled` / `back` / `selectedId`，不含勾选面。）
- **删掉 `use-trash-panel-controller` 里被报「多余」的 `detailVersion` 依赖**：详情缓存是 `useRef` 的 Map，这个效应只能靠这个必然变化的信号知道缓存被 prepend 过；照规则删掉，加载更早会读回来但不落屏。

## 后果

- 有若干 `eslint-disable` 落在确证误报上，其中一类属 `exhaustive-deps` 的规则可见性盲区（自定义 hook 回的恒稳 ref/setter），逐条带理由。生产代码不设目录级降级：`require-await` 在端口与 `/ping` 那几处同步实现体上逐条标（契约面要求它们返回 Promise，体内确实没有 await）；唯一的目录级例外是 `tests/**`——替身里 `async` 无 `await` 是正确形态，理由写在 `eslint.config.js` 的块注释里。
- `no-unnecessary-condition` 的命中分两类并区别对待：TS 看不见闭包写入的判空、以及本地窄镜像与 `lib.dom` 撒谎的判空，一律**保留**并加注释；只有真死代码才删。宿主服务缺席仍表达为显式 `CorpusRead`，「看不见」不变成「没有」。
- 发版前不再有检查门与发版门两套口径：`pnpm gates` 是唯一入口。

锚点：`tsconfig.json`；`eslint.config.js`；`tests/support/fixture.ts` 的 `must` / `pick`；`src/client/use-trash-panel-controller.ts`；`src/client/trash-nav.ts`；`src/api/route-table.ts`；`package.json` 的 `gates`；`tests/client/trash-panel.test.tsx`。
