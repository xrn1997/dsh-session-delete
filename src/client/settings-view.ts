/** 设置页两张卡共用的卡片外壳：宽度、内距与底色同源，只有内容节奏（`gap`）各自给；不假设住在中央面板。 */
import type { CSSProperties } from 'react'
import { CARD } from './trash-view.js'

export const settingsCardShell = (gap: number): CSSProperties => ({
  ...CARD,
  flexDirection: 'column',
  alignItems: 'stretch',
  gap,
  width: '100%',
  boxSizing: 'border-box',
  padding: '14px 16px',
})
