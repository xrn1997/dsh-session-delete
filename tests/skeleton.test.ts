import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PLATFORM_MODULES, gateClientImport, resolveBrowserBranchImport } from '../tsdown.config.js'
import * as plugin from '../src/index.js'

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as {
  name: string
  main: string
  types: string
  exports: Record<string, unknown>
  files: string[]
  icon: string
  peerDependencies: Record<string, string>
  devDependencies: Record<string, string>
  publishConfig: { access?: string }
  repository: { url?: string }
  scripts: Record<string, string>
  dsh: {
    bundle: { patch: string }
    client: { inject: string[]; platform: string }
    compatibility: { dshReleases: Record<string, string> }
  }
}

/** 本插件真跑过的宿主代次（桌面版实测）。新增一代先在这里落账，再同步 dshReleases。 */
const TESTED_HOST_GENERATIONS = ['0.2.0-rc.2', '0.2.1-rc.1', '0.2.1-rc.2']

/** 从 app.asar 抽出的宿主冻结平台模块表原文——**9 个键**，不是 312 个包名的并集。
 *  这里与 `tsdown.config.ts` 的 `PLATFORM_MODULES` 各自独立记录同一事实：
 *  两边不一致就是有人改了实现或改了实测，必须是一次显式裁定。 */
const FROZEN_PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

describe('插件入口形状', () => {
  it('导出 name 与 apply，且 name 是本包名', () => {
    expect(plugin.name).toBe('@xrn1997/dsh-session-delete')
    expect(typeof plugin.apply).toBe('function')
  })

  // 那条薄线：四个动词经宿主 web server 上的插件专属前缀路由暴露给浏览器半，
  // 所以 Node 半必须注入 webServer（宿主 `dsh-host-webserver` 的服务名逐字如此）。
  // 写错服务名不会报错——插件会永远停在 `pending (waiting for service: …)`，所以钉在这里。
  it('Node 半的 inject 含 webServer（前缀路由的承载者）', () => {
    expect(plugin.inject).toContain('webServer')
  })
})

describe('宿主安装闸与浏览器半声明', () => {
  // 安装闸（asar `dsh-app-boot/lib/index.js` 的 `evaluatePluginCompatibility`）**只比对
  // `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 这两类 peer**：`@deepseek-ai/cordis`、`react` 都不在其列。
  // 所以"装着开着不让人装"只由 dsh* peer 决定，而本插件**一条都没有**——控件与图标已自造、
  // 不再 require 宿主的 `dsh-client-ui-primitives`（见 `src/client/ui/*`）。这条用例把"不钉死宿主代数"
  // 钉成可判的形式：哪天有人加回一条 dsh* peer，它会先红一次，逼一次显式裁定。
  it('没有任何 @deepseek-ai/dsh-* peer（安装闸因此不把插件钉死在某一代宿主上）', () => {
    const peers = Object.keys(manifest.peerDependencies).filter(
      (dep) => dep === '@deepseek-ai/dsh' || dep.startsWith('@deepseek-ai/dsh-'),
    )
    expect(peers).toEqual([])
  })

  // 真加了的话只能开实测过的某一代：peer 区间在 semver 预发布规则下没有"免维护写法"。
  it('若将来确要声明 dsh* peer，区间只能是实测过的某一代（正控）', () => {
    const declared = Object.entries(manifest.peerDependencies).filter(([dep]) =>
      dep.startsWith('@deepseek-ai/dsh-'),
    )
    for (const [dep, range] of declared) {
      expect(TESTED_HOST_GENERATIONS, `${dep} 的 peer 区间只能开实测过的一代`).toContain(range)
    }
  })

  // `dsh.client.inject` 的语义是**包行**（自带 `./client` 的 client 插件包）先到，不是静态表键：
  // 宿主浏览器半 `arriveGraphRow` 逐字 `for (const packageName of row.inject) { const dependency =
  // this.graphRows.get(packageName); if (dependency !== void 0) await this.arriveDependency(...) }`
  // ——名字取不到就静默跳过。本插件唯一需要先到的是 locale 包：客户端半要读 `locale` 服务。
  it('dsh.client.inject 只列 web 组合花名册里真实存在的 client 包（locale）', () => {
    expect(manifest.dsh.client.inject).toEqual(['@deepseek-ai/dsh-client-locale'])
    expect(FROZEN_PLATFORM_MODULES).not.toContain('@deepseek-ai/dsh-client-locale')
  })

  it('manifest 里没有 @deepseek-ai/dsh-client-ui-primitives（已自造控件，不再依赖宿主客户端包）', () => {
    expect(JSON.stringify(manifest)).not.toContain('dsh-client-ui-primitives')
  })

  it('manifest 里没有 @deepseek-ai/dsh-client-connection（不在平台表内，不值 import）', () => {
    expect(JSON.stringify(manifest)).not.toContain('dsh-client-connection')
  })

  it('dshReleases 只写状态词 compatible，且实测代次全部在册', () => {
    const releases = manifest.dsh.compatibility.dshReleases
    for (const generation of TESTED_HOST_GENERATIONS) {
      expect(releases[generation]).toBe('compatible')
    }
    for (const status of Object.values(releases)) expect(status).toBe('compatible')
  })

  // **包形不变式**（官方 `reference/cookbook/adding-a-package` 逐字：`main: "lib/index.js"`、
  // `types: "lib/types/index.d.ts"`、`exports["."].types: "./lib/types/index.d.ts"`、
  // `exports["."].default: "./lib/index.js"`，并且**不发布** `src`、声明映射、JS map、陈旧的根声明文件）。
  // `./client` 那两件的形状不是推的——宿主 `dsh-client-connection` 的 `package.json` 原文就写着
  // `{ "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }`（asar 实读，见现状稿 §9）。
  it('包形不变式：main / types / 两个出口的 types+default 都在 lib/ 与 lib/types/ 下', () => {
    expect(manifest.main).toBe('lib/index.js')
    expect(manifest.types).toBe('lib/types/index.d.ts')
    expect(manifest.exports['.']).toEqual({ types: './lib/types/index.d.ts', default: './lib/index.js' })
    expect(manifest.exports['./client']).toEqual({
      types: './lib/types/client/index.d.ts', default: './lib/client.js',
    })
  })

  // `files` 从「整目录 `lib`」收成**精确产物**：整目录会把 1.26 MB 的 `lib/client.js.map` 一起发出去
  // （官方那条明写"不要发布 JS map"），而 `link:` 装法根本不看这份清单——两处不同步就会只有 npm 在发垃圾。
  it('发布清单精确到产物：不列整目录 lib、不带任何 .map', () => {
    expect(manifest.files).not.toContain('lib')
    for (const entry of manifest.files) expect(entry, entry).not.toMatch(/\.map$/)
    expect(manifest.files).toContain('lib/index.js')
    expect(manifest.files).toContain('lib/client.js')
    expect(manifest.files).toContain('lib/types/**/*.d.ts')
  })

  // 官方那条"peer 与 dev **同范围**、每条 dsh 对等依赖都在 devDependencies 里镜像"要防的是这一件事：
  // 声明的地板是 4.0.2、编译时装的是 4.0.4 ⇒ 那个地板从没被编译过，却写进了契约。
  it('每条 peer 若在 devDependencies 里镜像，范围必须逐字相同', () => {
    for (const [dep, range] of Object.entries(manifest.peerDependencies)) {
      if (dep in manifest.devDependencies) expect(manifest.devDependencies[dep], dep).toBe(range)
    }
  })

  it('两条半产物的入口在 manifest 里声明齐全', () => {
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
  })

  /* ── npm 发布面（缺哪一条，`npm publish` 不是失败就是发出去一个坏包） ── */

  it('scoped 包必须显式声明公开访问，否则首次 publish 被当成私有包拒绝', () => {
    expect(manifest.publishConfig.access).toBe('public')
  })

  it('发布即构建：build 两步（tsdown 出台面 JS，tsc 出 lib/types 声明），prepack 跑 build', () => {
    // `prepack` 在 `npm pack` / `pnpm pack` / `npm|pnpm publish` 四条路上都会跑，
    // 所以"手滑直接 publish 出一个空的 lib/"这件事不可能发生。
    expect(manifest.scripts.prepack).toBe('npm run build')
    // 声明换成 tsc 出到 `lib/types/`（tsdown 那份 `lib/index.d.ts` 正是官方点名不要的"根声明文件"），
    // 顺序不能反：tsdown 的 Node 半配置带 `clean: true`，会先把 `lib/` 抹干净。
    expect(manifest.scripts.build).toBe('tsdown && tsc -p tsconfig.build.json')
  })

  it('展示元信息：locale 两套语言与图标都进了发布清单', () => {
    expect(manifest.exports['./locale/*.json']).toBe('./locale/*.json')
    expect(manifest.files).toContain('locale')
    expect(manifest.files).toContain('icon.svg')
    expect(manifest.icon).toBe('./icon.svg')
  })

  it('仓库/主页/工单面指向真实远端（不是编的 URL）', () => {
    expect(manifest.repository.url).toContain('github.com/xrn1997/dsh-session-delete')
  })
})

describe('浏览器半平台模块表', () => {
  // 表从 9 个键收到 3 个（2026-10-02）：本插件不再 require 任何一个 `@deepseek-ai/*` 客户端包，
  // 只剩 React 家族——它的**模块身份必须与外壳自己那份同一**（否则 hooks 在两个 React 实例间崩），
  // 只能由冻结表解答。收窄是**收紧纯度门**：多留一个键就是多留一个"再 import 它一次"的口子。
  it('只列本插件真正 require 的 React 家族，且都取自那一代冻结表', () => {
    expect([...PLATFORM_MODULES].sort()).toEqual(['react', 'react-dom', 'react/jsx-runtime'])
    for (const name of PLATFORM_MODULES) expect(FROZEN_PLATFORM_MODULES).toContain(name)
  })
})

describe('抄本表点名的自造差异（§8 门 4：除这五条外一律与官方明文逐属性一致）', () => {
  const css = readFileSync(fileURLToPath(new URL('../src/client/ui/ui.css', import.meta.url)), 'utf8')

  it('文件头点名的五条自造规则真在表里（声明与实现对上）', () => {
    expect(css).toContain('.sd-resizing {')
    // 2026-10-16 补的第二条：清单行是 role="option" 的可聚焦 div，键盘焦点必须有可见描边
    expect(css).toContain('[data-dsh-session-delete="trash-row"]:focus-visible {')
    // 2026-10-17 第十三批补的第三条：官方那颗 iconButton 只有常态与 hover，勾选开关要按下/禁用两档
    expect(css).toContain(".sd-rowaction-button[aria-pressed='true'] {")
    // 第四条：宿主没有"浮条"这件控件
    expect(css).toContain('.sd-batch-bar {')
    // 第五条：宿主行自己的选中态归宿主，批量选择要有整行底色；状态点/归档行的兜底不能与行首重复
    expect(css).toContain('[data-row-key^="session:"]:has([data-dsh-session-delete="batch-pick"][data-checked="true"])')
    expect(css).toContain('[data-seat="leading"]) .sd-batch-pick-action')
    expect(/五处不是抄本/.test(css)).toBe(true)
    expect(css.split('本插件自造的第').length - 1).toBe(5)
  })

  it('批量浮条按内容展开：width:max-content + max-width，避免左半屏收缩把按钮挤到第二行', () => {
    expect(css).toMatch(/\.sd-batch-bar\s*\{[^}]*width:\s*max-content/)
    expect(css).toMatch(/\.sd-batch-bar\s*\{[^}]*max-width:\s*calc\(100vw - 48px\)/)
  })

  it('批量浮条压在确认框下面：浮条的 z-index 必须小于模态根（否则会盖住确认按钮）', () => {
    const zIndexOf = (selector: string): number => {
      const start = css.indexOf(`${selector} {`)
      expect(start).toBeGreaterThanOrEqual(0)
      const match = /z-index:\s*(\d+)/.exec(css.slice(start))
      if (match === null) throw new Error(`${selector} 没有 z-index`)
      return Number(match[1])
    }
    expect(zIndexOf('.sd-batch-bar')).toBeLessThan(zIndexOf('.sd-modal-root'))
  })

  it('行那条描边复用选中态那枚 token，不新造颜色（设计稿 2026-10-15 §1.3）', () => {
    // 不按字面多行比：仓库里 CSS 是 CRLF，钉"选择器 + 那条 outline 用的 token"这一件事就够
    expect(css).toMatch(
      /\[data-dsh-session-delete="trash-row"\]:focus-visible\s*\{\s*outline:\s*0\.5px solid var\(--dsw-alias-button-ghost-active-border\)/,
    )
  })
})

describe('浏览器半纯度门', () => {
  it('Node 内建一律抛出', () => {
    expect(() => gateClientImport('node:fs')).toThrow(/Node 内建/)
    expect(() => gateClientImport('path')).toThrow(/Node 内建/)
  })

  it('表外的 @deepseek-ai/* 值 import 抛出——包括已经自造掉的那两个客户端包', () => {
    expect(() => gateClientImport('@deepseek-ai/dsh-client-connection')).toThrow(/平台模块表/)
    expect(() => gateClientImport('@deepseek-ai/dsh-workspace')).toThrow(/平台模块表/)
    // 自造控件的直接理由就是这条：这两个包随宿主换代而变、又不经类型检查。
    expect(() => gateClientImport('@deepseek-ai/dsh-client-ui-primitives')).toThrow(/平台模块表/)
    expect(() => gateClientImport('@deepseek-ai/dsh-client-ui-slots')).toThrow(/平台模块表/)
  })

  it('平台表内、非 @deepseek-ai 的 npm 依赖与相对路径放行', () => {
    expect(gateClientImport('react')).toBeNull()
    expect(gateClientImport('react-dom')).toBeNull()
    // 非 @deepseek-ai 的 npm 依赖由 alwaysBundle inline 进 bundle，不产生 require ⇒ 门不拦
    expect(gateClientImport('zod')).toBeNull()
    expect(gateClientImport('./delete-menu-item.js')).toBeNull()
  })
})

describe('vfile 浏览器分流（react-markdown 那条依赖链）', () => {
  // 构建期实测：CJS 输出下 rolldown 按 Node 条件解 vfile 的 `#min*` 内部请求，选中的是带
  // `node:path`/`node:url`/`node:process` 的那一支 ⇒ 纯度门先响。这里把它接回包作者自备的
  // `.browser.js`，并且**只在旁边真有那个文件时**才接。
  const dir = mkdtempSync(join(tmpdir(), 'sd-vfile-'))
  writeFileSync(join(dir, 'minpath.browser.js'), 'export const minpath = {}')
  const importer = join(dir, 'index.js')

  it('三个 # 请求接向同级的 .browser.js', () => {
    expect(resolveBrowserBranchImport('#minpath', importer)).toBe(join(dir, 'minpath.browser.js'))
    // 缺文件（换代改了名）⇒ null ⇒ 交回默认解析，让纯度门重新响，不静默放行
    expect(resolveBrowserBranchImport('#minproc', importer)).toBeNull()
    expect(resolveBrowserBranchImport('#minurl', importer)).toBeNull()
  })

  it('窄到只认这三个键：别的请求与非 vfile 的 importer 一律不接', () => {
    expect(resolveBrowserBranchImport('#fs', importer)).toBeNull()
    expect(resolveBrowserBranchImport('node:fs', importer)).toBeNull()
    expect(resolveBrowserBranchImport('#minpath', undefined)).toBeNull()
  })

  it('真装的 vfile 旁边确实有那三个浏览器实现（不是我们编的）', () => {
    const store = readdirSync(join(process.cwd(), 'node_modules', '.pnpm')).filter((n) => n.startsWith('vfile@'))
    expect(store.length).toBeGreaterThan(0)
    const lib = join(process.cwd(), 'node_modules', '.pnpm', store[0]!, 'node_modules', 'vfile', 'lib')
    for (const name of ['minpath', 'minproc', 'minurl']) {
      expect(resolveBrowserBranchImport(`#${name}`, join(lib, 'index.js'))).toBe(resolve(lib, `${name}.browser.js`))
    }
  })
})

/* ------------------------------------------------------------------ *
 * 跨插件 import 红线（AGENTS.md）——浏览器半有上面那道纯度门兜着，Node 半没有
 * ------------------------------------------------------------------ */

/** Node 半的源码：`src/` 下 `client/` 之外的每个 .ts/.tsx。 */
function nodeHalfSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return entry.name === 'client' ? [] : nodeHalfSources(join(dir, entry.name))
    }
    return /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []
  })
}

/** 某一棵子树下的每个 .ts/.tsx（浏览器半在 `src/client/`，由调用方给根）。 */
function allSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? allSources(join(dir, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  )
}

/** `from '@deepseek-ai/…'` 的 import/export 语句。**不许跨语句**：要求 `from` 之前不含引号
 *  （引号只可能出现在同一语句的模块名里），否则懒惰量词会一路吃到下一条 `from '@deepseek-ai/…'`，
 *  把整段源码当成一条语句。 */
const HOST_IMPORT_RE = /(?:import|export)(?: type)?[^;"'`]*?from (['"])@deepseek-ai\/[^'"]*\1/g

const hostImportsIn = (source: string): string[] => source.match(HOST_IMPORT_RE) ?? []
const isTypeOnly = (statement: string): boolean => /^(?:import|export) type /.test(statement)

describe('跨插件 import 红线', () => {
  // 正控：判据本身要认得出一条真违例——否则「零违例」可能只是正则什么都没匹配上。
  it('判据认得出值 import、也放得过 type import（正控）', () => {
    const bad = [
      `import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'`,
      'import {\n  Button,\n} from "@deepseek-ai/dsh-client-ui-primitives"',
    ]
    for (const statement of bad) {
      expect(hostImportsIn(statement)).toEqual([statement])
      expect(isTypeOnly(statement)).toBe(false)
    }
    expect(isTypeOnly(`import type { Context } from '@deepseek-ai/cordis'`)).toBe(true)
  })

  // AGENTS.md：跨插件一律 `import type`，值 import 是与生态的红线。这条在 **Node 半**尤其要命——
  // `tsdown.config.ts` 的纯度门只挂在浏览器半的 entry 上，Node 半的值 import 没人拦，会原样落进
  // `lib/index.js`，运行时去解析一个「与运行中的宿主不同代」的 npm 包（错了只在用户机器上炸）。
  // 判据直接从**源码**取，不依赖先跑构建。
  it('Node 半对宿主包只许 `import type` / `export type`', () => {
    const root = fileURLToPath(new URL('../src', import.meta.url))
    const files = nodeHalfSources(root)
    expect(files.length).toBeGreaterThan(0)
    const offenders = files.flatMap((file) =>
      hostImportsIn(readFileSync(file, 'utf8'))
        .filter((statement) => !isTypeOnly(statement))
        .map((statement) => `${file}: ${statement}`),
    )
    expect(offenders).toEqual([])
  })

  // 浏览器半比 Node 半更严：**一条 `@deepseek-ai/*` 的 import 都不许有，type-only 也不留**
  // （那边连类型都不从宿主包拿，全靠 `context.ts` 的本地窄镜像）。构建期那道纯度门只看得见
  // 真的解析到的 require，源码层面的越界在这里拦——这也是官方对第三方 UI 插件的要求
  // （"Do not require any Harness Client package as a module"）。
  it('浏览器半源码里没有任何 @deepseek-ai/* 的 import（值或类型都不许）', () => {
    const root = fileURLToPath(new URL('../src/client', import.meta.url))
    const files = allSources(root)
    expect(files.length).toBeGreaterThan(5)
    const offenders = files.flatMap((file) =>
      hostImportsIn(readFileSync(file, 'utf8')).map((statement) => `${file}: ${statement}`),
    )
    expect(offenders).toEqual([])
  })
})
