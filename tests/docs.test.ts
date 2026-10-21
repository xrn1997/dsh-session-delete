/**
 * **文档门**：文档与代码注释里点名的**仓内路径**必须真实存在，已废的文档称呼不再出现，
 * 指路的 `§N` 必须点名一个还活着的家。
 *
 * 为什么要它：本仓的不变量是"一条事实只住一个家"，而文档里到处是指向"那个家"的路径。
 * 模块改名（`verbs/apply.ts` → `verbs/batch.ts`）、路由判断搬家（`dispatch()` → `route-table.ts`）
 * 时，代码与测试会跟着红，**文档不会**——它只会留下一个指不到东西的名字，而下一个 agent 恰好
 * 只读文档。2026-10-20 那次全仓文档复核一次就抓到四处这种断链，所以这条门是确定性的、可重跑的。
 *
 * 两类例外都要写明理由再进白名单：**留在 ADR 里的"当时"表**（那一格写的就是改名前的位置，
 * 同行已注明现在的家）与**看着像路径其实不是路径的串**（宿主的事件名、官方生成器的仓形约定）。
 * 白名单不是"改不动就跳过"——那种条目应当改文档。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')

/** 报错信息里用相对路径，别把这台机器的绝对路径打进测试输出。 */
function rel(file: string): string {
  return file.slice(ROOT.length + 1).replace(/\\/g, '/')
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'lib' || entry === '.git') continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(md|ts|tsx|css)$/.test(entry)) out.push(p)
  }
  return out
}

/** 被测的是手写的那几份；生成的 `.qoder/repowiki` 不在内（它不是判据的家）。 */
const targets = [
  join(ROOT, 'AGENTS.md'),
  join(ROOT, 'CONTEXT.md'),
  join(ROOT, 'README.md'),
  ...walk(join(ROOT, 'docs')),
  ...walk(join(ROOT, 'src')),
  ...walk(join(ROOT, 'tests')),
  // 自排除：本文件体内引用着被禁的称呼与已删的 `docs/design/`，扫自己必然自红。
].filter((f) => f !== join(ROOT, 'tests', 'docs.test.ts'))

/** 一次读进来，下面三道门共用这份语料。 */
const corpus = targets.map((file) => ({
  file,
  lines: readFileSync(file, 'utf8').split(/\r?\n/),
}))

function eachLine(visit: (file: string, line: string, index: number) => void): void {
  for (const { file, lines } of corpus) lines.forEach((line, index) => visit(file, line, index))
}

/** 指向仓内文件的相对路径：`src/…`、`tests/…`、`docs/…`、`locale/…`。 */
const PATH_REF = /(?:^|[^A-Za-z0-9_./~-])(src|tests|docs|locale)\/([A-Za-z0-9_\-./]*)/g

/** 看着像路径、其实不是路径，或故意保留的历史名。每条都要有理由。 */
const ALLOWED: Record<string, string> = {
  'docs/adr/0001..0007': '散文里的区间写法（ADR-0001 到 0007 七篇），不是单个文件',
  'src/verbs/apply.ts': 'ADR-0001 的"当时"表：那一格写的就是改名前的位置，同行已注明改名到 batch.ts',
}

/** 已废的称呼：批次号、两份批次日志本身、以及它们的"复核候选"编号——都没有可查的坐标了。 */
const DEAD_NAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/现状稿/, '现状住 `docs/architecture.md`；"现状稿"这个名字已废'],
  [/第\s*[0-9一二三四五六七八九十百零Nn]+\s*批/, '批次号没有可查的坐标；引用历史写日期，有 commit 就带上，要指裁决就指 ADR 篇号'],
  [/设计稿\s*§|稿\s*§/, '「设计稿 §N」指向已删的两份批次日志；改指还活着的家'],
  [/复核候选|候选\s*[0-9一二三四五六七八九十百零]+/, '候选编号随批次日志一起删了；要指裁决就指 ADR 篇号，要指判据就指文件或测试'],
]

/** 每个 `§N` 指路必须点名一个还活着的家（本节内部则写「本文 §N」）。 */
const SECTION_REF = /§\s*\d/
const SECTION_ANCHORS = ['docs/architecture.md', 'architecture.md', '本文', '界面规格']

function normalize(raw: string): string {
  // 中文句读与括号会紧跟在路径后面：剥掉尾部噪声
  return raw.replace(/[.,;:!?)\]}、。，；：）】」]+$/u, '')
}

function exists(path: string): boolean {
  const candidates = [
    path,
    // 代码注释里的 ESM 请求带 `.js`，源文件是 `.ts` / `.tsx`
    path.replace(/\.js$/, '.ts'),
    path.replace(/\.js$/, '.tsx'),
    path.replace(/\.ts$/, '.tsx'),
  ]
  return candidates.some((c) => {
    try {
      const s = statSync(join(ROOT, c))
      return s.isFile() || s.isDirectory()
    } catch {
      return false
    }
  })
}

describe('文档门 · 指名的仓内路径必须存在', () => {
  it('文档与代码注释里点名的 src/tests/docs/locale 路径都指得到东西', () => {
    const broken: string[] = []
    eachLine((file, line, i) => {
      for (const m of line.matchAll(PATH_REF)) {
        const raw = normalize(`${m[1]}/${m[2]}`)
        if (raw.includes('*') || raw.includes('<')) continue
        // 目录引用（尾斜杠）也要验：`docs/design/` 这种被删掉的家同样该红
        const path = raw.endsWith('/') ? raw.slice(0, -1) : raw
        if (path in ALLOWED) continue
        if (!exists(path)) broken.push(`${rel(file)}:${i + 1} → ${raw}`)
      }
    })
    expect(broken, `断链：\n${broken.join('\n')}`).toEqual([])
  })

  it('白名单里没有已经不再出现的僵尸条目', () => {
    const seen = new Set<string>()
    eachLine((_file, line) => {
      for (const m of line.matchAll(PATH_REF)) {
        const raw = normalize(`${m[1]}/${m[2]}`)
        const path = raw.endsWith('/') ? raw.slice(0, -1) : raw
        if (path in ALLOWED) seen.add(path)
      }
    })
    expect(Object.keys(ALLOWED).filter((key) => !seen.has(key)), '这些白名单条目已无对应引用，删掉它们').toEqual([])
  })
})

describe('文档门 · 已废的称呼不再出现', () => {
  it('「现状稿」「第 N 批」「设计稿 §N」「复核候选」都不再出现', () => {
    const offenders: string[] = []
    eachLine((file, line, i) => {
      for (const [pattern, why] of DEAD_NAMES) {
        const hit = pattern.exec(line)
        if (hit) offenders.push(`${rel(file)}:${i + 1} → ${hit[0]}\n    ${why}`)
      }
    })
    expect(offenders, `还在这样称呼的：\n${offenders.join('\n')}`).toEqual([])
  })

  it('每个 `§N` 指路都点名的确有一个那样的家', () => {
    const offenders: string[] = []
    eachLine((file, line, i) => {
      if (!SECTION_REF.test(line)) return
      if (SECTION_ANCHORS.some((anchor) => line.includes(anchor))) return
      offenders.push(`${rel(file)}:${i + 1} → ${line.trim()}`)
    })
    expect(
      offenders,
      '`§N` 单独出现指不到东西（小节号只在那一份文档里有序）。要指现状就写 `docs/architecture.md` §N，'
        + `要指判据就写文件。\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})
