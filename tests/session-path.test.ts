/**
 * 宿主会话目录段的逐字镜像（`src/shared/session-path.ts`）。
 *
 * 这一份用例的判据不是"我们的编码自洽"，而是**与宿主的算法同形**：左边是原始 session id，
 * 右边是宿主 `dsh-session-persistence-jsonl/src/format.ts` 的 `encodeSegment` 会写出的目录名。
 * 向量逐字取自那套口径（空串抛、`.` / `..` 特判、安全字母表原样、其余码元 `~XXXX` 大写 4 位、
 * 字面 `~` 自己走转义）——拿本函数再算一遍当期望值就是同义反复，钉不住镜像。
 */
import { describe, expect, it } from 'vitest'
import { decodeSessionSegment, encodeSessionSegment } from '../src/shared/session-path.js'

/** 编码结果是**单段安全目录名**：不含分隔符 / NUL，也不可能是 `.` / `..`。 */
function isSafeSegment(value: string): boolean {
  return value !== '' && value !== '.' && value !== '..' && /^[A-Za-z0-9._~-]+$/u.test(value)
}

describe('宿主会话目录段编码', () => {
  it('安全字母表原样保留：session-<uuid> 这类常见 id 编码后与原名同形', () => {
    expect(encodeSessionSegment('session-3f2a9c1e-77b1-4a0e-9d9f-2b6c5e8a1d40'))
      .toBe('session-3f2a9c1e-77b1-4a0e-9d9f-2b6c5e8a1d40')
    expect(encodeSessionSegment('a.b_c-D9')).toBe('a.b_c-D9')
  })

  it('`.` 与 `..` 整段特判：不编成目录名就会变成上跳 / 当前目录', () => {
    expect(encodeSessionSegment('.')).toBe('~002E')
    expect(encodeSessionSegment('..')).toBe('~002E~002E')
    // 特判只认整段：`...` 全在安全字母表里，逐码元原样。
    expect(encodeSessionSegment('...')).toBe('...')
  })

  it('字面 `~` 走 else 分支：编成 ~007E，与它引导的转义序列不会撞', () => {
    expect(encodeSessionSegment('~')).toBe('~007E')
    expect(encodeSessionSegment('session-a~b')).toBe('session-a~007Eb')
    // 已经长得像转义序列的原文同样要再转义一次（编码是单射，不是"看着像就放过"）。
    expect(encodeSessionSegment('a~007Eb')).toBe('a~007E007Eb')
  })

  it('分隔符 / NUL / 空白：编成码元十六进制（大写 4 位）', () => {
    expect(encodeSessionSegment('a/b')).toBe('a~002Fb')
    expect(encodeSessionSegment('a\\b')).toBe('a~005Cb')
    expect(encodeSessionSegment('C:/x')).toBe('C~003A~002Fx')
    expect(encodeSessionSegment('a\0b')).toBe('a~0000b')
    expect(encodeSessionSegment('a b')).toBe('a~0020b')
    expect(encodeSessionSegment('a\tb')).toBe('a~0009b')
  })

  it('非 ASCII 按 UTF-16 码元编：中文 / emoji / 孤立代理项都不改身份', () => {
    expect(encodeSessionSegment('会话')).toBe('~4F1A~8BDD')
    expect(encodeSessionSegment('会话 A~')).toBe('~4F1A~8BDD~0020A~007E')
    // emoji 是一个代理对 ⇒ 两个码元、两段转义；孤立代理项（JSON 里能出现）照样往返，
    // 这正是宿主按码元而不是码点处理的那一条。
    expect(encodeSessionSegment('😀')).toBe('~D83D~DE00')
    expect(encodeSessionSegment('\uD800')).toBe('~D800')
  })

  it('空串抛：宿主的 encodeSegment 没有"空目录段"这种产物', () => {
    expect(() => encodeSessionSegment('')).toThrow(/不能为空/u)
  })

  it('编码结果一律是单段安全目录名（不会把递归删除带出 sessions/）', () => {
    for (const raw of [
      'session-abc', '.', '..', '...', '~/../etc', 'a b', '会话', '😀', '\uD800',
      'a/b', 'a\\b', 'C:\\x', 'a\0b', '',
    ]) {
      if (raw === '') continue
      const encoded = encodeSessionSegment(raw)
      expect(isSafeSegment(encoded), `${JSON.stringify(raw)} → ${JSON.stringify(encoded)}`).toBe(true)
    }
  })

  it('反解是编码的逆：含 `~XXXX` 样文本、`.` / `..`、代理项都逐码元还原', () => {
    for (const raw of [
      'session-abc', 'a.b_c-D9', '.', '..', '...', '~', 'a~007Eb', 'a/b', 'a\\b',
      '会话 A~', '😀', '\uD800', 'a~007E007Eb',
    ]) {
      expect(decodeSessionSegment(encodeSessionSegment(raw)), raw).toBe(raw)
    }
    // 旧条目 / 手改目录里的非编码串原样交回（解不出的不是错误，也不是"删掉"的理由）。
    expect(decodeSessionSegment('session-plain')).toBe('session-plain')
    expect(decodeSessionSegment('a~ZZZZb')).toBe('a~ZZZZb')
  })
})