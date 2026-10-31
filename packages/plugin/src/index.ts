/**
 * opencode-dynamic-workflows — OpenCode V2 server plugin entry.
 *
 * Authoring API: `@syn7xx/opencode-dynamic-workflows/workflow`. Protocol types and schemas: `…/protocol`. RPC contract for
 * clients: `…/rpc`. TUI plugin: `…/tui` (loaded automatically beside this entry). GUI plugin (desktop / web app):
 * `…/gui-experimental`.
 */
import { WorkflowPlugin } from "./host/plugin"

export default WorkflowPlugin
export { WorkflowPlugin }
