/**
 * 取数路径的挂载点：官方 `/api` 前缀 + **当前文档所在目录**。宿主自己的客户端模块按 app-directory-relative
 * 下发 bundle 与 chunk 描述符，浏览器在**自己的挂载点**下解析（`dsh-client-modules` README 原文：*"which a
 * browser document resolves under its own mount"*）；同一个部署可以被反代到 `/dsh/`，此时 `/api/...` 会打到反代根。
 * 路由注册侧仍写 `/api/...`（宿主 `connection.fetch.register` 用 `endpointFromPath('/api', path)` 校验），
 * 所以本文件只给浏览器半投影一层挂载点前缀。根部署下为空串；目录取自 `new URL('.', baseURI)`，不透明 base 退回根路径。
 */

import { OFFICIAL_SESSION_DELETE_API_PREFIX } from '../shared/wire.js'

export function mountPathOf(baseURI: string): string {
  try {
    const dir = new URL('.', baseURI).pathname
    return dir === '/' ? '' : dir.replace(/\/$/, '')
  } catch {
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
