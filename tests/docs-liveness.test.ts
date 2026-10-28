/**
 * **文档门（三件套之一）**：文档与代码注释里点名的仓内路径必须真实存在，已废的文档称呼不再出现，
 * 指路的 `§N` 必须点名一个还活着的家，ADR 的编号、索引、状态与锚点各只有一份形态。
 *
 * 为什么用它：本仓的不变量是「一条事实只住一个家」，而文档里到处是指向那个家的路径与小节号。
 * 模块改名、符号搬家、路由判据换文件时，代码与测试会跟着红，**文档不会**——它只会留下一个
 * 指不到东西的名字，而下一个 agent 恰好只读文档。所以这条门是确定性的、可重跑的。
 *
 * 三条配套判据各管一段，别合并：
 * - `tests/context-terms.test.ts`：`CONTEXT.md` 点名的符号能不能现查得到；
 * - `tests/comment-altitude.test.ts`：代码注释是不是在抄代码；
 * - 本文件：**文档与代码注释**的路径、引用形态、职责边界与 ADR 形状。
 *
 * 两类例外要写明理由再进白名单：留在 ADR 里的「当时」坐标，与看着像路径其实不是路径的串。
 * 白名单不是「改不动就跳过」——那种条目应当改文档。死名没有豁免。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { collectFiles } from './support/corpus.js'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')

/** 报错信息里用相对路径，别把这台机器的绝对路径打进测试输出。 */
function rel(file: string): string {
  return file.slice(ROOT.length + 1).replace(/\\/g, '/')
}

/** 生成快照与构建产物不是判据的家；这些目录一律不进语料。 */
const SKIP_DIRS = ['node_modules', 'lib', '.git', '.qoder']

/**
 * 被测的是手写的那几份 + 代码注释；生成的 `.qoder/repowiki` 不在内。
 * 自排除：本文件正文引用着被禁的称呼与历史文件名，扫自己必然自红；`tests/comment-altitude.test.ts`
 * 对自身扫描也另有排除（合成样品故意含抄写形）。自排除不是白名单。
 */
const targets = [
  join(ROOT, 'AGENTS.md'),
  join(ROOT, 'CONTEXT.md'),
  join(ROOT, 'README.md'),
  join(ROOT, 'CONTRIBUTING.md'),
  join(ROOT, 'CHANGELOG.md'),
  ...collectFiles(join(ROOT, 'docs'), /\.(md|ts|tsx|css)$/, SKIP_DIRS),
  ...collectFiles(join(ROOT, 'src'), /\.(md|ts|tsx|css)$/, SKIP_DIRS),
  ...collectFiles(join(ROOT, 'tests'), /\.(md|ts|tsx|css)$/, SKIP_DIRS),
].filter((f) => f !== join(ROOT, 'tests', 'docs-liveness.test.ts'))

/** 一次读进来，下面几道门共用这份语料。 */
const corpus = targets.map((file) => ({
  file,
  lines: readFileSync(file, 'utf8').split(/\r?\n/),
}))

/** 手写文档（根文档 + docs/**）；结构门只看这些，src/tests 的注释不参与。 */
const rootDocs = new Set([
  join(ROOT, 'AGENTS.md'),
  join(ROOT, 'CONTEXT.md'),
  join(ROOT, 'README.md'),
  join(ROOT, 'CONTRIBUTING.md'),
  join(ROOT, 'CHANGELOG.md'),
])
const docsRoot = join(ROOT, 'docs') + sep
const docCorpus = corpus.filter(({ file }) => rootDocs.has(file) || file.startsWith(docsRoot))

function eachLine(visit: (file: string, line: string, index: number) => void): void {
  for (const { file, lines } of corpus) lines.forEach((line, index) => visit(file, line, index))
}

/** 指向仓内文件的相对路径：`src/…`、`tests/…`、`docs/…`、`locale/…`。 */
const PATH_REF = /(?:^|[^A-Za-z0-9_./~-])(src|tests|docs|locale)\/([A-Za-z0-9_\-./]*)/g
/** 反引号里带目录的裸相对路径：`trash/entry.ts` 省掉 `src/` 的写法，先按仓根、再按 `src/` 解析。 */
const BACKTICK_REL = /`([A-Za-z0-9_-]+\/[A-Za-z0-9_./-]*\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml))`/g

/** 看着像路径、其实不是路径，或故意保留的历史名。每条都要有理由。 */
const ALLOWED: Record<string, string> = {
  'src/verbs/apply.ts': 'ADR-0001 的「当时」表：那一格写的就是改名前的位置，同行已注明改名到 batch.ts',
  'tests/docs.test.ts': 'ADR-0010 / ADR-0011 的「当时」坐标：当时文档门叫 tests/docs.test.ts，已被 ADR-0024 拆成三件套；旧 ADR 正文保留，不改写历史',
}

/** 已废的称呼：批次号、已改名的开发手册、以及它们的「复核候选」编号——都没有可查的坐标了。 */
const DEAD_NAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/docs\/developing\.md/, '开发手册统一为 docs/development.md'],
  [/现状稿/, '现状住 `docs/architecture.md`；「现状稿」这个名字已废'],
  [/第\s*[0-9一二三四五六七八九十百零Nn]+\s*批/, '批次号没有可查的坐标；引用历史写日期，有 commit 就带上，要指裁决就指 ADR 篇号'],
  [/设计稿\s*§|稿\s*§/, '「设计稿 §N」指向已删的批次日志；改指还活着的家'],
  [/复核候选|候选\s*[0-9一二三四五六七八九十百零]+/, '候选编号随批次日志一起删了；要指裁决就指 ADR 篇号，要指判据就指文件或测试'],
  [/`docs\/adr\/\d{4}/, 'ADR 互引统一写 `ADR-NNNN`；文件路径只写 `docs/adr/` 或 `docs/adr/README.md`'],
  [/\.superpowers\/[A-Za-z0-9_-]+\/?[A-Za-z0-9_.-]*\.(?:md|json|ts|js|cjs|mjs)/, '本机过程产物不是可回查的出处'],
]

/** 每个 `§N` 指路必须点名一个还活着的家（本节内部则写「本文 §N」）。 */
const SECTION_REF = /§\s*\d/
const SECTION_ANCHORS = ['docs/architecture.md', 'architecture.md', 'docs/ui-spec.md', 'ui-spec.md', 'ui-spec', 'docs/AGENTS.md', '本文']
/** 行号引用：`file.ext:123` 会随任何一次编辑漂移，要指实现就指符号锚。 */
const LINE_REF = /\b[A-Za-z0-9_./-]+\.(?:ts|tsx|js|mjs|cjs|json|md|ya?ml|css):[0-9]+\b/g
const lineRefs = (text: string): string[] => [...text.matchAll(LINE_REF)].map((match) => match[0])

/** ADR 编号只许追加：重号与断号都是「有人抄不到那一页」。 */
function adrNumbering(nums: number[]): string[] {
  const sorted = [...nums].sort((a, b) => a - b)
  const dupes = sorted.filter((n, i) => i > 0 && sorted[i - 1] === n)
  const gaps: string[] = []
  for (let n = sorted[0]!; n <= sorted[sorted.length - 1]!; n++) if (!sorted.includes(n)) gaps.push(String(n))
  return [...(dupes.length > 0 ? [`重号：${[...new Set(dupes)].join(', ')}`] : []), ...gaps.map((n) => `断号：${n}`)]
}

interface CompatibilityManifest {
  engines: { dsh: string }
  dsh: { compatibility: { dshReleases: Record<string, string> } }
}

function normalize(raw: string): string {
  // 中文句读与括号会紧跟在路径后面：剥掉尾部噪声
  return raw.replace(/[.,;:!?)\]}、。，；：）】」]+$/u, '')
}

function read(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8')
}

function pathExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function stripFencedCode(markdown: string): string {
  return markdown.replace(/^```[\s\S]*?^```/gm, '')
}

function slugify(text: string): string {
  return text
    .trim()
    .replace(/<[^>]+>/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    // GitHub 口径：一个空格换一个连字符，不折叠。「TXT / EPUB」去掉斜杠后是两个空格 → 两个连字符。
    .replace(/\s/g, '-')
    .replace(/^-+|-+$/g, '')
}

function headingSlugs(markdown: string): Set<string> {
  const seen = new Map<string, number>()
  const slugs = new Set<string>()
  for (const line of stripFencedCode(markdown).split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (match === null) continue
    const base = slugify(match[1]!)
    const count = seen.get(base) ?? 0
    slugs.add(count === 0 ? base : `${base}-${count}`)
    seen.set(base, count + 1)
  }
  return slugs
}

function linkTargets(markdown: string): string[] {
  return [...stripFencedCode(markdown).matchAll(/\]\(([^)]+)\)/g)]
    .map((match) => match[1]!.split(/\s+/)[0]!)
    // `java["ajax"]("…")` 这类代码片段长得像链接；目标以引号开头的一律不算。
    .filter((target) => !/^["'“”‘’]/.test(target))
}

function decodeAnchor(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function brokenLinks(file: string, markdown: string): string[] {
  const broken: string[] = []
  const ownSlugs = headingSlugs(markdown)
  for (const target of linkTargets(markdown)) {
    if (/^(?:https?:|mailto:|tel:)/i.test(target)) continue
    if (target.startsWith('<')) continue
    const [rawPath = '', ...rawAnchor] = target.split('#')
    const anchor = rawAnchor.join('#')
    const path = rawPath.split('?')[0]!
    if (path === '') {
      if (anchor !== '' && !ownSlugs.has(decodeAnchor(anchor))) broken.push(`${rel(file)} → #${anchor}`)
      continue
    }
    const resolved = resolve(dirname(file), decodeAnchor(path))
    if (!pathExists(resolved)) {
      broken.push(`${rel(file)} → ${target}`)
      continue
    }
    if (anchor !== '' && resolved.endsWith('.md')) {
      const targetSlugs = headingSlugs(readFileSync(resolved, 'utf8'))
      if (!targetSlugs.has(decodeAnchor(anchor))) broken.push(`${rel(file)} → ${target}`)
    }
  }
  return broken
}

/** 文档里实际存在的编号小节（`## 1. ...` / `## 2.3 ...`）。 */
function numberedSections(relPath: string): Set<string> {
  const sections = new Set<string>()
  for (const line of read(relPath).split(/\r?\n/)) {
    const match = /^#{1,4}\s+(\d+(?:\.\d+)*)\.?\s/.exec(line)
    if (match) sections.add(match[1]!)
  }
  return sections
}

type SectionHome = 'arch' | 'ui' | 'agents'

/** 有编号小节的那三份文档：`§N` 只可能指到其中之一。 */
const HOME_NAME: Record<SectionHome, string> = {
  arch: 'docs/architecture.md',
  ui: 'docs/ui-spec.md',
  agents: 'docs/AGENTS.md',
}
const SECTIONS: Record<SectionHome, Set<string>> = {
  arch: numberedSections(HOME_NAME.arch),
  ui: numberedSections(HOME_NAME.ui),
  agents: numberedSections(HOME_NAME.agents),
}
const HOME_BY_TOKEN: Record<string, SectionHome> = {
  'architecture.md': 'arch',
  'ui-spec.md': 'ui',
  'docs/AGENTS.md': 'agents',
}
/** 「本文」是谁的自指就归谁；别的文档写「本文」没有可查的编号表，交给「`§N` 必须点名家」那条。 */
const HOME_OF_SELF: Record<string, SectionHome> = { [HOME_NAME.arch]: 'arch', [HOME_NAME.agents]: 'agents' }

/** 行内每个 `§N` 归给在它**之前**最近点到的家：一行同时点两份文档时也各归各家。 */
function sectionOwnership(line: string, relFile: string): Array<{ num: string; home: SectionHome }> {
  const homes: Array<{ at: number; home: SectionHome }> = []
  for (const m of line.matchAll(/architecture\.md|ui-spec\.md|docs\/AGENTS\.md|本文/g)) {
    const home = m[0] === '本文' ? HOME_OF_SELF[relFile] : HOME_BY_TOKEN[m[0]]
    if (home !== undefined) homes.push({ at: m.index ?? -1, home })
  }
  const out: Array<{ num: string; home: SectionHome }> = []
  for (const m of line.matchAll(/§\s*(\d+(?:\.\d+)*)/g)) {
    const owner = homes.filter((h) => h.at < (m.index ?? -1)).at(-1)
    if (owner) out.push({ num: m[1]!, home: owner.home })
  }
  return out
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
        // 目录引用（尾斜杠）也要验：被删掉的家同样该红
        const path = raw.endsWith('/') ? raw.slice(0, -1) : raw
        if (path in ALLOWED) continue
        if (!exists(path)) broken.push(`${rel(file)}:${i + 1} → ${raw}`)
      }
    })
    expect(broken, `断链：\n${broken.join('\n')}`).toEqual([])
  })

  it('手写文档里反引号点名的裸路径也指得到东西', () => {
    const broken: string[] = []
    for (const { file, lines } of docCorpus) {
      for (const [i, line] of lines.entries()) {
        for (const m of line.matchAll(BACKTICK_REL)) {
          const p = m[1]!
          if (/^(?:\.{0,2}\/|https?:)/.test(p) || p.includes('*') || p.includes('<')) continue
          // 带前缀的路径已由上一枚判据管；这里只收裸相对路径。
          if (/^(?:src|tests|docs|locale|node_modules|compat)\//.test(p)) continue
          if (p in ALLOWED || `src/${p}` in ALLOWED) continue
          // 首段既不在仓根也不在 src/ 下 ⇒ 这是外部包的路径（如宿主包的 lib/client.js），不是本仓的。
          const first = p.split('/')[0]!
          if (!exists(first) && !exists(`src/${first}`) && !exists(`tests/${first}`)) continue
          if (exists(p) || exists(`src/${p}`) || exists(`tests/${p}`)) continue
          broken.push(`${rel(file)}:${i + 1} → ${p}`)
        }
      }
    }
    expect(broken, `悬空路径：\n${broken.join('\n')}`).toEqual([])
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

describe('文档门 · 引用形态纪律', () => {
  it('不许写行号（会随任何一次编辑漂移）', () => {
    const bad: string[] = []
    eachLine((file, line, i) => {
      for (const hit of lineRefs(line)) bad.push(`${rel(file)}:${i + 1} → ${hit}`)
    })
    expect(bad, `行号形态的引用（改指符号锚）：\n${bad.join('\n')}`).toEqual([])
  })

  it('判据认得出行号引用（正控）', () => {
    expect(lineRefs('判据住 src/trash/attachments.ts:42')).not.toEqual([])
    expect(lineRefs('判据住 src/trash/attachments.ts:7'), '一位数行号同样是行号').not.toEqual([])
    expect(lineRefs('判据住 src/trash/attachments.ts 与 `docs/ui-spec.md` §2')).toEqual([])
  })

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

  it('每个 `§N` 指路都点名一个还活着的家', () => {
    const offenders: string[] = []
    // 代码注释一样扫：注释里的 `§N` 同样是给下一个读者的指路，漂了没人红。
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

  it('ADR 互引都写 `ADR-NNNN` 且那篇在册', () => {
    const numbers = new Set(
      readdirSync(join(ROOT, 'docs', 'adr'))
        .filter((name) => /^\d{4}-.+\.md$/.test(name))
        .map((name) => name.slice(0, 4)),
    )
    const bad: string[] = []
    eachLine((file, line, i) => {
      for (const m of line.matchAll(/ADR-(\d{4})/g)) {
        if (!numbers.has(m[1]!)) bad.push(`${rel(file)}:${i + 1} → ${m[0]}（不在册）`)
      }
    })
    expect(bad, `悬空的 ADR 互引：\n${bad.join('\n')}`).toEqual([])
  })
})

describe('文档门 · 职责边界', () => {
  // 只认小节标题（`##` 及更深）；H1 是篇名，篇名里提一句主题不算第二份。
  it('“唯一主人清单”标题只出现在 architecture.md', () => {
    const offenders = docCorpus
      .filter(({ file, lines }) => rel(file) !== 'docs/architecture.md'
        && lines.some((line) => /^#{2,4}\s.*唯一主人清单/.test(line)))
      .map(({ file }) => rel(file))
    expect(offenders, '主人清单只能有一份；CONTEXT 只定义词，不重复归属').toEqual([])
  })

  it('“界面规格”标题只出现在 docs/ui-spec.md', () => {
    const offenders = docCorpus
      .filter(({ file, lines }) => rel(file) !== 'docs/ui-spec.md'
        && lines.some((line) => /^#{2,4}\s.*界面规格/.test(line)))
      .map(({ file }) => rel(file))
    expect(offenders, '界面规格是一个独立文档；architecture 只留指针').toEqual([])
  })

  it('“文档规范”标题只出现在 docs/AGENTS.md', () => {
    const offenders = docCorpus
      .filter(({ file, lines }) => rel(file) !== 'docs/AGENTS.md'
        && lines.some((line) => /^#{2,4}\s.*文档规范/.test(line)))
      .map(({ file }) => rel(file))
    expect(offenders, '文档分层与生命周期只能有一份').toEqual([])
  })

  it('AGENTS.md 是入口，不是仓库手册', () => {
    const chars = [...read('AGENTS.md')].length
    expect(chars, `AGENTS.md ${chars} 字符；超过 8,000 先搬迁或压缩，提额要写理由`).toBeLessThanOrEqual(8000)
  })

  it('点名的小节号在目标文档里真的存在', () => {
    const offenders: string[] = []
    eachLine((file, line, i) => {
      for (const { num, home } of sectionOwnership(line, rel(file))) {
        if (!SECTIONS[home].has(num)) offenders.push(`${rel(file)}:${i + 1} → §${num}（${HOME_NAME[home]} 没有那一节）`)
      }
    })
    expect(offenders, '小节号只在那份文档里有序；搬家或重排后要同步指路').toEqual([])
  })

  it('节号按位置归属，搬走的节号认得出（正控）', () => {
    expect(sectionOwnership('本文 §3；配置面见 docs/ui-spec.md §5', 'docs/architecture.md').map((r) => `${r.home}:${r.num}`))
      .toEqual(['arch:3', 'ui:5'])
    expect(sectionOwnership('见 docs/architecture.md §4 与 §6', 'README.md').map((r) => r.num)).toEqual(['4', '6'])
    expect(sectionOwnership('写作规则见本文 §3', 'docs/AGENTS.md')).toEqual([{ num: '3', home: 'agents' }])
    expect(sectionOwnership('本文 §3', 'docs/development.md'), '别没有编号小节的文档写「本文」无表可查').toEqual([])
    const drifted = sectionOwnership('见 docs/ui-spec.md §99 与 docs/AGENTS.md §99', 'README.md')
      .filter((r) => !SECTIONS[r.home].has(r.num))
    expect(drifted.map((r) => `${r.home}:${r.num}`), '搬走的节号必须判红').toEqual(['ui:99', 'agents:99'])
  })
})

describe('文档门 · 文档分层与 ADR 形状', () => {
  it('文档标准存在，根 AGENTS 指向它', () => {
    expect(existsSync(join(ROOT, 'docs', 'AGENTS.md')), '文档分层与生命周期应住 docs/AGENTS.md').toBe(true)
    expect(read('AGENTS.md')).toContain('docs/AGENTS.md')
  })

  it('核心文档在场', () => {
    // docs/agents/* 按 ADR-0024 整层算核心文件：目录里新增一份就自动入列，不用回来改这份清单。
    const agentDocs = readdirSync(join(ROOT, 'docs', 'agents'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => `docs/agents/${name}`)
    const required = [
      'AGENTS.md',
      'README.md',
      'CONTEXT.md',
      'CONTRIBUTING.md',
      'CHANGELOG.md',
      'docs/AGENTS.md',
      'docs/architecture.md',
      'docs/ui-spec.md',
      'docs/development.md',
      'docs/adr/README.md',
      'docs/adr/ADR-FORMAT.md',
      ...agentDocs,
    ]
    const missing = required.filter((f) => !existsSync(join(ROOT, f)))
    expect(missing, `缺少核心文档：${missing.join(', ')}`).toEqual([])
  })

  const adrFiles = () => readdirSync(join(ROOT, 'docs', 'adr')).filter((name) => /^\d{4}-.+\.md$/.test(name))

  it('ADR 编号连续不重号（重排会留下断号，断号即有人抄不到那一页）', () => {
    const files = adrFiles()
    expect(files.length, 'ADR 目录没有扫到任何文件').toBeGreaterThan(0)
    const bad = adrNumbering(files.map((name) => Number(name.slice(0, 4))))
    expect(bad, `${bad.join('；')}（只许追加，不许重排）`).toEqual([])
  })

  it('判据认得出断号与重号（正控）', () => {
    expect(adrNumbering([1, 2, 3, 4])).toEqual([])
    expect(adrNumbering([1, 2, 4]).join()).toContain('断号：3')
    expect(adrNumbering([1, 2, 2, 3]).join()).toContain('重号')
  })

  it('每个 ADR 都进索引，索引里也没有不存在的篇，且每篇恰好一行', () => {
    const files = adrFiles().map((name) => name.slice(0, 4))
    // 只认索引表第一列（`| `0001` | …`）：正文里互引别的 ADR 不算重复行。
    const listed = [...read('docs/adr/README.md').matchAll(/^\| `(\d{4})`/gm)].map((match) => match[1]!)
    expect(listed.length, 'ADR 索引没有解析出任何编号').toBeGreaterThan(0)
    expect(new Set(listed).size, 'ADR 索引里有重复行').toBe(listed.length)
    expect(files.filter((id) => !listed.includes(id)), '这些 ADR 没进 docs/adr/README.md').toEqual([])
    expect(listed.filter((id) => !files.includes(id)), '索引指向不存在的 ADR').toEqual([])
  })

  it('每个 ADR 第一行是标题、紧跟标题有 Status 行', () => {
    const bad: string[] = []
    for (const name of adrFiles()) {
      const lines = readFileSync(join(ROOT, 'docs', 'adr', name), 'utf8').split(/\r?\n/)
      if (!/^# .+/.test(lines[0] ?? '')) bad.push(`${name}: 缺标题`)
      if (!/^Status: (accepted|superseded by \d{4})$/.test(lines[2] ?? '')) bad.push(`${name}: 缺 Status 或状态不合规`)
    }
    expect(bad, bad.join('\n')).toEqual([])
  })

  it('每个 ADR 都以锚点段收尾（允许折行）', () => {
    const bad = adrFiles().filter((name) => {
      const blocks = readFileSync(join(ROOT, 'docs', 'adr', name), 'utf8')
        .split(/\r?\n\s*\r?\n/)
        .filter((block) => block.trim() !== '')
      return !/^锚点：/.test((blocks.at(-1) ?? '').trimStart())
    })
    expect(bad, `末段不是锚点：${bad.join(', ')}`).toEqual([])
  })
})

describe('文档门 · 兼容性事实单源', () => {
  const manifest = JSON.parse(read('package.json')) as CompatibilityManifest
  const releases = Object.keys(manifest.dsh.compatibility.dshReleases)
  const window = manifest.engines.dsh

  /** 徽章只投影首末代次：全量枚举会随每次实测变长，完整名单由正文钉住。 */
  const badgeVersions = releases.length > 1 ? [releases[0]!, releases[releases.length - 1]!] : releases
  const badge = `DSH-${badgeVersions.map((version) => version.replaceAll('-', '--')).join('%20%E2%80%A6%20')}`

  const projectionDrift = (readme: string): string[] => {
    const snippets = [
      `窗口是 **\`${window}\`**`,
      `**DSH Desktop ${releases.join('、')}**`,
      `${badge}-brightgreen`,
    ]
    return snippets.filter((snippet) => !readme.includes(snippet))
  }

  it('README 的窗口、真机名单与徽章都从 package.json 投影', () => {
    const drift = projectionDrift(read('README.md'))
    expect(drift, `README 与 package.json 不一致：\n${drift.join('\n')}`).toEqual([])
  })

  it('判据认得出窗口、名单与徽章各自漂移（正控）', () => {
    const readme = read('README.md')
    expect(projectionDrift(readme.replaceAll(window, '>=0.1.0 <0.3.0-0'))).toContain(`窗口是 **\`${window}\`**`)
    expect(projectionDrift(readme.replaceAll(releases[0]!, '0.0.0-not-real'))).not.toEqual([])
    expect(projectionDrift(readme.replaceAll(`${badge}-brightgreen`, 'DSH-nope-brightgreen'))).toContain(`${badge}-brightgreen`)
  })

  it('AGENTS 只把 package.json 说成兼容性事实源', () => {
    const agents = read('AGENTS.md')
    expect(agents).toContain('事实源是 `package.json`')
    expect(agents).not.toContain('以 `package.json`、`README.md` 和 `tests/skeleton.test.ts` 为准')
  })
})

describe('文档门 · 相对链接与锚点', () => {
  it('手写文档里的相对链接与锚点都指得到东西', () => {
    const broken = docCorpus.flatMap(({ file, lines }) => brokenLinks(file, lines.join('\n')))
    expect(broken, `断链或死锚点：\n${broken.join('\n')}`).toEqual([])
  })

  it('判据认得出缺失文件与死锚点（正控）', () => {
    const readme = read('README.md')
    const missingFile = brokenLinks(join(ROOT, 'README.md'), `${readme}\n[x](definitely-missing.md)`)
    const missingAnchor = brokenLinks(join(ROOT, 'README.md'), `${readme}\n[x](#definitely-missing-anchor)`)
    expect(missingFile).not.toEqual([])
    expect(missingAnchor).not.toEqual([])
  })
})

describe('文档门 · 截图清单', () => {
  const manifest = JSON.parse(read('screenshots.json')) as string[]
  const images = [...read('README.md').matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)]
    .map((match) => /(docs\/screenshots\/[^)\s]+)/.exec(match[1]!)?.[1])
    .filter((path): path is string => path !== undefined)

  const drift = (found: string[], listed: string[]): string[] => {
    const a = [...new Set(found)].sort()
    const b = [...new Set(listed)].sort()
    return [
      ...a.filter((path) => !b.includes(path)).map((path) => `README 有、清册没有：${path}`),
      ...b.filter((path) => !a.includes(path)).map((path) => `清册有、README 没有：${path}`),
    ]
  }

  it('README 截图、screenshots.json、本地文件三者一致', () => {
    expect(images.length, 'README 没有引用任何截图').toBeGreaterThan(0)
    expect(images.length, 'README 截图重复').toBe(new Set(images).size)
    expect(manifest.length, 'screenshots.json 重复').toBe(new Set(manifest).size)
    const now = drift(images, manifest)
    expect(now, now.join('\n')).toEqual([])
    for (const path of manifest) expect(pathExists(join(ROOT, path)), path).toBe(true)
    // 反方向：本地多出来的图也必须进清单，否则它既没人引用、也不会被核对。
    const local = readdirSync(join(ROOT, 'docs', 'screenshots'))
      .filter((name) => /\.(png|jpe?g)$/i.test(name))
      .map((name) => `docs/screenshots/${name}`)
    expect(local.filter((path) => !manifest.includes(path)), '本地有、清单没有').toEqual([])
  })

  it('判据认得出漂移（正控）', () => {
    expect(drift([...images, 'docs/screenshots/extra.png'], manifest)).not.toEqual([])
    expect(drift(images, [...manifest, 'docs/screenshots/extra.png'])).not.toEqual([])
  })
})
