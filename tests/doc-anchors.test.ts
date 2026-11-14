/**
 * 文档锚点解析器的形状契约：切分、路径解析、去注释回查、门的正控与折行/历史豁免；
 * 真实的 ADR 与 CONTEXT 契约由两个文档门自己钉。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  anchorOwnershipProblems,
  clauseOwnershipProblems,
  clauses,
  docCorpus,
  implementationText,
  ownedByPaths,
  productionText,
  resolveRepoPath,
  ROOT,
  symbolOwnedBy,
} from './support/doc-anchors.js'
import { withoutComments } from './support/comments.js'

describe('doc-anchors · 子句切分', () => {
  it('按分号切子句；路径与符号各归本子句（不跨子句继承路径）', () => {
    const parsed = clauses('锚点：`src/client/store.ts`（`useLatest` / `Store.read`）；`tests/client/use-archive-query.test.tsx` 的 `fixture`；纯散文一句')
    expect(parsed).toHaveLength(3)
    expect(parsed[0]?.paths).toEqual(['src/client/store.ts'])
    expect(parsed[0]?.symbols).toEqual(['useLatest', 'Store.read'])
    expect(parsed[1]?.paths).toEqual(['tests/client/use-archive-query.test.tsx'])
    expect(parsed[1]?.symbols).toEqual(['fixture'])
    expect(parsed[2]?.paths).toEqual([])
    expect(parsed[2]?.symbols).toEqual([])
  })

  it('文件引用不算符号；不带目录的裸文件名也不当路径（口径与两个门一致）', () => {
    const [clause] = clauses('锚点：`README.md` / `package.json` / `store.ts` 的 `Foo`')
    expect(clause?.paths).toEqual([])
    expect(clause?.symbols).toEqual(['Foo'])
  })

  it('没有锚点前缀的行也按同一套切（CONTEXT 的 `_唯一实现_` 行直接过）', () => {
    const parsed = clauses('`src/config.ts` 的 `normalizeConfig`；`apply` 的消费者说明')
    expect(parsed[0]?.paths).toEqual(['src/config.ts'])
    expect(parsed[0]?.symbols).toEqual(['normalizeConfig'])
    expect(parsed[1]?.symbols).toEqual(['apply'])
  })
})

describe('doc-anchors · 仓内路径解析', () => {
  it('仓内相对路径直接命中；`.js` 写法回落到 `.ts`', () => {
    expect(resolveRepoPath('src/client/store.ts')).toBe('src/client/store.ts')
    expect(resolveRepoPath('src/client/store.js')).toBe('src/client/store.ts')
    expect(resolveRepoPath('tests/client/use-archive-query.test.tsx')).toBe('tests/client/use-archive-query.test.tsx')
  })

  it('省掉 `src/` 的写法按仓根、`src/` 两次尝试', () => {
    expect(resolveRepoPath('trash/session-rows.js')).toBe('src/trash/session-rows.ts')
  })

  it('解析不到就交 undefined（由各门的“路径必须在场”判据决定红绿）', () => {
    expect(resolveRepoPath('src/' + 'client/renamed-away.ts')).toBeUndefined()
  })
})

describe('doc-anchors · 去注释回查', () => {
  it('去注释文本与注释词法同源（注释里的话不算实现）', () => {
    const rel = 'src/client/use-archive-detail-reader.ts'
    const stripped = implementationText(rel)
    expect(stripped).toBe(withoutComments(readFileSync(join(ROOT, rel), 'utf8')))
    expect(stripped).not.toContain('归档详情读路')
  })

  it('符号按词边界逐段回查：限定名缺一段就红，别的长标识符不能替短名顶包', () => {
    expect(symbolOwnedBy('src/client/use-archive-detail-reader.ts', 'useArchiveDetailReader')).toBe(true)
    expect(symbolOwnedBy('src/client/use-archive-detail-reader.ts', 'topLevel')).toBe(true)
    expect(symbolOwnedBy('src/client/use-archive-detail-reader.ts', 'renamedAway')).toBe(false)
    expect(symbolOwnedBy('tests/support/doc-anchors.ts', 'read')).toBe(false)
  })

  it('子句内任一路径拥有该符号即通过；路径都解析不到时交给路径门判（不重复报红）', () => {
    expect(ownedByPaths(['src/client/use-archive-detail-reader.ts'], 'useArchiveDetailReader')).toBe(true)
    expect(ownedByPaths(['src/client/store.ts', 'src/client/use-archive-detail-reader.ts'], 'useArchiveDetailReader')).toBe(true)
    expect(ownedByPaths(['src/client/store.ts'], 'useArchiveDetailReader')).toBe(false)
    expect(ownedByPaths(['src/' + 'api/request-trust.ts'], 'judgeRequest')).toBe(true)
  })

  it('生产语料覆盖 src 全部 ts/tsx 与根 .ts，且剥掉了注释', () => {
    const text = productionText()
    expect(text).toContain('export')
    // 注释里的句子不进语料（`/**` 可能出现在字符串里，不能拿它当判据）。
    expect(text).not.toContain('读路径加固设计')
    expect(symbolOwnedBy('src/client/use-gated-refresh.ts', 'useGatedRefresh')).toBe(true)
  })
})

describe('doc-anchors · 门的正控（合成负例，CI 可复跑）', () => {
  it('子句归属判据认得出假符号与缺路径', () => {
    expect(clauseOwnershipProblems('`src/client/trash-view.ts` 的 `groupByProject`')).toEqual([])
    expect(clauseOwnershipProblems('`src/client/trash-view.ts` 的 `groupByProjectRenamedAway`').length).toBeGreaterThan(0)
    expect(clauseOwnershipProblems('`groupByProject`').join('\n')).toContain('没有点名路径')
  })

  it('ADR 锚点判据认得出死符号、折行与历史豁免', () => {
    const historical = (paths: readonly string[]): boolean => paths.every((path) => path.startsWith('src/api/'))
    expect(anchorOwnershipProblems('锚点：`src/client/store.ts`（`useLatest`）', historical)).toEqual([])
    expect(anchorOwnershipProblems('锚点：`tests/docs-liveness.test.ts` 的 `RenamedAway`', historical).length).toBeGreaterThan(0)
    // 折行：ADR-FORMAT 允许锚点段折行，续行上的符号也要查。
    const folded = '锚点：`src/client/store.ts`（`useLatest`）；\n`tests/docs-liveness.test.ts` 的 `RenamedAway`'
    expect(anchorOwnershipProblems(folded, historical).length).toBeGreaterThan(0)
    expect(anchorOwnershipProblems('锚点：`src/' + 'api/request-trust.ts` 的 `judgeRequest`', historical)).toEqual([])
  })

  it('文档语料覆盖 docs/** 的 md（两门共用一份读取）', () => {
    const corpus = docCorpus()
    expect(corpus.some((doc) => doc.file === 'docs/architecture.md' && doc.lines.length > 0)).toBe(true)
    expect(corpus.some((doc) => doc.file.startsWith('docs/adr/') && doc.file.includes('0063'))).toBe(true)
  })
})
