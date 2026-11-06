/**
 * 插件设置页两张卡共用的**视图词汇**：卡片外壳配方。
 *
 * 与 `trash-view.ts` 同一个理由：两张卡共用宽度、内距与底色，只有内容节奏（`gap`）不同——各写一份
 * 就会一张改了另一张没改。按内容高、铺满宿主给的宽度，不假设自己住在中央面板里（没有 `height:100%`）。
 */
import type { CSSProperties } from 'react'
import { CARD } from './trash-view.js'

/** 设置页卡片外壳：`gap` 是这一张卡自己的内容节奏，其余两张贴一样。 */
export const settingsCardShell = (gap: number): CSSProperties => ({
  ...CARD,
  flexDirection: 'column',
  alignItems: 'stretch',
  gap,
  width: '100%',
  boxSizing: 'border-box',
  padding: '14px 16px',
})
