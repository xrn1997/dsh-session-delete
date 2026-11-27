/**
 * 会话目录搬移的**瞬态占用重试**（ADR-0073）：`sessions/` 与 `session-trash/` 之间整目录 `rename` 时，
 * Windows 只要目录里有任何一个文件被打开（宿主会话 / 日志句柄、索引或杀软扫描）就回 `EPERM` / `EBUSY` /
 * `EACCES`。这些是短命竞争，不是"权限配错了"；同一次真机批量里一条成员被占用、另一条正常搬走。
 *
 * 判据只住这一处：最多 3 次尝试（首发 + 两次重试），间隔 50 / 150ms，只对上面三种码重试；耗尽后**原样抛
 * 最后一个错误**，信封与文案仍由动词的 journal 折（`sessiondelete/io`）。目标已存在、跨卷 `EXDEV` 与其余
 * 错误都不重试——那三个是判据错误，不是瞬态（见 `src/ports/fs-port.ts` 的 `rename`）。
 *
 * **不是锁、不是退避框架**：不替代留出主视图 / 活体摘除（ADR-0008），不无限重试，也不做"复制 + 删源"的
 * 降级（那会把原子搬移换成可能半途而废的复制）。`sleep` 只为测试可注入；生产不传。
 */
const RETRYABLE_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** 重试间隔（毫秒）：第 n 个间隔对应第 n 次重试。导出给测试与 ADR 引用的读数，不在调用点另抄一份。 */
export const MOVE_DIR_RETRY_DELAYS_MS = [50, 150] as const

export interface MoveDirectoryOptions {
  /** 覆盖重试间隔（测试用）；缺省 {@link MOVE_DIR_RETRY_DELAYS_MS}。 */
  readonly delaysMs?: readonly number[]
  /** 覆盖等待实现（测试用，免得真睡）；缺省 `setTimeout`。 */
  readonly sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

function isRetryableRenameError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && RETRYABLE_RENAME_CODES.has(code)
}

/** 搬目录：瞬态占用按固定小步数重试；判据错误与非瞬态码一次都不重试。 */
export async function moveDirectoryWithRetry(
  rename: (from: string, to: string) => Promise<void>,
  from: string,
  to: string,
  options: MoveDirectoryOptions = {},
): Promise<void> {
  const delays = options.delaysMs ?? MOVE_DIR_RETRY_DELAYS_MS
  const sleep = options.sleep ?? defaultSleep
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const delay = delays[attempt]
      if (delay === undefined || !isRetryableRenameError(error)) throw error
      await sleep(delay)
    }
  }
}
