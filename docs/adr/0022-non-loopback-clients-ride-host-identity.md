# 非回环客户端的门禁对齐宿主：归属自己判，身份承 connection

Status: accepted

宿主绑到局域网地址时，插件所有段名都回 403「非受信来源」——旧栅栏把「源地址必须是回环」当成了唯一门。决定：删掉这条前提，回环降为一条**接受支**（本机工具与转发落在回环的桌面壳），归属改由 Host 判定；远程客户端再要过宿主 `connection` 服务的 `requestRejection`，身份就是那次 `dsh web` 打印的 URL 换来的签名 cookie；服务缺席时远程一律拒。

## 背景

旧栅栏第一行是 `req.socket.remoteAddress ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}`，它等于替宿主 webserver 配置做绑定决定。宿主自己的口径是相反的：`dsh-host-webserver` 不提供服务器级认证或来源策略，route owner 各自实现（README 非目标原文）；`host` 只接受具体接口 IP 字面量，wildcard 在加载时就被拒——`webserver: host … is an unspecified (wildcard) address, which is not supported: binding every interface would expose remote code execution to the network…`。绑定是这个载体的配置决定的，可达性不是 route owner 能替它决定的事。

官方 `/api` 是同一层里的参考实现：`dsh-client-connection` 的 `isTrustedApiRequest` 判 Host ∈ 回环名 ∪ 监听器 bind 字面量 ∪ 配置的 `trustedHosts`、否决 `sec-fetch-site: cross-site`、要求 Origin 与 Host 同 authority，**从不看 socket**；之后 `admit()` 还要求一个已认证 live peer（启动 token 铸的签名 cookie，或 API token），否则 401。原文注释：*Binding policy belongs to the webserver config; this fence never establishes identity.*

## 决定

1. **回环不再是前提，而是本机支**：源地址回环 ∧ Host 属于本次部署 ⇒ 放行。localhost 浏览、本机 curl 与转发落在回环的桌面壳都走这支，不需要宿主的 Web 身份；壳的转发源地址不是回环时（宿主 bind 到 LAN IP），靠壳自己换上的宿主 cookie 过远程支。
2. **归属判据**：Host 必须存在、可解析，且属于本次部署。判据本身（回环名 / bind 字面量 / 可信 authority）与「为什么是 Host」住 ADR-0023；这里只记它在两条放行支里的位置——本机支由插件判，远程支由宿主 `requestRejection` 内部判（身份层缺席怎么处理见决定 5）。
3. **头栅栏对任何客户端生效**：`sec-fetch-site: cross-site` ⇒ 拒；Origin / Referer 存在时必须与 Host 同 authority（默认端口按该头自己的 scheme 归一），唯一例外是桌面壳的 `dsh-app://app`。比宿主 `/api` 多查 Referer：`GET /attachment` 是二进制段，跨源 `<img>` 能把它渲染出来，而那条请求不带 Origin。
4. **身份走宿主**：远程客户端必须过 `src/ports/connection-port.ts` 的 `verdictFor`（内部调宿主的 `connection.requestRejection`）。它先做宿主自己的 Host 白名单（含部署声明的 `trustedHosts`），再要求已认证 live peer——插件不复刻 cookie 名、签名密钥与有效期。
5. **`connection` 缺席 ⇒ fail-closed**：远程一律拒，退回改动前的「只有本机」；**原文按「非受信来源」处理**——那时没有可换的身份，不能把人指向一个不存在的入口。服务在**每次请求时**用 `ctx.get` 解析（`src/ports/connection-port.ts`），不在激活时取一次——插件与 `client-connection` 的激活顺序没有承诺，取早了会让远程支永远缺席。
6. **403 两条原文**：归属不对与缺身份各一条，措辞住 `src/api/dispatch.ts`；客户端会上屏，原文要能告诉用户下一步做什么。

## 边界

- 绑定、TLS、cookie 的 `Secure` 与可信 authority 的声明全归宿主（webserver 配置、`client-connection` 的 `trustedHosts`）；插件不读转发头、不看协议，也不新增一份自己的 `trustedHosts`。
- 通道契约不变：段名、方法、形状、失败码都不动，ADR-0009 决定 3 的 403 语义不变；改的只是「谁算够格」。
- 栅栏不建立身份：本机支按「本机 = 用户本人」放行——这比宿主 `/api` 松一处，宿主对回环请求同样要求启动 token 换来的身份。这里保留旧口径（本机 `curl` 与桌面壳访问这条前缀路由时不必出示宿主身份）；代价是同机反向代理会把外部请求变成回环来源、落进这支，要挡外部人就在反代上做认证、或让它保留原始 Host。
- 桌面壳不再依赖「壳删掉 `cookie` 后仍能过」这个细节：回环 bind 下它走本机支，bind 到 LAN IP 时它带的那枚宿主 cookie 让它过远程支。

## 被否掉的替代

- **issue 建议的「同源 Origin/Referer 任一存在即放行」**：Origin / Referer 对浏览器是 forbidden header，对局域网上的任意进程不是——伪造两个头即可触发永久删除；而且相对 `/api` 造出更弱的写口（无 Host 白名单 ⇒ rebinding 可打；无身份 ⇒ 不需要启动 token）。
- **保留回环、声明 LAN 部署不支持**：该部署形态下插件 100% 不可用，而宿主自己的页面在同一网络里正常工作。把宿主明确支持的部署形态挡在插件门口不是安全边界，是缺陷。
- **插件自配一份 `trustedHosts`**：与宿主同名配置平行存在，两处声明必然漂移；它也不提供身份，只是把「可伪造的头」换成「可配置的头」。
- **在插件里复刻 cookie 校验**：签名密钥由宿主持有（`ctx.credentials`），插件既拿不到也不该拿；`requestRejection` 就是这件事的公开出口。

## 后果

- LAN / 反代部署可用，远程客户端与 `/api` 同一张门票。**本机与桌面路径只在宿主认可的地址形态下不变**：同机用自定义域名（含 hosts 文件）或经反代访问时，Host 必须在宿主 `client-connection` 的 `trustedHosts` 里声明——宿主自己的 `/api` 对同一 Host 有同一条要求，不声明时整站本来就不可用。反代还必须保留客户端原始 `Host`：改写成回环地址时，浏览器请求会因 `Origin` / `Referer` 与 Host 对不上被头栅栏拒，而不带这两个头的工具请求会落进本机支（反而免身份）。
- 栅栏从 socket 判据变成纯 header 判据，单测可以伪造全部输入——此前测试服务器永远监听回环，「非回环即拒」那半边零覆盖，这也是缺陷既没被测试抓到、也没在文档里留下痕迹的原因。
- 新增 `src/ports/connection-port.ts`（`ctx.get` 窄镜像、缺席 fail-closed）与 `src/api/request-trust.ts`；`src/index.ts` 的 `WebServerLike` 多读一个 `host` getter。
- 依赖 `connection.requestRejection` 这一未文档化的公开成员：缺席或改名都 fail-closed，症状回到「LAN 403」。

锚点：`src/api/request-trust.ts`；`src/ports/connection-port.ts`；`tests/request-trust.test.ts`；`tests/api.test.ts` 的「路由层 · 请求栅栏」；`docs/architecture.md` §1；ADR-0009；ADR-0023。
