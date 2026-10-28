import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { commentBodies, withoutComments } from './support/comments.js'
import { collectFiles } from './support/corpus.js'

/**
 * 注释高度守卫（可检测形）：**注释不抄代码表达式**。带运算符的表达式若在注释与同文件
 * 非注释代码里逐字同，就是把「怎么做」从代码搬进注释——还随代码漂成谎言。
 * 要指实现就指**符号锚**（函数/常量名、抛错消息原文、测试矩阵行 id）；要写就写为什么/口径。
 *
 * 判断形的「步骤叙述」不进门——那是词表活，只会逼出天天要改的豁免名单；归 `docs/AGENTS.md`
 * 写作规则里那句自测问题（这句删掉，读者丢的是为什么还是怎么做）。范围：src/** 与
 * tests/** 的注释行；docs 归引用锚纪律，不在本门。
 * **本文件自排除**：合成样品的注释故意含抄写形，对自身扫描必然红——检测器靠样品做功能验证。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SELF = 'tests/comment-altitude.test.ts'
/** 运算符交替表只写一份：反引号判据与裸表达式判据同源于它，改一处两处生效。 */
const OP_SOURCE = ['===', '!==', '!=', '=>', '??', '?.', '==', '&&', '||', '>=', '<=']
  .map((op) => op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|')
const OP = new RegExp(OP_SOURCE)
const BARE_EXPR = new RegExp(`[\\w$.[\\]()'" ]*(?:${OP_SOURCE})[\\w$.[\\]()'" ]*`, 'g')

/** 注释体里与同文件代码逐字同的「抄写表达式」（带运算符、≥8 字符） */
function copiedExpressions(fileText: string): string[] {
  const code = withoutComments(fileText)
  const out: string[] = []
  for (const c of commentBodies(fileText)) {
    for (const m of c.matchAll(/`([^`]+)`/g)) {
      const span = m[1].trim()
      if (span.length >= 8 && OP.test(span) && code.includes(span)) out.push(span)
    }
    for (const m of c.replace(/`[^`]*`/g, '').matchAll(BARE_EXPR)) {
      const span = m[0].trim()
      if (span.length >= 8 && code.includes(span)) out.push(span)
    }
  }
  return [...new Set(out)]
}

// 合成样品：坏 = 注释抄了紧邻的分支条件；好 = 同一位置只写为什么。
const BAD_SAMPLE = [
  'function pick(rest: string): string[] {',
  '  // 空分支：rest === \'\' 时丢掉，不再向下',
  "  if (rest === '') return []",
  '  return [rest]',
  '}',
].join('\n')
const GOOD_SAMPLE = [
  'function pick(rest: string): string[] {',
  '  // 剥空即零分支：空规则取值是空列表，自然不贡献——等价于丢分支，不是整条失败',
  "  if (rest === '') return []",
  '  return [rest]',
  '}',
].join('\n')

describe('注释不抄代码表达式（高度规范的机器面）', () => {
  // 回归样：glob 串里「双星号后面那对斜杠加星号」曾被当成块注释起点，一路吞到下一个闭头——中间的真代码
  // 就此从抄写比对的基线里消失，抄写形再也查不到（配置文件的 include 与 exclude 正是两个挨着的这种串）。
  it('剥注释不动 glob 串，真块注释照旧剥掉（共享 helper 的正控）', () => {
    const config = "const include = ['tests/**/*.test.ts', '**/node_modules/**']"
    expect(withoutComments(config)).toBe(config)
    const stripped = withoutComments('/* 这一整段剥掉 */\nconst keep = 1')
    expect(stripped).not.toContain('这一整段剥掉')
    expect(stripped).toContain('const keep = 1')
    expect(stripped, '等长空格替换：偏移不能变').toHaveLength('/* 这一整段剥掉 */\nconst keep = 1'.length)
  })

  it('合成样品：抄写形必被抓住、只写为什么的放行（防检测器空转/误伤）', () => {
    expect(copiedExpressions(BAD_SAMPLE).length, '抄写形没被抓住，检测器已失效').toBeGreaterThan(0)
    expect(copiedExpressions(GOOD_SAMPLE), '好注释被误伤，判定式过宽').toEqual([])
  })

  // 回归样：正则里的反引号曾把字符串态带偏，下面模板串的串体被当代码扫、其中的 `/*` 成了
  // 假块注释起点——真代码冒充注释体，抄写形误伤（现场：矩阵指针门被自己文件里的代码打红）。
  it('字符类里带反引号的指针正则不把后续模板串误当注释体', () => {
    const pointerShape = [
      'const POINTER = /矩阵[`\'“"]?([a-z-]+)/g',
      'const where = `详见 docs/adr/*.md 一侧`',
      'const open = COVERAGE.filter((r) => r.status === \'open\')',
    ].join('\n')
    const fakes = commentBodies(pointerShape).filter((b) => b.includes('*.md'))
    expect(fakes, '正则反引号带偏字符串态，模板串体被当成注释').toEqual([])
    expect(copiedExpressions(pointerShape), '误伤的注释体里抄写形跟着误报').toEqual([])
  })

  it('src/ 与 tests/ 的注释里没有抄写表达式（要指就指符号锚）', () => {
    const bad: string[] = []
    const files = [
      ...collectFiles(join(ROOT, 'src'), /\.tsx?$/),
      ...collectFiles(join(ROOT, 'tests'), /\.tsx?$/, [], new Set([join(ROOT, SELF)])),
    ]
    for (const p of files) {
      for (const span of copiedExpressions(readFileSync(p, 'utf8'))) {
        bad.push(`${p.slice(ROOT.length).replace(/\\/g, '/')}：${span}`)
      }
    }
    expect(bad, `注释抄了代码表达式（升到为什么/口径，或改指符号锚）：\n${bad.join('\n  ')}`).toEqual([])
  })
})
