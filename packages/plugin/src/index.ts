/**
 * opencode-workflows — OpenCode V2 server plugin entry.
 *
 * Authoring API: `@syn7xx/opencode-workflows-plugin/workflow`. Protocol types and schemas: `…/protocol`. RPC contract for
 * clients: `…/rpc`. TUI plugin: `…/tui` (loaded automatically beside this entry).
 */
import { WorkflowPlugin } from "./host/plugin"

export default WorkflowPlugin
export { WorkflowPlugin }
