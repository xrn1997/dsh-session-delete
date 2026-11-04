/**
 * 取数路径的挂载点：官方 `/api` 前缀 + **当前文档所在的目录**。
 *
 * 为什么不能写死根绝对路径：宿主自己的客户端模块按「app-directory-relative form」下发 bundle 与
 * chunk 描述符，浏览器在**自己的挂载点**下解析（`dsh-client-modules` README 原文：*"which a browser
 * document resolves under its own mount"*）；同一个部署可以被反代到 `/dsh/`，此时 `/api/...` 会打到
 * 反代根、而不是宿主。路由注册侧仍然必须写 `/api/...`（宿主 `connection.fetch.register` 用
 * `endpointFromPath('/api', path)` 校验），所以本文件只给**浏览器半**投影一层挂载点前缀。
 *
 * 根部署（`http://host/`）下 `mountPathOf` 返回空串，拼出来的 URL 与旧版逐字相同；只有挂载部署才
 * 多出 `/dsh` 这一段。目录取自 `new URL('.', baseURI)`：页面是 `/dsh/`、`/dsh/index.html` 都归到
 * `/dsh/`；`about:blank` 这类不透明 base 退回根路径（此时相对地址本来也无法成立）。
 */

import { OFFICIAL_SESSION_DELETE_API_PREFIX } from '../shared/wire.js'

/** `baseURI` 所在目录的路径，去掉尾斜杠；根路径回空串。 */
export function mountPathOf(baseURI: string): string {
  try {
    const dir = new URL('.', baseURI).pathname
    return dir === '/' ? '' : dir.replace(/\/$/, '')
  } catch {
    // 不透明 base（about:blank / 测试里的假 document）：退回根路径，与旧版行为一致。
    return ''
  }
}

/** 一段相对段名 → 宿主 `/api` 前缀 + 挂载点。`path` 以 `/` 开头，与 `ROUTES` 的形状一致。 */
export function apiPathOf(path: string, baseURI: string): string {
  return `${mountPathOf(baseURI)}${OFFICIAL_SESSION_DELETE_API_PREFIX}${path}`
}

/** 当前文档的取数路径；Node 侧（无 `document`）退回根路径。 */
export function apiPath(path: string): string {
  return apiPathOf(path, typeof document === 'undefined' ? 'http://localhost/' : document.baseURI)
}
