/** 宿主会话目录的**段编码**：`sessionId` → `sessions/<projectDir>/<段>` 里那一段。
 *  这是宿主 `encodeSegment` 的逐字镜像（出处 asar `dsh-session-persistence-jsonl/src/format.ts`），
 *  跨插件不能 import，宿主换代先复核算法；原始 id 拼路径只在常见 id 上同形，含 `~`、空格或非 ASCII
 *  就会指向一个不存在的目录。
 *  口径与宿主逐字一致：空串抛、整段 `.`/`..` 特判、安全字符原样、其余（含字面 `~`）编成 `~XXXX`；
 *  按 UTF-16 码元处理。**唯一调用点归 `src/trash/entry.ts`**；反解只给对账重建与投影缓存目录名保护。 */
export function encodeSessionSegment(raw: string): string {
  if (raw.length === 0) throw new Error('会话目录段不能为空：宿主 encodeSegment 对空串直接抛')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** {@link encodeSessionSegment} 的逆：每个 `~` + 4 位大写十六进制都一定是转义。
 *  手改目录留下的 `a~007Eb` 这类文本会误判，刻意接受。 */
export function decodeSessionSegment(encoded: string): string {
  return encoded.replace(/~([0-9A-F]{4})/g, (_whole, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}