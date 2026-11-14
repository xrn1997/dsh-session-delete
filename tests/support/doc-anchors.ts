/**
 * 文档锚点解析（两个文档门共用一份）：把「锚点行 / `_唯一实现_` 行」切成**子句**，每个子句自己带
 * 路径与符号；符号回查只认**同子句点名的路径文件**、且先剥注释。两份文档门共用它，避免「ADR 锚点」
 * 与「CONTEXT 词条」对同一句话给出两种判据。
 *
 * 为什么子句要自治：`A（Foo）；B 的 Bar` 里 `Bar` 的归属是 B 不是 A。旧判据把路径当行级状态向后
 * 继承，`Bar` 写错文件也能绿，等于没查。子句切分让「一句话一个归属」成为判据本身。
 *
 * 文件 token（带扩展名）与路径 token（`src/`、`tests/` 等开头，或带目录的相对路径）都算路径；
 * 裸文件名（`README.md`）是文件引用，不当锚点路径，也不是符号。
 *
 * 已知极限（刻意接受，不静默）：同一文件里同名符号无法区分（判据是词边界）；类型成员归属不做 TS
 * 语义验证（`Type.member` 只要求两段都在同文件出现）；多文件单子句按析取归属（任一路径拥有即通过）
 * ——子句写多个 owner 时它是一份析取，不是每份文件都要有。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withoutComments } from './comments.js'
import { collectFiles } from './corpus.js'

/** 仓根：`tests/support/` 往上两级。 */
export const ROOT = fileURLToPath(new URL('../..', import.meta.url))

export interface DocClause {
  readonly text: string
  readonly paths: readonly string[]
  readonly symbols: readonly string[]
}

const FILE_TOKEN = /^[A-Za-z0-9_./-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|css)$/
const PATH_TOKEN = /^(?:src|tests|docs|locale|\.github)\//
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?$/
const ANCHOR_PREFIX = /^\s*锚点：\s*/

/** 锚点行/实现声明行的子句切分；`锚点：` 前缀可有可无。 */
export function clauses(line: string): DocClause[] {
  return line.replace(ANCHOR_PREFIX, '').split(/[；;]/).map((segment) => {
    const tokens = [...segment.matchAll(/`([^`]+)`/g)].map((match) => (match[1] ?? '').trim())
    const paths = tokens.filter((token) => PATH_TOKEN.test(token) || (FILE_TOKEN.test(token) && token.includes('/')))
    const symbols = tokens.filter((token) => IDENT.test(token) && !PATH_TOKEN.test(token) && !FILE_TOKEN.test(token))
    return { text: segment.trim(), paths, symbols }
  }).filter((clause) => clause.text !== '')
}

/**
 * 仓内路径解析：仓根相对路径直接命中；`.js` 回落 `.ts`/`.tsx`、`.ts` 回落 `.tsx`；
 * 省掉 `src/` 的写法按 `src/` 再试一次。解析不到交 undefined，由各门的「路径在场」判据报红。
 */
export function resolveRepoPath(token: string): string | undefined {
  const bases = [token]
  if (token.endsWith('.js')) bases.push(token.replace(/\.js$/, '.ts'), token.replace(/\.js$/, '.tsx'))
  if (token.endsWith('.ts')) bases.push(token.replace(/\.ts$/, '.tsx'))
  const candidates = PATH_TOKEN.test(token) ? bases : [...bases, ...bases.map((base) => join('src', base))]
  return candidates.find((candidate) => existsSync(join(ROOT, candidate)))
}

const textCache = new Map<string, string>()

/** 某份仓内文件的「实现文本」（剥注释后）；门禁里同一文件会被反复回查，这里 memo 一次。 */
export function implementationText(relPath: string): string {
  const cached = textCache.get(relPath)
  if (cached !== undefined) return cached
  const resolved = resolveRepoPath(relPath) ?? relPath
  const text = withoutComments(readFileSync(join(ROOT, resolved), 'utf8'))
  textCache.set(relPath, text)
  return text
}

/** 符号是否在某份仓内文件的实现文本里（限定名逐段、词边界）。 */
export function symbolOwnedBy(relPath: string, symbol: string): boolean {
  const text = implementationText(relPath)
  return symbol.split('.').every((segment) => new RegExp(`\\b${segment}\\b`).test(text))
}

/**
 * 子句级归属：符号由该子句任一**解析得到**的路径文件拥有即通过。一个路径都解析不到时返回 true
 * ——「路径必须在场」是另一个门的判据，这里不重复报红（两个门各自只报自己那一半）。
 */
export function ownedByPaths(paths: readonly string[], symbol: string): boolean {
  const resolved = paths.map((path) => resolveRepoPath(path)).filter((path): path is string => path !== undefined)
  if (resolved.length === 0) return true
  return resolved.some((path) => symbolOwnedBy(path, symbol))
}

/** 含符号的子句里「路径在场 + 符号归属」的违规清单（两门与正控共用同一份判据）。 */
export function clauseOwnershipProblems(line: string): string[] {
  const bad: string[] = []
  for (const clause of clauses(line)) {
    if (clause.symbols.length === 0) continue
    if (clause.paths.length === 0) {
      bad.push(`含符号的子句没有点名路径：\`${clause.text}\``)
      continue
    }
    for (const symbol of clause.symbols) {
      if (!ownedByPaths(clause.paths, symbol)) bad.push(`${clause.paths.join(' / ')} 的 \`${symbol}\``)
    }
  }
  return bad
}

/**
 * ADR 锚点段的符号判据：只看含 ASCII 大写的符号（小写散文词在锚点里也常见，误报比漏报贵）；
 * 历史 ADR 的子句（路径全在历史白名单）跳过归属——旧 ADR 正文保留、不改写历史。
 * `paragraph` 可以是折行后的整段（ADR-FORMAT 允许锚点内容折行）。
 */
export function anchorOwnershipProblems(
  paragraph: string,
  historical: (paths: readonly string[]) => boolean,
): string[] {
  const bad: string[] = []
  for (const clause of clauses(paragraph)) {
    const symbols = clause.symbols.filter((symbol) => /[A-Z]/.test(symbol))
    if (symbols.length === 0) continue
    if (clause.paths.length === 0) {
      bad.push(`含符号的子句没有点名路径：\`${clause.text}\``)
      continue
    }
    if (historical(clause.paths)) continue
    for (const symbol of symbols) {
      if (!ownedByPaths(clause.paths, symbol)) bad.push(`${clause.paths.join(' / ')} 的 \`${symbol}\``)
    }
  }
  return bad
}

export interface DocFile { readonly file: string; readonly lines: readonly string[] }

let docFiles: readonly DocFile[] | null = null

/** 手写文档语料（`docs/**` 的 md，逐行）；ADR 锚点门用它按整段扫折行（CONFIG 语料仍由测试自己读 CONTEXT）。 */
export function docCorpus(): readonly DocFile[] {
  if (docFiles !== null) return docFiles
  docFiles = collectFiles(join(ROOT, 'docs'), /\.md$/, ['node_modules', 'lib', '.git', '.qoder', '.superpowers'])
    .map((path) => ({ file: relative(ROOT, path), lines: readFileSync(path, 'utf8').split(/\r?\n/) }))
  return docFiles
}

let production: string | null = null

/** 生产代码语料（`src/**` 的 ts/tsx + 仓根 `.ts` 配置），剥注释后拼一份；CONTEXT 门用它查符号。 */
export function productionText(): string {
  if (production !== null) return production
  const src = collectFiles(join(ROOT, 'src'), /\.(ts|tsx)$/, ['node_modules', 'lib', '.git', '.qoder', '.superpowers'])
    .map((path) => withoutComments(readFileSync(path, 'utf8')))
  const rootConfigs = readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => withoutComments(readFileSync(join(ROOT, entry.name), 'utf8')))
  production = [...src, ...rootConfigs].join('\n')
  return production
}