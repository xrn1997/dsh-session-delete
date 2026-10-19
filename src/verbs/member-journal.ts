/**
 * 一次成员移动 = 一串**自带反向动作的步骤**（ADR-0002）。
 *
 * 为什么需要它：`delete-session.ts` 的 `moveOneIn`/`undoOneIn` 与 `restore-session.ts` 的 `restoreOne`
 * （含它的反向闭包）互为镜像，各自手写了三到四段嵌套 `try/catch`：全仓 `rollbackReason(` **22 处**、
 * `withRollbackFailures(` **8 处**。那不是"回滚值得自己的候选"，而是**同一条正反动作对被写了两遍**。
 *
 * 这里独占四件事，三个动词各自只声明"这次要做哪几步、每步怎么退"：
 * ① **相反顺序**退化（最后做成的先退）；
 * ② 一步失败时把**已经做成的**那些退回去；
 * ③ 失败收集：某一步退不干净时**不让原错误独走**（`details.rollbackFailures`，见 `verbs/errors.ts`）；
 * ④ **非原子步骤**：`undoOnFailure` 让"这一步自己失败了"也跑它的反向动作（例如"取消归档"半做完了，
 *    得先把会话重新藏回去）。
 *
 * 边界：它只服务"成员在 `sessions/` 与 `session-trash/` 之间搬"这一件事。做成通用撤销框架就会吸进
 * 不属于它的知识（谁该通告、通告几次、哪些失败算成功）。
 */
import { SESSION_DELETE_ERROR_DOMAIN } from '../shared/wire.js'
import { rollbackReason, verbError, withRollbackFailures, type VerbError } from './errors.js'

export interface JournalStep {
  /** 这一步在做什么。失败原文按「`<label>：<原错误>`」拼——与既有那 22 处 `rollbackReason` 的措辞同形。 */
  readonly label: string
  /** 做这一步。抛什么都由 journal 折成 `sessiondelete/io`（除非它自己已经是一个动词码）。 */
  run(): Promise<void>
  /** 反向动作。**`run` 成功之后**才会被登记；返回**这一步自己**没能退干净的原因列表（空 = 完全退回）。 */
  undo?(): Promise<readonly string[]>
  /** 这一步**自己**失败时也跑 `undo`：给"可能已经半做完"的非原子步骤用（取消归档是唯一的例子）。 */
  readonly undoOnFailure?: boolean
}

export interface Journal {
  /** 按顺序跑完。中途失败 ⇒ 已做成的按相反顺序退回，然后把原错误（带 `rollbackFailures`）抛出去。 */
  run(): Promise<void>
  /** 把**已经做成**的步骤按相反顺序退回去（整组回滚用：组里后面那个成员搬不动时叫这一句）。 */
  undo(): Promise<readonly string[]>
}

/** 已经把某个前缀做成了的 journal——`undo()` 就退那一个前缀。 */
export function createJournal(steps: readonly JournalStep[]): Journal {
  const done: JournalStep[] = []

  const undoAll = async (alsoFailing?: JournalStep): Promise<readonly string[]> => {
    const failures: string[] = []
    if (alsoFailing?.undo !== undefined) failures.push(...await alsoFailing.undo())
    for (const step of [...done].reverse()) {
      if (step.undo === undefined) continue
      failures.push(...await step.undo())
    }
    return failures
  }

  return {
    async run(): Promise<void> {
      for (const step of steps) {
        try {
          await step.run()
        } catch (error) {
          const failures = await undoAll(step.undoOnFailure === true ? step : undefined)
          const base = journalFailure(step, error)
          throw failures.length > 0 ? withRollbackFailures(base, failures) : base
        }
        done.push(step)
      }
    },
    undo(): Promise<readonly string[]> {
      return undoAll()
    },
  }
}

/** 跑一步反向动作并把它自己的失败收成一条原因（不抛：这些失败由调用方汇总成 `rollbackFailures`）。 */
export async function attempt(label: string, run: () => Promise<unknown>): Promise<readonly string[]> {
  try {
    await run()
    return []
  } catch (error) {
    return [rollbackReason(label, error)]
  }
}

/**
 * **组级回滚**：把已经做成的成员按相反顺序退回；某一步退不干净时把失败并进原错误的
 * `details.rollbackFailures`，绝不让原错误独走（设计稿第十七批）。删除与恢复两个按组走的动词
 * 共用这一处——"相反顺序 + 失败合并"不再各写一遍。
 */
export async function rollbackJournals(journals: readonly Journal[], error: unknown): Promise<never> {
  const failures: string[] = []
  for (const journal of [...journals].reverse()) failures.push(...await journal.undo())
  if (failures.length > 0) throw withRollbackFailures(error, failures)
  throw error
}

/**
 * 这一步的失败形状：已经是动词码（`verbError` 的输出）就原样带，否则折成 `sessiondelete/io`。
 * 原文用 `String(error)` 而不是 `.message`——那 22 处既有措辞就是这么拼的（`Error: boom` 也在里面），
 * 换一种拼法会让上屏原文跟着变。
 */
function journalFailure(step: JournalStep, error: unknown): VerbError {
  const raw = (error as { code?: unknown } | undefined)?.code
  if (typeof raw === 'string' && raw.startsWith(`${SESSION_DELETE_ERROR_DOMAIN}/`)) return error as VerbError
  return verbError('io', `${step.label}：${String(error)}`, error)
}
