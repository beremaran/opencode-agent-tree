import type { V2Plugin } from "./index.ts"
import legacyPlugin from "./index.ts"

const plugin = legacyPlugin as typeof legacyPlugin & { readonly v2?: V2Plugin }
const v2Plugin = plugin.v2

if (!v2Plugin) {
  throw new Error("@beremaran/opencode-agent-tree: OpenCode 2 adapter is unavailable")
}

export default v2Plugin as V2Plugin
