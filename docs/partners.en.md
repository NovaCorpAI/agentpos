# Partner guide: installing AgentPOS on a client's store

For agencies, freelancers and integrators who maintain other people's stores. This is what you
need to leave a store selling to agents without us in the room, what to hand over to the
merchant, and the rules that are not negotiable.

Related: [merchant quickstart](quickstart-merchant.en.md) ·
[step by step assisted guide](onboarding.en.md) · [operations](operations.en.md) ·
[what is open and what is a service](open-core.en.md) ·
In Spanish: [partners.es.md](partners.es.md)

## Why this exists

A merchant has one store. You have twenty. You are the only place in this market where
installing once is worth many times, and you arrive with the trust already built: the merchant
does not know us, but they have known you for years.

## What you charge and what we charge

- **You charge for the setup, at your own price.** We publish US$99 as a reference; your market
  is yours and we take no cut.
- **We charge for the operated service**, US$19 per store per month, and you can take part in
  two ways: a discounted resale price (you invoice the merchant) or a recurring referral fee, paid
  for as long as the store stays active and you remain its first line of support (we invoice
  them and transfer to you in USDC). The current figures live in the programme email, because they are still a
  draft.
- **Never a percentage of the merchant's sale**, neither yours nor ours. A partner fee comes out
  of our own fee.

## The certified install, step by step

The technical detail is in the [assisted guide](onboarding.en.md). What follows is what makes it
a _certified_ install, which is what we ask before listing you as a partner.

### Before the call with your client

1. Confirm the store runs **WooCommerce over HTTPS** and that you can create a REST key.
2. Confirm where the sidecar will run: a Node process next to the store, a container, or **run
   by us** when the hosting is shared and allows no processes of its own.
3. Ask for the **public address** of the merchant's Stellar wallet (`G...` or `C...`). If they
   have none, create it during the call, with the merchant in control.
4. Get the **facilitator API key** for the right network.

> **A rule that is not negotiable:** never ask for or accept the merchant's private key. If a
> step seems to need it, something is wrong: stop and write to us.

### During the call (about two hours)

- [ ] Sidecar running and answering on the merchant's domain.
- [ ] Catalogue scanned and **confirmed by the merchant, item by item and price by price**. This
      is not your call: the USDC price is always confirmed by the human who owns the store.
- [ ] Wallet linked with proof of control, public address only.
- [ ] Proxy rule published, and the new routes answering (`/.well-known/ucp`,
      `/agentpos/catalog`, `/openapi.json`, `/llms.txt`).
- [ ] **One real end to end test purchase**, with its transaction hash and the order visible in
      the merchant's own WooCommerce admin.
- [ ] Panel key handed to the merchant, and verified that without it nobody reads their orders.

### What you hand over

1. A one page written summary: what was installed, where it runs, which routes were added and
   how to switch it off.
2. The hash of the test purchase, so they can look it up in the explorer themselves.
3. Who answers what: you for their store, us for the product.

## Keeping it running

- New version notices arrive in the panel. **Keeping your merchants' AgentPOS up to date is part
  of the deal.**
- When an order gets stuck, the panel says so. The [operations guide](operations.en.md) explains
  every state and how to clear it.
- If the failure is ours (a bug in our code or a service of ours that is down), we fix it free
  and with no time limit, on any plan. Write to us, that is all.

## What we require from a partner

1. One real installation running before you are listed as an installer.
2. Keeping your merchants' AgentPOS up to date.
3. Never asking for a private key.
4. That the merchant owns everything: their wallet, their data, their account. If they change
   agency, they take the store with them, working, without asking us or migrating anything.

## What you cannot do with our infrastructure

- Charge the merchant a percentage of their sales using AgentPOS. Our fee is flat and the
  product gives you no tool to take a cut of each sale.
- Publish a merchant's catalogue without their explicit confirmation.
- Withhold a merchant's access to their own store or their own wallet.

## How to join

The form is at <https://agentposhq.com/en/pricing#partners>: pick **I install for others** and
tell us how many stores you maintain and on which platform. The first partners we walk through
by hand, with the first installation done together.
