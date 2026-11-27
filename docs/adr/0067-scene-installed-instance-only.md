# 场景只认安装的那一份：不懒建默认实例，测试每例换新

Status: accepted

ADR-0066 收了实例 seam，却让默认实例懒建、`installClientScene` 用 `??=` 沿用先到者：只要任何调用早于安装，就会造出第二份账而安装被静默忽略。这里把「进程场景」收成安装的那一份，未安装直接响亮失败。

## 决定

1. **进程场景只能由 `installClientScene` 装入**；未安装时 `getDefaultClientScene` 抛错，不再懒建。注册面在激活期装入一份。
2. **安装默认沿用已装实例**（HMR 二次激活不丢现场）；`replace` 只给测试换新。返回值就是 Provider 要用的那一份。
3. **测试每例一份新场景**：`tests/client/support/setup.ts` 在 `beforeEach` 里 `replace` 安装，所以测试文件不再自备复位口；`reset-client-state.ts` 删除。
4. **自由函数保留**，仍是进程场景的薄委托：非 React 调用点（`write-seats` 收尾、事件处理器、菜单行）拿不到 Provider，删掉只会把同一件事搬到遍布全仓的调用点。

## 边界

- 跨槽位现场的语义、`ClientSceneProvider` 与跨槽位共享不变（ADR-0066 的实例 seam 仍成立）。
- 不动「自由函数 + Provider 同一份账」的口径；本次只去掉「未安装也能读」的兜底。

## 被否方案

- **保留懒建**：安装前任何一次读取都会让安装作废，第二份账静默成立——这正是本次要消掉的故障模式。
- **删掉全部自由函数、全量显式传 scene**：生产侧与测试侧的调用点遍布全仓，换来的是调用点更长，不是更少的知识。
- **每棵贡献树各自 Context**：ADR-0066 已否（宿主槽位互不相邻，跨槽位共享会分裂）。

## 后果

- 测试 setup 必须**动态 import** `scene.js`：setup 先于用例的 `vi.mock` 注册执行，静态 import 会把未替身的业务模块先拉进图里。
- `tests/client/support/setup.ts` 是每个用例换新场景的唯一入口；场景安装语义本身由 `tests/client/scene.test.ts` 直装验证。新增一份现场仍只改 `scene.ts`。

锚点：`src/client/scene.ts` 的 `getDefaultClientScene` / `installClientScene` / `useClientScene`；`tests/client/support/setup.ts`；`tests/client/scene.test.ts`；`tests/client/scene-uninstalled.test.ts`；ADR-0066（已被本篇取代）。
