/**
 * The client (browser) build of `solid-js/web` has no published type path of its own; the test imports it directly so
 * the evaluated bundle gets the same client runtime the desktop window provides.
 */
declare module "solid-js/web/dist/web.js" {
  export * from "solid-js/web"
}
