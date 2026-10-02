/**
 * `.css` 在**浏览器半**的构建里被当成「一段字符串」导入（`ui.css` → `ui/styles.ts` 注入 `<style>`）。
 * 这份声明只服务于类型检查：运行时由 `tsdown.config.ts` 的 `dsh-session-delete-css-text` 插件
 * 把文件内容变成 `export default "<CSS 文本>"`。
 *
 * **Node 半不 import 任何 `.css`**：那条构建里没有这个插件，导入了会在构建期报解析失败——
 * 这正是我们想要的（样式只属于浏览器半）。
 */
declare module '*.css' {
  const text: string
  export default text
}
