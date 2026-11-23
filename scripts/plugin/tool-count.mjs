// Single source of truth for the packaged MCP tool count.
// `plugin:smoke` cross-checks this against the registerTool calls in
// plugins/modcrafting-fabric/src/mcp-server.ts, so adding or removing a tool
// fails loudly here instead of silently breaking host smoke assertions.
export const EXPECTED_TOOL_COUNT = 43
