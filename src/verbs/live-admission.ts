/**
 * 活体准入：一次删除 / 永久删除 / 孤儿清理之前，逐个问「这个会话在宿主内存里 attach 着吗」——
 * 任一个在跑就整组拒绝、零副作用（词表见 CONTEXT.md 的「活体」条；裁决见 ADR-0008）。
 *
 * 为什么单独一个 module：删除的逐个成员与永久删除计划的 targets + 盘上后代，此前各手写一遍同一条
 * 循环、同一句原文。两处只要有一处改了措辞或漏查一个 id，客户端拿到的就是两种「还在跑」。
 *
 * 边界：**什么时候查归调用方**。永久删除的准入仍住在计划里、在任何写之前（ADR-0006：计划就是执行前的闸）；
 * 这个 module 只拥有「查什么、怎么判、怎么说」。
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
