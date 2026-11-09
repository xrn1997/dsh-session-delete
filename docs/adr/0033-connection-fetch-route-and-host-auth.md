# ADR-0033 — 通道只走宿主 connection 的 exact Fetch 路由

Status: accepted

本插件的浏览器半到 Node 半只走一条通道：十段注册到宿主 `connection.fetch.register` 的 `/api/dsh-session-delete-api/*`，Host/Origin/浏览器认证由宿主 `/api` bridge 完成。自建 `webServer` 前缀与插件请求栅栏已删除。支持面是 web UI 与桌面端——二者的标准组合都装 `client-connection`，`connection` 缺席属于不支持的组合。

## 背景

官方 `remote.<namespace>` 仍不可用：它只能由生成的 Typert 描述符经 `ctx.remote.$mount(...)` 挂上，第三方没有动态发现这一步（ADR-0009 的背景仍然成立）。

2026-11-04 对宿主源码仓库（`deepseek-harness`，`dsh-v*` tags）的核对推翻了一个旧前提：

- `connection.fetch.register` 与 `/api` exact route 在 `dsh-v0.1.7-rc.2`（本仓 `engines.dsh` 的地板）就存在；`attachments` 服务与 `readImage` / `readFileStream` 同时存在。
- 标准组合一直装着两者：`packages/bundle/web-app` 装 `client-connection`，`packages/bundle/base` 装 `attachment-local`；`apps/desktop-host` 依赖 `client-connection` 与 `host-webserver`。
- 桌面壳的 `forwardWebRequest` 把页面请求转给宿主前会删掉 `host` / `origin` / `cookie` / `sec-fetch-site`，注入宿主自己的 cookie；宿主 `/api` 不查 Referer，所以 exact route 在桌面壳可用。

因此「旧宿主没有该 API」不成立：旧前缀 fallback 不是版本兼容税，而是**未支持的自定义组合**（有 `webServer`、没装 `client-connection`）的兼容税。它在 web UI 与桌面端里是死代码，却要长期维护两套传输、两套测试。

另一个版本事实：exact route 的 owner-peer 限制是 2026-10-13（`f6316536ea`，首个 tag `dsh-v0.2.1-alpha.3`）才加的；`0.2.0-rc.2`、`0.2.1-alpha.1/alpha.2` 仍只要求过 `/api` 的 Host/Origin + 浏览器认证，`0.2.1-alpha.3` 起（含 `0.2.1-rc.1/rc.2`）带这道校验。插件不把 owner-only 当作自己的安全边界；鉴权归宿主，随宿主代次走。

## 决定

1. **官方通道唯一**：`connection.fetch.register` 可用时，十段注册到 `/api${SESSION_DELETE_API_PREFIX}${ROUTES.<name>.path}`（即 `/api/dsh-session-delete-api/<segment>`）；段名、方法与请求体形状住 `src/shared/wire.ts` 的 `ROUTES`（ADR-0003），方法、body 的预读投影（`bodyOf`）、纯度、读面、deps 切片从 `src/api/route-table.ts` 取；body 的字节闸 / JSON 解析、响应头与 `Response` 构造、失败信封的落地都归适配器。
2. **`connection` 是硬依赖**：`inject` 用 `connection` 替代 `webServer`；服务缺席时插件停在 pending（`inject` 不会激活它），服务在场但 `connection.fetch.register` 形状不符时激活失败（响亮）。两种情况都不静默注册零条路由。插件不再直接注册 `webServer` 前缀——exact route 仍由宿主的 `connection` 挂在其 `/api` 前缀上。
3. **客户端只探 `/api/dsh-session-delete-api/ping`**：只有**成功信封**（`ping` 回 `pong`）才注册入口；401/403、失败信封、404、非信封都按不可用处理（入口不出现）。401/403 在宿主 `/api` 是纯文本，客户端映射为固定中文原文；两条原文住 `src/client/remote.ts`。
4. **路由 / 线上形状不变**：`ROUTES` 的段名、方法、body、纯度、读面、deps 切片与信封形状不动；单条仍是长度为 1 的批量。
5. **附件读取**：`GET /attachment` 的寻址与鉴权不变；ADR-0035 的「宿主 `attachments` 服务优先、直接 fs fallback」保留——孤儿预览只有 `id` / `bytes`，凑不出宿主 ref，直接 fs 不是传输 fallback。
6. **附件段另有同源取数闸**：`GET /attachment` 的响应能被任意页面当 `<img>` 渲染，字节 oracle 不随宿主鉴权消失。路由记录给它声明 `fetchGate: 'same-origin'`；适配器**直接放行 `Sec-Fetch-Site: same-origin`**（浏览器写的 Fetch Metadata，页面 JS 伪造不了，也不把常见路径押在 `Host` 是否被中间层保留上），拒 `same-site` / `cross-site`，并在没有 Fetch Metadata 时要求 authority 与 `Host` 一致的 http(s) `Origin` / `Referer`；桌面壳的 `dsh-app:` 来源与三头全缺的非浏览器客户端放行。拒绝是 **403 + 失败信封**（走插件自己的错误面，不与宿主纯文本 401/403 混形）。`Host` 由宿主 bridge 原样保留（它只改写 `request.url`），`tests/api.test.ts` 的真 `node:http` 桥钉住同源 `Referer` 能对上。其余九段是 JSON，跨源读不到（没有 CORS），不设闸。

## 边界

- 支持面是 web UI（web-app bundle）与桌面端。自定义 `webServer`-only profile 不在支持面；`connection` 缺席时插件停在 pending / 激活失败，而不是静默无入口。
- 鉴权归宿主 `/api`（Host/Origin/浏览器认证）；插件不新增 `trustedHosts`、不读转发头、不建立身份。桌面壳由 forwarder 摘掉 Origin 并注入宿主 cookie。
- **附件段的同源取数闸只补宿主没管的那一格**：宿主 `/api` 已经拦 `cross-site` 与 authority 不符的 `Origin`；插件补的是 `same-site`（同 IP 不同端口仍带 cookie）与不发送 Fetch Metadata 代次的 `Origin` / `Referer`。**仍有残留**：既不发送 `Sec-Fetch-Site`、也不带 `Origin` / `Referer` 的旧浏览器（Chrome 76 以前）可以绕过。桌面壳的转发器按设计摘掉 `host` / `origin` / `sec-fetch-site`，插件不能把「摘干净」当成不可信。其余九段是 JSON：跨源读不到（没有 CORS），不设同源闸。
- owner-peer-only exact route 只在 `0.2.1-alpha.3` 及以后成立；更早的窗口代次只要过 `/api` 认证即可命中。插件不依赖这条限制作为安全边界。
- 不引入 `remote.<namespace>`：第三方仍拿不到 Typert 描述符的动态发现挂载点。
- `engines.dsh` 不因本改动抬高：两个 API 在 `0.1.7-rc.2` 已有；抬地板会把「组合不支持」误写成「版本不支持」。

## 后果

- 删除 `src/api/request-trust.ts`、`src/ports/connection-port.ts`、`createApiHandler` 的 Node 适配器、客户端旧前缀探测与 `activeBase`；`src/index.ts` 的 `inject` 从 `webServer` 换成 `connection`。
- 客户端只保留一个基础路径常量 `OFFICIAL_SESSION_DELETE_API_PREFIX`；附件 URL 与九段 fetch 都从它起。浏览器半在它前面只再叠一层**文档挂载点**（`src/client/api-base.ts`：根部署下与旧版逐字相同，反代到 `/dsh/` 时得 `/dsh/api/…`），不另写段名或 `/api`。
- 本机 `curl` 便利消失（要出示宿主签发的 Web 身份）；README 的 LAN / 本机 FAQ 同步。
- 发版时在 `CHANGELOG.md` 的升级注意写明：自定义 `webServer`-only profile 不再支持，必须装 `client-connection`；这是 URL 面与依赖面的破坏性变化。
- `tests/connection-route.test.ts` 钉注册 / `Request`·`Response` 适配 / body 闸 / 附件段的同源取数闸；`tests/api.test.ts` 用真 `node:http` + 测试桥钉路由契约；`tests/assembly.test.ts` 钉组合根的 `connection` 接线与响亮失败。
- `docs/architecture.md` §1 / §4、`CONTEXT.md`、`README.md`、`docs/development.md`、`AGENTS.md` 同步为单通道。

## 被否掉的替代

- **保留自建前缀 + 请求栅栏**：版本上不需要（地板已有官方 API），支持组合里是死代码；长期维护两套传输、两套测试，且复刻宿主鉴权、回环免身份。
- **先抬 `engines.dsh` 再删 fallback**：抬地板没有必要，且会把「profile 没装 client-connection」误写成「宿主版本太旧」。
- **`connection` 缺席时返回空 disposer**：插件看起来在、所有入口不出现，最难排查；本 ADR 要求响亮失败。
- **只在 raw 路由上补 `requestRejection`**：仍保留自建路由与双基础路径；收益不抵复杂度。
- **官方 `remote.<namespace>`**：第三方仍无动态发现挂载点。

锚点：`src/api/connection-route.ts`；`src/api/dispatch.ts`；`src/api/route-table.ts`（`fetchGate`）；`src/shared/wire.ts`；`src/index.ts`；`src/client/remote.ts`；`src/client/api-base.ts`；`src/client/index.tsx`；`tests/connection-route.test.ts`；`tests/api.test.ts`；`tests/assembly.test.ts`；`docs/architecture.md` §1 / §4；ADR-0009；ADR-0022；ADR-0023。
