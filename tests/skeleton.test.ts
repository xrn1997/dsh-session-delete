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
  peerDependencies: Record<string, string>
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
  it('每个 @deepseek-ai/dsh-* peer 只开当前一代', () => {
    const peers = Object.keys(manifest.peerDependencies)
      .filter((dep) => dep.startsWith('@deepseek-ai/dsh-'))
    expect(peers.length).toBeGreaterThan(0)
    for (const dep of peers) {
      expect(manifest.peerDependencies[dep], `${dep} 的 peer 区间只能开当前一代`).toBe(HOST_GENERATION)
    }
  })

  it('dsh.client.inject 只列冻结平台模块表内的名字', () => {
    const inject = manifest.dsh.client.inject
    expect(inject).toContain('@deepseek-ai/dsh-client-ui-primitives')
    for (const dep of inject) expect(FROZEN_PLATFORM_MODULES).toContain(dep)
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
})

describe('浏览器半平台模块表', () => {
  it('就是那一代冻结表的 9 个键（不是 312 个包名的并集）', () => {
    expect([...PLATFORM_MODULES].sort()).toEqual([...FROZEN_PLATFORM_MODULES].sort())
  })
})

describe('浏览器半纯度门', () => {
  it('Node 内建一律抛出', () => {
    expect(() => gateClientImport('node:fs')).toThrow(/Node 内建/)
    expect(() => gateClientImport('path')).toThrow(/Node 内建/)
  })

  it('平台表之外的 @deepseek-ai/* 值 import 抛出', () => {
    expect(() => gateClientImport('@deepseek-ai/dsh-client-connection')).toThrow(/平台模块表/)
    expect(() => gateClientImport('@deepseek-ai/dsh-workspace')).toThrow(/平台模块表/)
  })

  it('平台表内、非 @deepseek-ai 的 npm 依赖与相对路径放行', () => {
    expect(gateClientImport('react')).toBeNull()
    expect(gateClientImport('@deepseek-ai/dsh-client-ui-primitives')).toBeNull()
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
})
