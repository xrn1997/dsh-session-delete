/**
 * **文档门**：文档与代码注释里点名的**仓内路径**必须真实存在，已废的文档称呼不再出现，
 * 指路的 `§N` 必须点名一个还活着的家。
 *
 * 为什么要它：本仓的不变量是"一条事实只住一个家"，而文档里到处是指向"那个家"的路径与小节号。
 * 模块改名（`verbs/apply.ts` → `verbs/batch.ts`）、路由判断搬家（`dispatch()` → `route-table.ts`）
 * 时，代码与测试会跟着红，**文档不会**——它只会留下一个指不到东西的名字，而下一个 agent 恰好
 * 只读文档。2026-10-20 那次全仓文档复核一次就抓到四处这种断链，所以这条门是确定性的、可重跑的。
 *
 * 两类例外都要写明理由再进白名单：**留在 ADR 里的"当时"表**（那一格写的就是改名前的位置，
 * 同行已注明现在的家）与**看着像路径其实不是路径的串**（宿主的事件名、官方生成器的仓形约定）。
 * 白名单不是"改不动就跳过"——那种条目应当改文档。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
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
  join(ROOT, 'CONTRIBUTING.md'),
  join(ROOT, 'CHANGELOG.md'),
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

/** 看着像路径、其实不是路径，或故意保留的历史名。每条都要有理由。 */
const ALLOWED: Record<string, string> = {
  'src/verbs/apply.ts': 'ADR-0001 的"当时"表：那一格写的就是改名前的位置，同行已注明改名到 batch.ts',
}

/** 已废的称呼：批次号、两份批次日志本身、以及它们的"复核候选"编号——都没有可查的坐标了。 */
const DEAD_NAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/docs\/developing\.md/, '开发手册统一为 docs/development.md'],
  [/现状稿/, '现状住 `docs/architecture.md`；"现状稿"这个名字已废'],
  [/第\s*[0-9一二三四五六七八九十百零Nn]+\s*批/, '批次号没有可查的坐标；引用历史写日期，有 commit 就带上，要指裁决就指 ADR 篇号'],
  [/设计稿\s*§|稿\s*§/, '「设计稿 §N」指向已删的两份批次日志；改指还活着的家'],
  [/复核候选|候选\s*[0-9一二三四五六七八九十百零]+/, '候选编号随批次日志一起删了；要指裁决就指 ADR 篇号，要指判据就指文件或测试'],
]

/** 每个 `§N` 指路必须点名一个还活着的家（本节内部则写「本文 §N」）。 */
const SECTION_REF = /§\s*\d/
const SECTION_ANCHORS = ['docs/architecture.md', 'architecture.md', 'docs/ui-spec.md', 'ui-spec.md', 'ui-spec', '本文']

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
    .replace(/\s+/g, '-')
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
  for (const line of readFileSync(join(ROOT, relPath), 'utf8').split(/\r?\n/)) {
    const match = /^#{1,4}\s+(\d+(?:\.\d+)*)\.?\s/.exec(line)
    if (match) sections.add(match[1])
  }
  return sections
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

describe('文档门 · 职责边界', () => {
  it('“唯一主人清单”标题只出现在 architecture.md', () => {
    const offenders = docCorpus
      .filter(({ file, lines }) => rel(file) !== 'docs/architecture.md'
        && lines.some((line) => /^#{1,4}\s.*唯一主人清单/.test(line)))
      .map(({ file }) => rel(file))
    expect(offenders, '主人清单只能有一份；CONTEXT 只定义词，不重复归属').toEqual([])
  })

  it('“界面规格”标题只出现在 docs/ui-spec.md', () => {
    const offenders = docCorpus
      .filter(({ file, lines }) => rel(file) !== 'docs/ui-spec.md'
        && lines.some((line) => /^#{1,4}\s.*界面规格/.test(line)))
      .map(({ file }) => rel(file))
    expect(offenders, '界面规格是一个独立文档；architecture 只留指针').toEqual([])
  })

  it('“文档规范”标题只出现在 docs/AGENTS.md', () => {
    const offenders = docCorpus
      .filter(({ file, lines }) => rel(file) !== 'docs/AGENTS.md'
        && lines.some((line) => /^#{1,4}\s.*文档规范/.test(line)))
      .map(({ file }) => rel(file))
    expect(offenders, '文档分层与生命周期只能有一份').toEqual([])
  })

  it('AGENTS.md 是入口，不是仓库手册', () => {
    const chars = [...readFileSync(join(ROOT, 'AGENTS.md'), 'utf8')].length
    expect(chars, `AGENTS.md ${chars} 字符；超过 8,000 先搬迁或压缩，提额要写理由`).toBeLessThanOrEqual(8000)
  })

  it('点名的小节号在目标文档里真的存在', () => {
    const arch = numberedSections('docs/architecture.md')
    const ui = numberedSections('docs/ui-spec.md')
    const offenders: string[] = []
    eachLine((file, line, i) => {
      const mentionsArch = line.includes('architecture.md')
      const mentionsUi = line.includes('ui-spec.md')
      const check = (sections: Set<string>) => {
        for (const match of line.matchAll(/§\s*(\d+(?:\.\d+)*)/g)) {
          if (!sections.has(match[1])) offenders.push(`${rel(file)}:${i + 1} → §${match[1]}`)
        }
      }
      // 一行同时点两份文档时不猜每个 § 归谁；分开写清楚再指。
      if (mentionsArch && !mentionsUi) check(arch)
      if (mentionsUi && !mentionsArch) check(ui)
      if (rel(file) === 'docs/architecture.md' && line.includes('本文')) check(arch)
    })
    expect(offenders, '小节号只在那份文档里有序；搬家或重排后要同步指路').toEqual([])
  })
})

describe('文档门 · 文档分层', () => {
  it('文档标准存在，根 AGENTS 指向它', () => {
    expect(existsSync(join(ROOT, 'docs', 'AGENTS.md')), '文档分层与生命周期应住 docs/AGENTS.md').toBe(true)
    expect(read('AGENTS.md')).toContain('docs/AGENTS.md')
  })

  it('每个 ADR 文件都进索引，索引里也没有不存在的篇，且每篇恰好一行', () => {
    const files = readdirSync(join(ROOT, 'docs', 'adr'))
      .filter((name) => /^\d{4}-.+\.md$/.test(name))
      .map((name) => name.slice(0, 4))
    expect(files.length, 'ADR 目录没有扫到任何文件').toBeGreaterThan(0)
    // 只认索引表第一列（`| `0001` | …`）：正文里互引别的 ADR 不算重复行。
    const listed = [...read('docs/adr/README.md').matchAll(/^\| `(\d{4})`/gm)].map((match) => match[1]!)
    expect(listed.length, 'ADR 索引没有解析出任何编号').toBeGreaterThan(0)
    expect(new Set(listed).size, 'ADR 索引里有重复行').toBe(listed.length)
    expect(files.filter((id) => !listed.includes(id)), '这些 ADR 没进 docs/adr/README.md').toEqual([])
    expect(listed.filter((id) => !files.includes(id)), '索引指向不存在的 ADR').toEqual([])
  })

  it('每个 ADR 第一行是标题', () => {
    const files = readdirSync(join(ROOT, 'docs', 'adr')).filter((name) => /^\d{4}-.+\.md$/.test(name))
    const bad = files.filter((name) => {
      const first = readFileSync(join(ROOT, 'docs', 'adr', name), 'utf8').split(/\r?\n/)[0] ?? ''
      return !/^# .+/.test(first)
    })
    expect(bad, `缺标题：${bad.join(', ')}`).toEqual([])
  })

  it('每个 ADR 都以锚点段收尾（允许折行）', () => {
    const files = readdirSync(join(ROOT, 'docs', 'adr')).filter((name) => /^\d{4}-.+\.md$/.test(name))
    const bad = files.filter((name) => {
      const blocks = readFileSync(join(ROOT, 'docs', 'adr', name), 'utf8')
        .split(/\r?\n\s*\r?\n/)
        .filter((block) => block.trim() !== '')
      return !/^锚点：/.test((blocks.at(-1) ?? '').trimStart())
    })
    expect(bad, `末段不是锚点：${bad.join(', ')}`).toEqual([])
  })

  it('每个 ADR 紧跟标题有 Status 行', () => {
    const files = readdirSync(join(ROOT, 'docs', 'adr')).filter((name) => /^\d{4}-.+\.md$/.test(name))
    const bad = files.filter((name) => {
      const lines = readFileSync(join(ROOT, 'docs', 'adr', name), 'utf8').split(/\r?\n/)
      return !/^Status: (accepted|superseded by \d{4})$/.test(lines[2] ?? '')
    })
    expect(bad, `缺 Status 或状态不合规：${bad.join(', ')}`).toEqual([])
  })

  it('核心文档在场', () => {
    const required = [
      'AGENTS.md',
      'README.md',
      'CONTEXT.md',
      'CONTRIBUTING.md',
      'CHANGELOG.md',
      'docs/AGENTS.md',
      'docs/architecture.md',
      'docs/development.md',
      'docs/adr/README.md',
      'docs/adr/ADR-FORMAT.md',
    ]
    const missing = required.filter((f) => !existsSync(join(ROOT, f)))
    expect(missing, `缺少核心文档：${missing.join(', ')}`).toEqual([])
  })

})

describe('文档门 · 兼容性事实单源', () => {
  const manifest = JSON.parse(read('package.json')) as CompatibilityManifest
  const releases = Object.keys(manifest.dsh.compatibility.dshReleases)

  /** 徽章只投影首末代次：全量枚举会随每次实测变长，完整名单由下面的正文片段钉住。 */
  const badgeVersions = releases.length > 1 ? [releases[0], releases[releases.length - 1]] : releases
  const badge = `DSH-${badgeVersions.map((version) => version.replaceAll('-', '--')).join('%20%E2%80%A6%20')}`

  const projectionDrift = (readme: string): string[] => {
    const snippets = [
      `窗口是 **\`${manifest.engines.dsh}\`**`,
      `**DSH Desktop ${releases.join('、')}**`,
      `${badge}-brightgreen`,
    ]
    return snippets.filter((snippet) => !readme.includes(snippet))
  }

  it('README 的窗口、真机名单与徽章都从 package.json 投影', () => {
    const drift = projectionDrift(read('README.md'))
    expect(drift, `README 与 package.json 不一致：\n${drift.join('\n')}`).toEqual([])
  })

  it('判据认得出漂移（正控）', () => {
    const drifted = read('README.md').replace(manifest.engines.dsh, '>=0.1.0 <0.3.0-0')
    expect(projectionDrift(drifted)).not.toEqual([])
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
  const images = [...read('README.md').matchAll(
    /https:\/\/raw\.githubusercontent\.com\/[^)\s]+\/main\/(docs\/screenshots\/[^)\s]+)/g,
  )].map((match) => match[1]!)

  const drift = (found: string[], listed: string[]): string[] => {
    const a = [...new Set(found)].sort()
    const b = [...new Set(listed)].sort()
    return [
      ...a.filter((path) => !b.includes(path)).map((path) => `README 有、清册没有：${path}`),
      ...b.filter((path) => !a.includes(path)).map((path) => `清册有、README 没有：${path}`),
    ]
  }

  it('README 截图、screenshots.json、本地文件三者一致', () => {
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
