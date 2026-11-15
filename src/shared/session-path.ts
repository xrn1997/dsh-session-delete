/**
 * 宿主会话目录的**段编码**：`sessionId` → `sessions/<projectDir>/<段>` 里那一段。
 *
 * 这是宿主 `@deepseek-ai/dsh-session-persistence-jsonl` 的 `encodeSegment` 的逐字镜像（出处：asar 里
 * `dsh-session-persistence-jsonl/src/format.ts`；同一文件的 `sessionDir` 就是它的调用点）。跨插件不能
 * import 宿主源码，宿主也没把它暴露成服务，所以这一份是**镜像**而不是共享实现——宿主换代先复核算法。
 *
 * 为什么必须镜像：`SessionId` 是宿主未校验的品牌字符串，宿主在**任何文件系统调用之前**把它编成一段
 * 安全目录名；本插件按 `sessions/<projectDir>/<段>` 找同一个目录（删除搬走、恢复放回、计划量字节）。
 * 原始 id 拼路径在常见 id 上恰好同形（`session-<uuid>` 整段都在安全字母表里），一旦 id 含 `~`、空格或
 * 非 ASCII 就会指向一个不存在的目录——删除报 not-found、计划量 0 字节，而那条会话其实还在盘上。
 *
 * 口径（与宿主逐字一致，不是口味）：
 * - **空串抛**（宿主原话 `cannot encode an empty path segment`）：没有"空段"这种目录名；
 * - 整段恰为 `.` / `..` 的**特判**先于逐码元循环：编成 `~002E` / `~002E~002E`，否则目录名会变成上跳；
 * - `[A-Za-z0-9._-]` 码元原样保留；其余每个码元（**包括字面 `~` 自己**）编成 `~` + 4 位大写十六进制
 *   ⇒ `~XXXX` 无歧义（字面 `~` 是 `~007E`），且编码可逆；
 * - 按 **UTF-16 码元**（不是码点）处理：孤立代理项也能原样往返——宿主的 `SessionId` 不做码点校验。
 *
 * **唯一调用点归 `src/trash/entry.ts`**：`sessionDirForId` / `sessionDirSegmentOf` 是仓内构造宿主会话
 * 目录的两个口（路径与"写进条目 id 的段"），其余文件只消费**已编码段**——恢复照条目 id 里记下的段回放，
 * 不拿 `sessionId` 再编一遍。
 *
 * **反解只给"目录是唯一线索"的两处**：对账重建（header 没有 `id` 时拿目录段反推会话 id）与投影缓存
 * 的目录名保护（清册行缺失时按目录保护缓存）。恢复**不用**它：条目 id 里记着的段直接接回项目目录，
 * 多一次编解码只会多一个会漂的判据。
 */
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

/** {@link encodeSessionSegment} 的逆：把 `~XXXX` 还原成 UTF-16 码元。
 *  编码是单射且字面 `~` 自己也编成 `~007E`，所以"每个 `~` + 4 位大写十六进制"都一定是转义。
 *  **已知歧义（刻意接受）**：编码前写下的存量条目 id 第二段是原始 session id，若它本身恰好含
 *  `a~007Eb` 这类文本，反解无法与编码产物区分——但编码前的删除只可能发生在**全安全字符**的 id 上
 *  （含 `~` 的 id 当时根本找不到目录），所以真实存量里不会出现这种段；手改目录是唯一来源，按反解
 *  结果处理并接受误判。不含 `~XXXX` 形态的旧条目原样交回。 */
export function decodeSessionSegment(encoded: string): string {
  return encoded.replace(/~([0-9A-F]{4})/g, (_whole, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}