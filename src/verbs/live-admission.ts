/**
 * 活体准入：删除 / 永久删除 / 孤儿清理之前逐个问会话**有没有活动**；判据与宿主端口 `isLive` 一致
 * （`workspace/session-activity` waterfall 非空即算），任一有活动就整组拒绝、零副作用（ADR-0008）。
 * 「有活动」不只 turn 在跑（后台 job、活动定时任务都算），所以一律问 waterfall，不按 family 现推；何时查归调用方（ADR-0027）。
 */
import type { HostIdentityPort } from '../ports/host-port.js'
import { verbError } from '../errors.js'

/** 逐个问，任一在跑就抛 `live`。名单的挑选（哪些成员算这一组）归调用方，这里只按传入顺序问完。 */
export async function assertNoLive(
  host: Pick<HostIdentityPort, 'isLive'>,
  sessionIds: readonly string[],
): Promise<void> {
  for (const sessionId of sessionIds) {
    if (await host.isLive(sessionId)) throw verbError('live', `会话正在运行：${sessionId}`)
  }
}
