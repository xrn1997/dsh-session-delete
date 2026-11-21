/** 宿主 `projectKey(cwd)` 的编码与解码一对：字母表、转义与包裹规则只住这一份。
 *  编码是宿主实现的逐字镜像（出处 asar `dsh-session-persistence-jsonl/lib/index.js` 的 `projectKey`），
 *  宿主换代先复核算法。唯一有意偏离：宿主对空串直接抛，这里编成 `--root--` 兜底坏 header。
 *  解码只还原 `~XXXX`；分隔符折成的 `-` 有损，别拿它反推真实路径。 */

/** 无 cwd 的会话落在 `_no-cwd/`（宿主 `projectDir` 原文）；两半共用这一份。 */
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
