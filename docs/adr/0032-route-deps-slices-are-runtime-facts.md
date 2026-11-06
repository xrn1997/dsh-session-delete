# ADR-0032 — 路由行声明 deps 切片，读段拿不到删除能力与时钟

Status: accepted

ADR-0004 把段名、纯度、读面与 body 收进一条路由记录；但 deps 一直是全量 `DeleteDeps`，读段运行期仍拿得到 `removeDir` 与时钟，只靠源码护栏数调用点。切片把「这一段吃哪格能力」从注释承诺变成对象事实。

## 决定

1. 每行声明 `slice: 'core' | 'removal' | 'attachment' | 'full'`，`dispatch` 只按这一格注入。
2. `slicesOf` 在 handler 构造期建好四格：`core` 是新建的 `CoreFsPort` 面（没有 `removeDir` / `removeFile`），且没有 `now`；`removal` 有删除能力但没有 `now`；`attachment` 是 `core` 加宿主 `attachments` 读面（ADR-0035）；`full` 是组合根原对象，只给 `/apply`。
3. `run` 必须写成函数属性而不是方法签名：方法参数按双变校验，宽 deps 能绕过切片；属性按逆变校验，`slice` 与 deps 面对不上就编译不过。
4. 编译期闸落在表字面量（每行由自己的 `slice` 字面量定型），运行期闸落在 `depsFor` / `slicesOf` 一处；源码护栏继续钉组合根与执行器。

## 边界

- 方法字面量仍住 `shared/wire.ts` 的段名表，路由记录与浏览器半只投影（ADR-0003）。
- 不在 dispatch 里逐行做类型判断：查表函数交回整张表的值类型，注入点只按 `slice` 选格；超面调用由表字面量的逆变校验挡。
- `core` 只收窄 fs 的删除能力与时钟；`host` 的在场三件仍由 `CoreDeps.presence` 分离，不在本篇重复。
- **`host` 不是运行期切片**：`coreOf` 把 `full.host` 原样转交，读段拿到的是同一颗对象。在场三件在**类型面**已被 `HostCorePort` 挡掉（ADR-0019，`tests/deps.test.ts` 的 `coreHostHasNoPresence` 钉住），运行期那颗对象却仍带着它们——要把它也变成对象事实，得在 `coreOf` 里逐方法包一层窄对象，本篇没做。本篇真正收窄成对象事实的只有 fs 的删除能力与时钟两格。

## 后果

- 读段运行期**没有** `fs.removeDir` / `fs.removeFile` / `now` 这几格，能力缺席从注释承诺变成对象事实。
- 加一段 = wire 加键 + route-table 加行（含 `slice`）；`run` 的 deps 面按 `slice` 定型，漏了编译不过。
- `core` 的 fs 面是显式字面量：`CoreFsPort` 新增方法时这里必须同步补，漏了编译不过。

## 被否掉的替代

- **保留全量 `DeleteDeps`、继续靠源码护栏数 `removeDir` 调用点**：读段运行期仍持有删除能力，护栏只能事后发现调用，不能阻止。
- **把 `run` 写成方法签名**：方法参数双变，`slice:'core'` 那一行把 deps 标成删除面照样编译过——切片只剩运行期投影，类型面不再挡超面调用。
- **在 dispatch 里逐行做类型判断**：表的值类型是整张表的并集，注入点拿不到逐行对应；逐行判断会把同一张表的知识又抄一遍。

锚点：`src/api/route-table.ts`；`src/api/dispatch.ts`（`slicesOf` / `depsFor`）；`tests/route-table.test.ts`；`tests/deps.test.ts`；ADR-0004；ADR-0027。
