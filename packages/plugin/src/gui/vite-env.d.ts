/**
 * Ambient types for the GUI bundle: Vite's `?inline` CSS imports resolve to the file's text, which the plugin
 * contributes through `ctx.add(Style, css)`.
 */
declare module "*.css?inline" {
  const css: string
  export default css
}
