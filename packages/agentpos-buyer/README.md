# agentpos-buyer

The `agentpos-buyer` command line, as an unscoped package so that `npx agentpos-buyer` works.

```bash
npx agentpos-buyer demo https://demo.agentposhq.com --dry-run   # discover, quote, no wallet needed
npx agentpos-buyer serve                                         # MCP server for your agent
```

Everything is implemented in
[`@agentpos/mcp-buyer`](https://www.npmjs.com/package/@agentpos/mcp-buyer); this package
re-exports its binary and nothing else. Install either one.

Apache-2.0. Source and docs: <https://github.com/NovaCorpAI/agentpos>.
