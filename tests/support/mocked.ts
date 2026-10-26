import type { Mock } from 'vitest'

/** 把端口上的每个方法换成 `vi.fn`（保参数与返回值类型——强转换不来这一点）。
 *  成员**可写**：用例经常"翻一格"（`host.isLive = vi.fn(...)`）来表达"这一条在跑"，那是假件
 *  interface 的一部分，不该逼人绕回强转。 */
export type Mocked<T> = {
  -readonly [K in keyof T]: T[K] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : never
}
