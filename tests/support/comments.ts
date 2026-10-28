/**
 * 注释词法（两道守卫共用一份）：扫出真注释的区间，顺带交出「只剩代码与串」的基线。
 *
 * 字符串态里绝不产注释：glob 串里「双星号夹一对斜杠星号」那种形态自己就是一个合法的块注释，
 * 按正则去找起头就会把中间的真代码当注释吞掉（配置文件的 include 与 exclude 挨着写就是这个形状）；
 * 而反过来剥掉字符串又会把注释里的反引号锚一起剥没，两边的证据都没了。
 *
 * **正则字面量整体跳过**：字符类里带反引号的指针正则会把字符串态带偏——后续模板串的开头反引号被当成
 * 串结束，串体按代码往下扫，其中的 glob 字面量又被当成块注释起头，整段真代码冒充注释体。
 * `/` 前面那个字符判起头：除法前面几乎总是操作数、`)` 或 `]`，不在集合里就当除法逐字放过。
 * 宁可漏认：漏认只退回逐字扫（与不开这档时同形），认错开档才会吞掉后面的真注释。
 */

export interface CommentToken {
  /** 含定界符的注释原文 */
  text: string
  /** 起始下标（指向第一个斜杠） */
  start: number
  /** 结束下标（不含）：块注释在闭头之后，行注释停在换行前 */
  end: number
}

const REGEX_START = new Set(['', '\n', '=', '(', '[', ',', '!', '&', '|', '?', ':', '{', '}', ';',
  '+', '-', '*', '%', '~', '^', '<', '>'])

export function scanComments(text: string): CommentToken[] {
  const out: CommentToken[] = []
  let i = 0
  let prev = ''
  while (i < text.length) {
    const two = text.slice(i, i + 2)
    if (two === '//') {
      const stop = text.indexOf('\n', i)
      const at = stop === -1 ? text.length : stop
      out.push({ text: text.slice(i, at), start: i, end: at })
      i = at + 1
      prev = '\n'
    } else if (two === '/*') {
      const stop = text.indexOf('*/', i + 2)
      const at = stop === -1 ? text.length : stop + 2
      out.push({ text: text.slice(i, at), start: i, end: at })
      i = at
      prev = '/'
    } else if (text[i] === "'" || text[i] === '"' || text[i] === '`') {
      const quote = text[i]
      i++
      while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1
      i++
      prev = quote
    } else if (text[i] === '/' && REGEX_START.has(prev)) {
      i++ // 进正则体
      let inClass = false
      while (i < text.length && text[i] !== '\n') {
        if (text[i] === '\\') { i += 2; continue }
        if (text[i] === '[') inClass = true
        else if (text[i] === ']') inClass = false
        else if (text[i] === '/' && !inClass) { i++; break }
        i++
      }
      while (i < text.length && /[a-z]/i.test(text[i])) i++ // 正则 flag
      prev = '/'
    } else {
      if (text[i] === '\n') prev = '\n'
      else if (!/\s/.test(text[i])) prev = text[i]
      i++
    }
  }
  return out
}

/** 注释原文（抄写比对只看这些）。 */
export const commentBodies = (text: string): string[] => scanComments(text).map((token) => token.text)

/** 注释换成等长空格，代码与字符串照旧留着——长度不变，所以逐个替换时偏移不会错位。 */
export function withoutComments(text: string): string {
  let out = text
  for (const { start, end } of scanComments(text)) {
    out = out.slice(0, start) + ' '.repeat(end - start) + out.slice(end)
  }
  return out
}
