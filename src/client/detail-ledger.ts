/**
 * 详情账本的**容量与淘汰**（两档共用一份判据）：账本本身谁读谁写由实例定——回收站是
 * `trash-snapshot.ts` 的模块级账本（跨面板挂载存活、写时复制），归档是挂载内的 Map。
 * 两种存法不同，但「留多少条、按什么次序淘汰」是同一条口径，住这里。
 */

/** 账本 seam（两种存法见文件头）。 */
export interface DetailLedger<D> {
  read(id: string): D | undefined
  write(id: string, detail: D): void
  forget(id: string): void
  /** 整本作废（归档集变更时两档共用的读路要丢旧快照）。 */
  clear(): void
}

/**
 * 详情账本的上限。孩子详情从不在清单行里（`reloadSucceeded` 只按清单 id 修剪），回收站那本
 * 又是模块级、跨所有面板挂载存活：不设上限时，一个长会话里打开几十个子会话就把每份详情（含已翻
 * 出来的分页块与附件读数）永久留在进程里。64 远高于一屏能开出来的条目数，命中率不受影响。
 * 归档那本按挂载存活、条数同理，用同一个上限（两档各持一份账本，不互相挤兑——ADR-0060 决定第 4 条）。
 */
export const DETAIL_LEDGER_LIMIT = 64

/** 记下一条详情：**重写挪到队尾**（等价于按「最近一次写入」淘汰），再淘汰到上限。
 *  传进来的 Map 由调用方拥有——回收站交的是写时复制出来的新 Map，归档交的是挂载内那一份。 */
export function writeDetail<D>(map: Map<string, D>, id: string, detail: D): void {
  map.delete(id)
  map.set(id, detail)
  while (map.size > DETAIL_LEDGER_LIMIT) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}