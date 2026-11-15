/**
 * 活体准入：删除 / 永久删除 / 孤儿清理之前，逐个问会话**有没有活动**；
 * 判据与宿主端口 `isLive` 一致（`workspace/session-activity` waterfall 非空即算），任一有活动就
 * 整组拒绝、零副作用（ADR-0008）。
 *
 * 「有活动」不是只有 turn 在跑：宿主的 waterfall 还会因为该会话的后台 job、仍指向它的活动定时
 * 任务等回条目（各 family 的安装态实现见宿主 `dsh-jobs` / `dsh-schedule` 的 archive admission）。
 * 所以判定一律问 waterfall 非空，不按某一个 family 现推；宿主换代复核 family 清单。
 *
 * 边界：什么时候查归调用方——永久删除在计划里查一次、执行器第一笔写前用计划里的会话名单再查一次（ADR-0027）；
 * 本模块只拥有「查什么、怎么判、怎么说」。
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
