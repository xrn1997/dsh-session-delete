/**
 * 宿主 `projectKey(cwd)` 的**编码与解码一对**：字母表、转义与包裹规则只住这一份。
 *
 * - 编码是宿主实现的逐字镜像（跨插件不能 import，宿主也没把它暴露成服务）。出处：asar
 *   `dsh-session-persistence-jsonl/lib/index.js` 的 `projectKey`；调用链
 *   `locate` → `logPath` → `projectDir` → `projectKey`。本机实测
 *   `D:/develop/GitHub/dsh-session-delete` → `--D-develop-GitHub-dsh-session-delete--`。
 *   宿主换代先复核算法。
 *   唯一有意偏离：宿主对空串直接抛（`cannot encode an empty project path`），这里把它编成
 *   `--root--`——宿主写日志时不会产生空 cwd，读面碰到的是手工改过的 header；这里只做兜底，
 *   不让一条坏 header 把整次对账/列表读挂掉。
 * - 解码给浏览器半渲染回收站组头用；配对关系由 `tests/assembly.test.ts` 的往返用例钉住。
 * - **空串照常编码**（得到 `--root--`）：`''` 不是"没有这格"，它是读到了一个空路径。只有
 *   **缺席** cwd 才落 `NO_CWD_PROJECT_DIR`，那一条判据住 `src/ports/host-port.ts` 的 `projectDirOfCwd`
 *   （删除计划、列表投影与对账重建共用同一处）。宿主的 `projectDir` 在 cwd 缺席时用同名目录，
 *   浏览器半渲染组头时也要认它——所以字面量住这里，两半共用。宿主换代先复核算法。
 *
 * **只还原可还原的那部分**：不在 `[A-Za-z0-9._-]` 里、又不是 `~` 的字符编成 `~` + 4 位大写十六进制
 * 码元，字面 `~` 自己编成 `~007E` ⇒ `~XXXX` 不含歧义。而**分隔符（`/` `\` `:`）被折成一个 `-`，
 * 那一段是有损的**，解码还原不回来——调用方按"尽力显示"用它，别拿它反推真实路径。
 */

/** 无 cwd 的会话落在 `_no-cwd/`（宿主 `projectDir` 原文：`if (cwd === void 0) return join(root, "_no-cwd");`）。
 *  Node 半用它合成目录名，浏览器半用它把组头念成「未记录项目」——同一事实只有这一份。 */
export const NO_CWD_PROJECT_DIR = '_no-cwd'

/** cwd → 项目目录名（宿主 `projectKey` 的逐字镜像）。 */
export function escapeProjectKey(cwd: string): string {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** 项目目录名 → 可读文本（只还原 `~XXXX`，分隔符折叠的那一段不还原）。 */
export function unescapeProjectKey(encoded: string): string {
  return encoded.replace(
    /~([0-9A-F]{4})/g,
    (_whole, hex: string) => String.fromCharCode(parseInt(hex, 16)),
  )
}
