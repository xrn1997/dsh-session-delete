/**
 * 详情账本的**容量与淘汰**（两档共用一份判据）：留多少条、按什么次序淘汰住这里；
 * 账本本身谁读谁写由实例定。
 */

/** 账本 seam。 */
export interface DetailLedger<D> {
  read(id: string): D | undefined
  write(id: string, detail: D): void
  forget(id: string): void
  /** 整本作废（归档集变更时两档共用的读路要丢旧快照）。 */
  clear(): void
}

/**
 * 详情账本的上限。孩子详情从不在清单行里，回收站那本又跨所有面板挂载存活：不设上限时长会话会把每份
 * 详情永久留在进程里。64 远高于一屏能开的条目数，命中率不受影响（两档各持一份、不互相挤兑，ADR-0060 决定第 4 条）。
 */
export const DETAIL_LEDGER_LIMIT = 64

/** 记下一条详情：**重写挪到队尾**（按「最近一次写入」淘汰），再淘汰到上限；Map 由调用方拥有。 */
export function writeDetail<D>(map: Map<string, D>, id: string, detail: D): void {
  map.delete(id)
  map.set(id, detail)
  while (map.size > DETAIL_LEDGER_LIMIT) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}