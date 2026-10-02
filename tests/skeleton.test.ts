import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PLATFORM_MODULES, gateClientImport } from '../tsdown.config.js'
import * as plugin from '../src/index.js'

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as {
  name: string
  exports: Record<string, unknown>
  files: string[]
  icon: string
  peerDependencies: Record<string, string>
  publishConfig: { access?: string }
  repository: { url?: string }
  scripts: Record<string, string>
  dsh: {
    bundle: { patch: string }
    client: { inject: string[]; platform: string }
    compatibility: { dshReleases: Record<string, string> }
  }
}

/** 本插件只声明兼容的一代宿主（实测于 desktop 0.2.0-rc.2）。 */
const HOST_GENERATION = '0.2.0-rc.2'

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

  // 真加了的话只能开当前这一代：peer 区间在 semver 预发布规则下没有"免维护写法"。
  it('若将来确要声明 dsh* peer，区间只能是实测过的那一代（正控）', () => {
    const declared = Object.entries(manifest.peerDependencies).filter(([dep]) =>
      dep.startsWith('@deepseek-ai/dsh-'),
    )
    for (const [dep, range] of declared) {
      expect(range, `${dep} 的 peer 区间只能开当前一代`).toBe(HOST_GENERATION)
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

  it('dshReleases 只写状态词 compatible，且当前一代在册', () => {
    const releases = manifest.dsh.compatibility.dshReleases
    expect(releases[HOST_GENERATION]).toBe('compatible')
    for (const status of Object.values(releases)) expect(status).toBe('compatible')
  })

  it('两条半产物的入口在 manifest 里声明齐全', () => {
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.exports['./client']).toBe('./lib/client.js')
  })

  /* ── npm 发布面（缺哪一条，`npm publish` 不是失败就是发出去一个坏包） ── */

  it('scoped 包必须显式声明公开访问，否则首次 publish 被当成私有包拒绝', () => {
    expect(manifest.publishConfig.access).toBe('public')
  })

  it('发布即构建：prepack 里跑 build（lib/ 是构建产物、不入库）', () => {
    // `prepack` 在 `npm pack` / `pnpm pack` / `npm|pnpm publish` 四条路上都会跑，
    // 所以"手滑直接 publish 出一个空的 lib/"这件事不可能发生。
    expect(manifest.scripts.prepack).toBe('npm run build')
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
