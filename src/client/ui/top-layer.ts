/**
 * 「谁在最上层收 Escape」的名单与判据。`Modal` 的关闭键和清单的 Esc 退下钻共用这一份：
 * 两份各写一次选择器，菜单/对话框换代时必然只剩一处跟上。
 *
 * 名单与官方 `modalSelector` 同形：模态对话框 + 菜单。文档序里最后一个是「最上层」。
 */

/** 对话框与菜单同一张名单。 */
const TOP_LAYER = '[role="dialog"][aria-modal="true"], [role="menu"]'

/** 文档里是否还有打开的顶层浮层。清单只问「有没有」，它自己不是其中一员。 */
export function hasTopLayer(doc: Document): boolean {
  return doc.querySelector(TOP_LAYER) !== null
}

/** 自己是不是文档里最上面的那一层。Modal 只在这时收 Escape。 */
export function isTopLayer(element: HTMLElement): boolean {
  const layers = element.ownerDocument.querySelectorAll(TOP_LAYER)
  return layers.length > 0 && layers[layers.length - 1] === element
}
