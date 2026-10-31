/**
 * 活体准入：删除 / 永久删除 / 孤儿清理之前，逐个问会话是否在宿主内存里 attach 着；
 * 任一在跑就整组拒绝、零副作用（ADR-0008）。
 *
 * 边界：什么时候查归调用方——永久删除在计划里查一次、执行器第一笔写前用计划里的会话名单再查一次（ADR-0027）；
 * 本模块只拥有「查什么、怎么判、怎么说」。
 */
import type { HostIdentityPort } from '../ports/host-port.js'
import { verbError } from './errors.js'

/** 逐个问，任一在跑就抛 `live`。名单的挑选（哪些成员算这一组）归调用方，这里只按传入顺序问完。 */
export async function assertNoLive(
  host: Pick<HostIdentityPort, 'isLive'>,
  sessionIds: readonly string[],
): Promise<void> {
  for (const sessionId of sessionIds) {
    if (await host.isLive(sessionId)) throw verbError('live', `会话正在运行：${sessionId}`)
  }
}
