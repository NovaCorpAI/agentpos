#!/usr/bin/env node
// `npx agentpos-buyer` is the command buyers see in the docs. The CLI itself lives in
// @agentpos/mcp-buyer; this package only exists so the unscoped name resolves to it.
await import("@agentpos/mcp-buyer/bin/agentpos-buyer.js");
