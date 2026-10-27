# ADR-0009 — 通道走插件专属前缀路由，不挂官方 `remote.<namespace>`

Status: accepted

## 背景

官方给浏览器半的 `remote.<namespace>` 不是声明即得：它只能由**生成的 Typert 描述符**贡献，经 `ctx.remote.$mount(...)` 挂上。第三方没有动态发现这一步——盒内 `$mount` 的清单写死在 `dsh-api-remotes` 里，生成器又只认 `<root>/packages/<pkg>/` 的官方仓形。只在 client 半 `inject` 里写 `remote.<ns>`、却不发布生成的 `typert.host.js` / `typert.remote-client.js`（及对应 `exports`），插件会在前端自检时致命失败（`web boot: N entry did not activate`）。

当时只有两条路：**自挂自**（补生成物 + 自己 `$mount`）或**自建薄线**。自挂自要把官方仓库形状与生成器产物搬进第三方仓，随宿主换代维护；本仓的通道面很小，选了后者。

## 决定

1. 通道是宿主 web server 上的插件专属前缀 `/dsh-session-delete-api`（`src/api/dispatch.ts` ↔ `src/client/remote.ts` 同源 fetch），信封与官方 unary 面同形：`{ok:true,value}` / `{ok:false,error:{code,message,details?}}`。
2. 段名与请求字段只住 `src/shared/wire.ts`；方法 / 纯度 / 读面 / body 只住 `src/api/route-table.ts`。九个段名是 `GET /list`、`GET /ping`、`POST /detail`、`POST /apply`、`POST /empty`、`GET /orphans`、`GET /attachment`、`GET /attachment-orphans`、`POST /attachment-clean`；五个动作全走 `/apply`（`delete` / `restore` / `purge` / `count` / `orphan-clean`），其中 `count` 是纯读、其余四个是写动作。`GET /attachment` 是唯一的二进制段，只发附件字节、失败仍回 JSON 信封；`GET /attachment-orphans` 是无引用图片的报告（纯读），`POST /attachment-clean` 是它的聚合清理（写动作）。一组 id 进、逐条结果出，单条就是长度为 1 的批量，**不留第二条执行路径**。
3. **状态语义**：请求本身不对用 4xx（400 请求体 / 405 方法 / 404 未知路由，同源栅栏拒 403）；**操作失败**回 200 + 信封。浏览器半先解信封再看状态。
4. **同源栅栏认得桌面壳那条路**：桌面壳 `forwardWebRequest` 转发前删掉 `host`/`origin`/`cookie`/`sec-fetch-site` 四个头 ⇒ 真机到插件路由的请求没有 `Origin`、只有 `Referer: dsh-app://app/`。漏认它 = 真机上探测永远 403、所有入口一个都不出现。判据按 `protocol` + `host` 比，不能比 `URL.origin`：`dsh-app:` 不是 WHATWG special scheme，`new URL('dsh-app://app/').origin` 是字符串 `"null"`，比 `URL.origin` 永远为假。

## 边界

- 不发布官方生成的 `typert.*` 文件，也不在 client 半 `inject` 里声明 `remote.<ns>`。
- 段名 / 动作 / 形状 / 失败码的家仍是 `src/shared/wire.ts`；加一个新段名改 `wire.ts` 与 `src/api/route-table.ts` 两处，漏任一都是编译错误或测试红（ADR-0004）。
- 浏览器半只做同源 fetch，不 import 任何宿主客户端包（type-only 也不留）。
- 通道错误原文（`src/client/receipt.ts` 的 missing-id 与单条幂等空值、`src/client/remote.ts` 的取数通道错误）固定中文，不随 locale；它们是协议诊断，不是界面标签。

## 后果

- 浏览器半的入口探测先打 `GET /ping`；探测不过 ⇒ 一个入口都不注册（不可用以免入口不出现表达，不新造禁用态 UI）。
- **headless 直连 http 的过门读数看不出桌面壳那条路**：那条路同源、本就放行；真机必须另验「页面加载 + 槽位注册 + 控制台零 error/warn」。
- 通道面小，随宿主换代只需核对手上这几处：前缀注册、web server 的 `forwardWebRequest` 行为、桌面壳的 `dsh-app://app/` 来源。

## 被否掉的替代

- **官方 `remote.<namespace>`**：第三方拿不到动态发现挂载点；声明了也挂不上，前端自检致命失败。
- **自挂自**：补生成物 + 自己 `$mount` 能跑，但要把官方仓库形状与生成器产物搬进第三方仓，随宿主换代维护；本仓的通道面不值得。
- **一个动作一条路由**：单条与批量各有一条执行路径，判据会分叉；现在单条就是长度为 1 的批量。
- **只比 `Origin`**：桌面壳转发前删掉它，真机上所有请求都会被栅栏挡成 403，而 headless http 的过门读数完全看不出来。

锚点：ADR-0003（线上形状）；ADR-0004（路由表）；`src/shared/wire.ts`；`src/api/dispatch.ts`；`src/client/remote.ts`；`docs/architecture.md` §1
