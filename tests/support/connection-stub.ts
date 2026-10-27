/** 测试用的 connection 端口替身：按固定裁决回答，不碰真宿主。两个测试文件共用一份，
 *  别各写一份同形状的 stub。 */
import type { ConnectionPort, ConnectionVerdict } from '../../src/ports/connection-port.js'

export function connectionStub(verdict: ConnectionVerdict): ConnectionPort {
  return { verdictFor: () => verdict }
}

export const ABSENT_CONNECTION = connectionStub({ kind: 'absent' })
export const ALLOWED_CONNECTION = connectionStub({ kind: 'allowed' })
export const UNAUTHENTICATED_CONNECTION = connectionStub({ kind: 'unauthenticated' })
export const UNTRUSTED_CONNECTION = connectionStub({ kind: 'untrusted' })
