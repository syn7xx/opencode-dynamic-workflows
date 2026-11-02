import { GlobalRegistrator } from "@happy-dom/global-registrator"

// The GUI bundle hoists Solid's template creation to module scope, so evaluating it needs a DOM. The OpenCode host
// runs the bundle in a real browser window; a test evaluates it against a registered happy-dom window instead. This
// is the same approach OpenCode's own GUI plugins use (`packages/gui-plugins/happydom.ts`).
GlobalRegistrator.register()
