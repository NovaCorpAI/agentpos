#!/usr/bin/env node
// `npx agentpos` is the command merchants see in the docs. The CLI itself lives in
// @agentpos/site; this package only exists so the unscoped name resolves to it.
await import("@agentpos/site/bin/agentpos.js");
