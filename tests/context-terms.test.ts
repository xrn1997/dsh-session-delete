import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { withoutComments } from './support/comments.js'
import { collectFiles } from './support/corpus.js'

/**
 * `CONTEXT.md` 每条词条点名的记号必须在生产代码里现查得到。
 *
 * 为什么要机器门而不是信任这份表：它是接活时最先读的一页，指着不存在的符号比没有更糟——
 * 「符号删了、文档还留着」正是本门要防的漂移。判据按**符号**查（剥注释后的
 * src/** 与仓库根 `*.ts`），注释里提一嘴不算实现。
 *
 * 第二条门守词汇表自身的承诺：**每个词条都点名仓内锚点**（不许退化成散文 glossary）、
 * **不许指已出库的东西**（本仓在册的散文文档是 `README.md` / `AGENTS.md` 与 `docs/**`）。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CONTEXT = readFileSync(join(ROOT, 'CONTEXT.md'), 'utf8')

/** 生产代码 = src/ 全部 .ts/.tsx + 仓库根的 .ts 配置（构建期守卫住在 tsdown.config.ts） */
function productionText(): string {
  const src = collectFiles(join(ROOT, 'src'), /\.(ts|tsx)$/, ['node_modules', 'lib', '.git', '.qoder', '.superpowers'])
    .map((p) => withoutComments(readFileSync(p, 'utf8')))
  const rootConfigs = readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.ts$/.test(e.name))
    .map((e) => withoutComments(readFileSync(join(ROOT, e.name), 'utf8')))
  return [...src, ...rootConfigs].join('\n')
}
const CODE = productionText()

/** 词条行：`**名（en）**:`；全角冒号也收，格式漂了由下面的格式门报红，不静默漏检。 */
const TERM_LINE = /^\*\*(.+?)\*\*\s*[:：]\s*$/

interface Term { name: string; body: string; line: number }
function terms(): Term[] {
  const lines = CONTEXT.split('\n')
  const out: Term[] = []
  let cur: Term | null = null
  lines.forEach((l, i) => {
    const m = TERM_LINE.exec(l)
    if (m) { cur = { name: m[1]!, body: l, line: i + 1 }; out.push(cur); return }
    if (cur && l.trim() !== '') cur.body += `\n${l}`
    if (l.trim() === '') cur = null
  })
  return out
}

/** 反引号里的记号：路径 / 标识符（含限定名）两类才回查；带标点、斜杠、空格的（表达式、事件名、路径片段、短语）跳过 */
function anchors(body: string): string[] {
  return [...body.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)
}
const isPath = (t: string) => /\.[tj]sx?$/.test(t) && !t.includes(' ')
// 标识符不以 `$` 开头：`$DSH_HOME` 这类是环境变量，不是可以现查的符号。
// 限定名也要收：`RouteSpec.read`、`CoreDeps.presence` 是本仓写 `_唯一实现_` 的口径，只认裸标识符
// 等于把字段级改名留给评审记性。
const isSymbol = (t: string) => /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(t)

/** 逐段按词边界查：子串匹配会让 `read` 在任何长标识符里替自己顶包，等于没查。 */
function missingSymbols(symbols: string[], code: string): string[] {
  return symbols.filter((symbol) => !symbol.split('.').every((segment) => new RegExp(`\\b${segment}\\b`).test(code)))
}

/** `_Avoid_` 行给的是被否的说法，不是实现声明；点名家只认定义句。 */
const definition = (t: Term): string => t.body.split('\n').filter((l) => !l.trimStart().startsWith('_Avoid_')).join('\n')

/** 词条里的路径按「仓根 → `src/`」两试；`src/ports/home.ts` 与 `ports/home.ts` 两种写法都算在场。 */
function inRepoOrSrc(t: string): boolean {
  return existsSync(join(ROOT, t)) || existsSync(join(ROOT, 'src', t))
}

describe('CONTEXT.md 的词条与锚点', () => {
  const T = terms()

  it('表里有词条（解析器不能对着空表报绿）', () => {
    expect(T.length).toBeGreaterThan(20)
  })

  it('每条 `**…**` 起头的行都是合法词条行（格式漂了不会静默漏检）', () => {
    const bad = CONTEXT.split('\n')
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /^\*\*/.test(line) && !TERM_LINE.test(line))
      .map(({ line, i }) => `${i + 1} ${line.trim()}`)
    expect(bad, `这些行像词条但解析器不认（应为 \`**名（en）**:\`）：\n${bad.join('\n')}`).toEqual([])
  })

  it('每个词条都点名仓内锚点', () => {
    const bad = T.filter((t) => anchors(definition(t)).length === 0).map((t) => `${t.line} ${t.name}`)
    expect(bad, `这些词条没点任何实现锚点：\n${bad.join('\n')}`).toEqual([])
  })

  it('写出的源文件路径必须在场', () => {
    const bad: string[] = []
    for (const t of T) for (const a of anchors(t.body)) if (isPath(a) && !inRepoOrSrc(a)) bad.push(`${t.name} → ${a}`)
    expect(bad, `路径漂了：\n${bad.join('\n')}`).toEqual([])
  })

  it('点名的符号在生产代码里现查得到（注释不算命中）', () => {
    const bad: string[] = []
    for (const t of T) {
      bad.push(...missingSymbols(anchors(definition(t)).filter((a) => isSymbol(a) && !isPath(a)), CODE).map((a) => `${t.name} → ${a}`))
    }
    expect(bad, `符号查不到（改名/删除后词条还留着即红）：\n${bad.join('\n')}`).toEqual([])
  })

  it('判据认得出改名的符号与限定名的缺段（正控）', () => {
    expect(missingSymbols(['resolveHome'], CODE), '在册符号被判成查不到').toEqual([])
    expect(missingSymbols(['resolveHomeRenamedAway'], CODE)).toEqual(['resolveHomeRenamedAway'])
    const tiny = 'interface RouteSpec { read: string }'
    expect(missingSymbols(['RouteSpec.read'], tiny)).toEqual([])
    expect(missingSymbols(['RouteSpec.readGone'], tiny)).toEqual(['RouteSpec.readGone'])
    expect(missingSymbols(['read'], 'const readable = 1'), '子串匹配会让长标识符替短名顶包').toEqual(['read'])
  })
})

describe('CONTEXT.md 不许指着已出库的东西', () => {
  it('不提已删的设计文档与本机过程产物', () => {
    const DEAD = /docs\/(design|reference)\/|\.superpowers\/[A-Za-z0-9_-]+\/?[A-Za-z0-9_.-]*\.(?:md|json|ts|js)/
    const hits = CONTEXT.split('\n').map((l, i) => ({ l, i })).filter(({ l }) => DEAD.test(l))
    expect(hits.map(({ i, l }) => `${i + 1} ${l.trim().slice(0, 90)}`), '指向了已出库或不在册的文档').toEqual([])
  })
})
