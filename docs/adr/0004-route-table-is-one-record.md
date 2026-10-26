# ADR-0004 — 路由表是一条记录，`dispatch` 读它

Status: accepted

## 背景

一条请求要过三道判断，而这三道判断的**同一份知识**分散在两个函数里：

| 判断 | 住在哪 | 怎么维持一致 |
| --- | --- | --- |
| 这个段名该用什么方法 | `dispatch()` 里六个 `if` 各调一次 `requireMethod` | 手写 |
| 这个段名纯不纯（要不要进到达序链） | `purityOf()` 里另一组 `if` | **注释**（「必须与上面那份一致」） |
| 这个段名要不要预读 body | `purityOf()` | 手写 |

两处不一致的后果都不轻，而且都不好在测试里撞见：

- 该纯的判成写 ⇒ 一次探测/大正文读把删除按钮堵在串行链后面；
- 该写的判成纯 ⇒ 写动作绕开到达序链，与对账交错，回收站出现「目录在、行是降级元数据」的世界；
- body 该读没读 ⇒ 下游拿到 `null`；读了两遍 ⇒ 请求流已被消费（`dispatch.ts` 的注释专门强调过这一点）。

此外 `APPLY_ACTIONS` 是 `ApplyAction` 联合在**运行期的手抄副本**，注释原文承认「必须同进同退」。

## 决定

1. 新增 `src/api/route-table.ts`（Node 半私有——浏览器半要 import `wire.ts`，值 import 会把 Node 半拖进 bundle）：
   每个段名一行，声明 `{ method, body, purity, read, run }`。
2. `dispatch()` 读这一条记录：方法、纯度、读面、body 预读四件事**只有一处定义**（原先分居 `dispatch()` 与
   `purityOf()` 两处的判断已并进这张表）。
3. `APPLY_ACTIONS` 由 `ApplyAction` **派生**（`Record<ApplyAction, …>` + `satisfies`）：
   少一个动作就编译不过，多一个动作也是。
4. `/apply` 内部的纯度（`count` 是纯读）写成该路由 `purity` 的函数形式、按请求体里的 action 判；
   不另立一张"动作 → 纯度"的表，也不写在 `dispatch` 里。

## 边界

- **不给段名做动态发现**：六个段名是硬契约，`wire.ts` 仍是它们的家；`route-table.ts` 只负责「怎么处理」。
- **不在这一轮改 HTTP 状态语义**（请求本身不对 4xx / 操作失败 200 + 信封）——那是既定口径，家在这两条上：栅栏与状态在 `src/api/dispatch.ts`，失败信封在 `src/remote/map-error.ts`。

## 后果

- 加一段 = `wire.ts` 加一个键 + `route-table.ts` 加一行；漏了任何一个都是编译错误或测试红。
- 「纯度」从注释承诺变成可枚举的数据：一条测试可以遍历整张表断言「写动作全部进链、纯读全部不进」。
- 到达序链那段代码本身（`throughChain`）不动——它今天是**没有测试覆盖**的，这一轮顺手补一条
  并发两条写请求的串行断言。

## 被否掉的替代

- **把 handler 放进 `shared/wire.ts`**：值 import 会把 Node 半（`node:http`、`node:fs`）拖进浏览器半的
  bundle，正好撞上 `tsdown` 的纯度门。
- **只把 `APPLY_ACTIONS` 从类型派生**：三处判断仍分居两处，最危险的那条（纯度）继续靠注释。

锚点：`CONTEXT.md`（路由表 / wire）；`src/api/route-table.ts`
