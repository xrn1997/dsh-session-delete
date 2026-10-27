/**
 * 宿主 `connection` 服务（`dsh-client-connection` 的 `HostConnectionService`，`super(ctx, "connection")`）
 * 的窄镜像：`requestRejection(request)` 一次做宿主 `/api` 的那两道——Host/Origin 栅栏与「已认证 live peer」。
 *
 * **每次请求惰性解析服务**，不在激活时取一次：插件与 `client-connection` 的激活顺序没有承诺，取早了
 * 会让远程支永远缺席（LAN 上全 403 且难排查）。`ctx.get` 是同步查表，代价可以忽略。
 *
 * **状态码在这里翻成裁决**（401 = 归属对、缺身份；403 = 归属不对；其余按归属不对处理），
 * 调用方拿到的就是自己的词表，不需要知道宿主用哪个码表达哪件事。成员名与返回值按 asar
 * `dsh-client-connection/lib/index.js` 原文读实。
 */
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'

export type ConnectionVerdict =
  | { readonly kind: 'allowed' }
  /** 组成里没有这个服务（无 web 组成 / 老代次）——调用方 fail-closed。 */
  | { readonly kind: 'absent' }
  /** 宿主认可归属，但这条请求没带已认证身份。 */
  | { readonly kind: 'unauthenticated' }
  /** 宿主不认可归属（Host/Origin 栅栏不过，或它给出的其余状态码）。 */
  | { readonly kind: 'untrusted' }

export interface ConnectionPort {
  verdictFor(req: IncomingMessage): ConnectionVerdict
}

interface ConnectionServiceLike {
  requestRejection(request: IncomingMessage): number | undefined
}

const HOST_UNAUTHENTICATED = 401

/** 成员抛错按「归属不对」拒绝（fail-closed）。 */
export function createConnectionPort(ctx: Context): ConnectionPort {
  return {
    verdictFor: (req) => {
      const service = ctx.get('connection') as ConnectionServiceLike | undefined
      if (service === undefined || typeof service.requestRejection !== 'function') return { kind: 'absent' }
      try {
        const status = service.requestRejection(req)
        if (status === undefined) return { kind: 'allowed' }
        return { kind: status === HOST_UNAUTHENTICATED ? 'unauthenticated' : 'untrusted' }
      } catch {
        return { kind: 'untrusted' }
      }
    },
  }
}
