import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// vitest 没开 `globals`，@testing-library/react 的自动 cleanup 挂不上 ⇒ 显式收尾，
// 否则上一个用例的 DOM 会留在 document 里，下一个用例报 "Found multiple elements"。
afterEach(() => {
  cleanup()
})
