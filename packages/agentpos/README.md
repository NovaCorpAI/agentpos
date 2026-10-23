# agentpos

The `agentpos` command line, as an unscoped package so that `npx agentpos` works.

```bash
npx agentpos init      # config + wallet link (public address only, never keys)
npx agentpos scan      # reads YOUR site and proposes a catalog; nothing is published
npx agentpos confirm   # you review every item and set every price
npx agentpos publish   # verifies the payment rail, exposes the catalog
npx agentpos serve     # sidecar on :8402; your store now sells to agents
```

Everything is implemented in [`@agentpos/site`](https://www.npmjs.com/package/@agentpos/site);
this package re-exports its binary and nothing else. Install either one.

Apache-2.0. Source and docs: <https://github.com/NovaCorpAI/agentpos>.
