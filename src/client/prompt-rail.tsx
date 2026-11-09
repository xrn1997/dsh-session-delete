/**
 * 详情右缘的提问轨：一句用户提问一格，常驻、零开合——点一格跳到那句，悬停 / 键盘聚焦出预览卡。
 *
 * 为什么不是列表或弹层：正文旁的导航件一旦要开合，读者就多出「打开、找、关」两步；宿主的轮次轨
 * 已经证明「贴边常驻 + 悬停预览 + 点一下」是长会话里操作最少的那一种（ADR-0057）。轨只画：
 * 当前哪句、补页与落位归 `use-prompt-rail`。
 *
 * 几何：`position: absolute` 贴在详情正文栏的右槽里（判据住 `layout.css` 的 `.sd-prompt-rail`），
 * 不占正文布局；预览卡在轨左侧、跟那一格竖直居中，`pointer-events: none` 不挡点击。
 * **右缘从哪算由调用方给**（`right`）：那是正文列宽的函数，面板手上有那一格；样式表里写死一个
 * 列宽就是第二份 860，迟早与 `DETAIL_TEXT_MAX_WIDTH` 漂开。轨宽只有 `RAIL_WIDTH` 一个来源（这里），
 * 行内交给 nav；面板的右槽 `RAIL_GUTTER` 从它派生，样式表不写第二份。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { absoluteText, type Translate } from './copy.js'
import type { PromptRailNotice } from './use-prompt-rail.js'
import type { TrashDetailPromptWire } from '../shared/wire.js'

/** 轨宽（px）：刻度与焦点环都按它排；面板的右槽宽度从它派生（`RAIL_GUTTER`）。 */
export const RAIL_WIDTH = 30

export interface PromptRailProps {
  readonly prompts: readonly TrashDetailPromptWire[]
  /** 已加载的块 id：未加载的刻度更短更淡，预览卡里也明说「会先补页」。 */
  readonly loadedIds: ReadonlySet<string>
  readonly activeId: string | null
  readonly busyId: string | null
  /** 跳转收手时的说明（目前只有「太远」一种）。 */
  readonly notice: PromptRailNotice | null
  readonly onJump: (id: string) => void
  /** 右缘的定位表达式（`max(14px, calc(100% - <正文列宽>px))`）：由面板从 `DETAIL_TEXT_MAX_WIDTH`
   *  算好交进来，样式表不重抄列宽。 */
  readonly right: string
  /** 详情保持期：轨跟着上一条的帧一起顶住，但整条不可交互（不把人补到别人的游标上）。 */
  readonly disabled?: boolean
  readonly t: Translate
}

interface PeekState {
  readonly id: string
  /** 相对轨顶的竖直位置（那一格的中心）。 */
  readonly top: number
}

export function PromptRail({ prompts, loadedIds, activeId, busyId, notice, onJump, right, disabled = false, t }: PromptRailProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [peek, setPeek] = useState<PeekState | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const indexes = useMemo(() => new Map(prompts.map((prompt, index) => [prompt.id, index])), [prompts])
  const activeIndex = activeId === null ? -1 : indexes.get(activeId) ?? -1
  const focusIndex = focusId === null ? -1 : indexes.get(focusId) ?? -1
  /** 罗盘只有一个可 Tab 停的点：当前那句（没有就第一句）；方向键在轨内移动焦点。 */
  const tabIndex = focusIndex >= 0 ? focusIndex : Math.max(0, activeIndex)

  // 当前那句跟着正文走：只动轨内的滚动，不把整页带着滚。
  useEffect(() => {
    const inner = scrollRef.current
    if (inner === null || activeId === null) return
    const mark = inner.querySelector<HTMLElement>(`[data-prompt-id="${activeId}"]`)
    if (mark === null) return
    const top = mark.offsetTop
    const bottom = top + mark.offsetHeight
    if (top < inner.scrollTop) inner.scrollTop = top
    else if (inner.clientHeight > 0 && bottom > inner.scrollTop + inner.clientHeight) {
      inner.scrollTop = bottom - inner.clientHeight
    }
  }, [activeId])

  /** 预览卡的位置取那一格的屏幕中线（相对轨的顶）：轨内自己滚动时也不会歪。 */
  const showPeek = useCallback((id: string, element: HTMLElement | null): void => {
    if (disabled) {
      setPeek(null)
      return
    }
    const nav = element?.closest('.sd-prompt-rail')
    if (element === null || nav === null || nav === undefined) {
      setPeek(null)
      return
    }
    const rect = element.getBoundingClientRect()
    setPeek({ id, top: rect.top - nav.getBoundingClientRect().top + rect.height / 2 })
  }, [disabled])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return
    const from = focusIndex >= 0 ? focusIndex : Math.max(0, activeIndex)
    let next: number | null = null
    if (event.key === 'ArrowDown') next = Math.min(prompts.length - 1, from + 1)
    else if (event.key === 'ArrowUp') next = Math.max(0, from - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = prompts.length - 1
    if (next === null) return
    event.preventDefault()
    const mark = scrollRef.current?.querySelector<HTMLElement>(`[data-prompt-id="${prompts[next]?.id ?? ''}"]`)
    mark?.focus()
  }

  if (prompts.length === 0) return null
  const peeked = peek === null ? undefined : prompts.find((prompt) => prompt.id === peek.id)
  const peekedIndex = peeked === undefined ? -1 : indexes.get(peeked.id) ?? -1

  return (
    <nav
      className="sd-prompt-rail"
      style={{ right, width: RAIL_WIDTH }}
      aria-label={t('detail.rail.label')}
      data-disabled={disabled ? 'true' : undefined}
      {...(disabled ? { inert: '' } : {})}
      onPointerLeave={() => { setPeek(null) }}
    >
      <div className="sd-prompt-rail-scroll" ref={scrollRef} role="group" onKeyDown={onKeyDown}>
        {prompts.map((prompt, index) => {
          const loaded = loadedIds.has(prompt.id)
          return (
            <button
              key={prompt.id}
              type="button"
              className="sd-prompt-mark"
              data-prompt-id={prompt.id}
              data-loaded={loaded ? undefined : 'false'}
              data-loading={prompt.id === busyId ? 'true' : undefined}
              aria-current={prompt.id === activeId ? 'true' : undefined}
              aria-busy={prompt.id === busyId ? 'true' : undefined}
              disabled={disabled}
              aria-label={prompt.preview === ''
                ? t('detail.rail.jumpUntitled', { n: index + 1 })
                : t('detail.rail.jump', { n: index + 1, preview: prompt.preview })}
              tabIndex={index === tabIndex ? 0 : -1}
              onPointerEnter={(event) => { showPeek(prompt.id, event.currentTarget) }}
              onFocus={(event) => {
                setFocusId(prompt.id)
                showPeek(prompt.id, event.currentTarget)
              }}
              onBlur={() => {
                setFocusId(null)
                setPeek(null)
              }}
              onClick={() => {
                if (disabled) return
                // 点下去就是"去看那句"：预览卡先收掉，别让它盖住刚落位的正文。
                setPeek(null)
                onJump(prompt.id)
              }}
            />
          )
        })}
      </div>
      {peeked === undefined || peek === null ? null : (
        <div className="sd-prompt-peek" style={{ top: peek.top }} aria-hidden="true">
          <div className="sd-prompt-peek-top">
            <span>{t('detail.rail.position', { n: peekedIndex + 1, total: prompts.length })}</span>
            <span>{absoluteText(peeked.at)}</span>
          </div>
          {peeked.preview === '' ? null : <div className="sd-prompt-peek-text">{peeked.preview}</div>}
          <div className="sd-prompt-peek-hint">
            {t(loadedIds.has(peeked.id) ? 'detail.rail.hint' : 'detail.rail.hintPending')}
          </div>
        </div>
      )}
      {notice === null ? null : <div className="sd-prompt-rail-notice" role="status">{t('detail.rail.tooFar')}</div>}
    </nav>
  )
}
