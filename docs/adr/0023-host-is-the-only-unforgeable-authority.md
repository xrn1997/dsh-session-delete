# Host 是唯一不可伪造的归属头：回环 socket 不构成豁免

Status: accepted

旧栅栏判「Origin 与 Host 同名」就放行，对 DNS rebinding 没有判别力——重绑后两个头同写攻击域名，连接还落在回环。决定：请求归属只由 **Host 是否属于本次部署**决定（回环名 / 监听 bind 字面量 / 宿主声明的可信 authority），归属判定先于任何本机 / 远程分支，回环源地址不跳过它。

## 背景

DNS rebinding 的两步：攻击页先由攻击者服务器提供，再把域名重绑到目标机；浏览器随后把请求发到本机，`Host` 与 `Origin` 都是攻击域名。此时「Origin 等于 Host」恰好成立，而回环源地址也恰好成立——旧栅栏的两道关都过。旧代码里唯一挡住跨源 `<img>` 的是 Referer 同源检查，那是对二进制段的偶然保护，不是 rebinding 的正解。

本次改动前，这条缺陷在回环部署上一直存在，但没有被报过：利用它需要攻击者先让用户浏览器打开一个恶意页面，日常使用看不到任何异常。

## 决定

1. **每个客户端都要过归属判定**：Host 必须可解析，且 hostname 属于本次部署。本机支与远程支分别在哪儿判、身份层缺席怎么处理，见 ADR-0022；归属的接受面与宿主 `isBindAddressAuthority` 同口径——回环名覆盖整个 127/8，bind 字面量忽略端口与 `%zone`——这是放宽，不是收紧，按「本地地址都算本机」收下。任何一支都不许用回环 socket 或 `Origin === Host` 代替归属，也不设 fast-path 跳过。
2. **Origin / Referer 只当附加约束**：存在就必须与 Host 同 authority；它们同值不构成归属证明。
3. **回环 socket 只决定「还要不要宿主身份」**，不决定归属。本机进程仍免身份（本机 = 用户本人），挡的是被借用的浏览器。
4. 判据住 `src/api/request-trust.ts` 的 `judgeRequest`；回归用例在 `tests/request-trust.test.ts` 与 `tests/api.test.ts`。

## 边界

- 可信 authority 一旦写进宿主 `client-connection` 的 `trustedHosts`，它的 rebinding 风险由部署方承担；宿主对条目做 canonical 校验（拒绝 `user@host`、零填充端口等），插件不二次校验。
- 身份（cookie）回答的是「你是不是登录过」，不是「这个 Host 是不是本次部署」；归属判据不押在身份层上。
- 不改绑定策略：宿主仍只接受具体接口 IP、拒绝 wildcard。

## 被否掉的替代

- **要求 `Sec-Fetch-Site` 必须存在**：http 页面上的图片 / 导航请求可能完全不带 Fetch-Metadata（宿主 `isTrustedApiRequest` 注释原文），强制存在会误伤正常场景；只能把 `cross-site` 当否决票。
- **比较 Origin 与配置的部署地址**：等价于 Host 归属，但 Origin 在 GET 上经常缺席，Host 每个请求都有。
- **把归属也押在 cookie 上**：身份层的 cookie 名、绑定与有效期随宿主换代而变，归属判据会跟着一起塌；而且本机工具与桌面壳本来就不该被要求出示身份。

## 后果

- 所有部署形态下「Host 写外来域名」一律 403（原文「非受信来源」），回环部署不再例外。
- Host 归属成为每个客户端都要满足的唯一共同判据；`Origin` / `Referer` 退为附加约束。
- 新增的回归用例在改动前是红的：`Host` 与 `Origin` 同写 `evil.example`、源地址回环时，旧栅栏放行。

锚点：`src/api/request-trust.ts` 的 `judgeRequest`；`tests/request-trust.test.ts`；`tests/api.test.ts` 的「重绑形态」；ADR-0022。
