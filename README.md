# mcp-unifi

Connect UniFi to Claude, Claude Code, Cursor or any MCP client. No install, no local
runtime, no VPN into client networks. It runs as a Cloudflare Worker and talks to your
consoles through the UniFi Site Manager and its Cloud Connector proxy.

The point of difference: this manages a **fleet**, not a single controller. Ask it where
your sites disagree with your standard, rather than asking it about one gateway at a time.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jason-mspkickstart/mcp-unifi)

## Two things that will otherwise cost you an hour

**Set connector Authentication to None, and send your credential as `x-api-key`.** Claude's
connector UI greys out the `authorization` header because it reserves it for OAuth. If you
pick any authentication mode other than None you will be sent into a sign-in flow that does
not exist here.

**The response cache does nothing on a `workers.dev` subdomain.** Cloudflare's Cache API
silently no-ops there: every write appears to succeed and every read misses. Put the Worker
on a custom domain or accept that every call goes to UniFi.

**Two different UniFi keys exist, and only one of them works here.** The key under a
console's Settings, Control Plane, Integrations is local to that console. This server needs
the account-level key from unifi.ui.com under Settings, API Keys. It is shown once, so
copy it when you create it.

## Prerequisites

- A Cloudflare account. The free plan is enough.
- A UniFi **account-level** API key from unifi.ui.com, under Settings, API Keys. This is
  not the same as the key under Settings, Control Plane, Integrations: that one is local to
  a single console and cannot see a fleet. See the note below on which account to generate
  it from.
- Consoles running firmware 5.0.3 or later. Below that there is no Cloud Connector proxy
  and the console cannot be managed remotely at all. `list_consoles` tells you which of
  yours qualify.
- For managing consoles you do not personally own, an **organisation** API key. Each key is
  tied to the account or organisation that generated it, so a personal key only reaches
  consoles belonging to its owner. Generating the key from your personal account instead of
  the organisation that administers the client consoles is the usual reason an MSP sees a
  403 on a client site.

## Deploy

Fork this repository, then in Cloudflare create a Worker connected to your fork with
Workers Builds. Every push to `main` deploys.

## Secrets

Set these in the Cloudflare dashboard under Settings, Variables and Secrets. Never in
`wrangler.toml`.

| Name | Required | Purpose |
| --- | --- | --- |
| `UNIFI_API_KEY` | No | Your UniFi key. Omit it to run in bring-your-own-key mode, where the caller's credential is used as the UniFi key and the deployment holds nothing. |
| `MCP_TOKEN` | Only when `UNIFI_API_KEY` is set | Credential clients must present. Comma separated for rotation. |
| `ALLOWED_CONSOLES` | No | Comma separated allowlist of console IDs. A secret rather than a variable, so a public fork does not advertise your clients. |

Plain variables, in `wrangler.toml`:

| Name | Default | Purpose |
| --- | --- | --- |
| `ENABLE_WRITES` | `false` | While false, the write tools are not registered at all and do not appear in `tools/list`. |
| `MAX_BATCH` | `6` | Consoles per fan-out call. See below. |
| `UPSTREAM_TIMEOUT_MS` | `15000` | Per upstream call. |

If `UNIFI_API_KEY` is set and `MCP_TOKEN` is not, the server refuses every request rather
than quietly serving your whole estate to anyone who finds the URL.

## Connect

Add a custom connector pointing at `https://your-worker.example.com/mcp`, with
Authentication set to **None**, and a header `x-api-key` carrying your `MCP_TOKEN` (or, in
bring-your-own-key mode, your UniFi API key).

For clients that cannot set headers at all, `https://your-worker.example.com/mcp/t/<token>`
works as a fallback.

## Tools

Always available:

- `list_consoles` gives you the fleet, with firmware and whether each console is reachable
  through the proxy.
- `verify_console` checks one console properly and reports which sections actually read.
- `get_config` reads a console's configuration, normalised.
- `diff_config` compares a section across a batch of consoles against a baseline console.
- `raw_request` is the escape hatch for anything not covered above. Paths are relative to
  the console's `/proxy` prefix, for example
  `/network/integration/v1/sites/{siteId}/acl-rules`. Read only unless `ENABLE_WRITES` is
  on.

Only when `ENABLE_WRITES` is `true`:

- `apply_config` brings consoles into line with a baseline. Without `confirm: true` it
  returns the plan and changes nothing. Actual writing is not implemented yet and returns
  an explicit refusal, on purpose.

## How the fan-out works

Workers caps subrequests per request, at 50 on the free plan, and each proxied UniFi call
adds roughly 800ms. A fleet-wide sweep in one tool call would blow through both limits.

So `diff_config` and `apply_config` take an explicit list of console IDs, process
`MAX_BATCH` of them, and return the rest in `remaining`. The model feeds `remaining` back
in for the next batch. You get visible progress instead of a call that hangs and then
fails at console 37.

One console being offline does not lose the answer for the others. Failures come back in
their own array with the reason.

## The baseline is a console, not a file

There is no stored golden config. You nominate an existing console as the baseline and it
is captured live. This keeps the Worker genuinely stateless, and it matches how this
actually gets used: make the new site look like the one that already works.

## Which UniFi API this uses

Only the official Network Integration API (v10.4.57), reached through the Cloud Connector
proxy. The classic controller API is not used anywhere, so there are no session cookies,
no `meta`/`data` envelope and no undocumented field names.

That API covers networks, WiFi broadcasts, firewall zones and policies, ACL rules, DNS
policies and traffic matching lists, with full create, update and delete.

## What is normalised, and why

Comparing raw UniFi payloads across consoles produces noise rather than drift. Three rules
handle most of it.

**Identity is by name, never by ID.** Every ID in this API is a UUID minted by one console,
so a baseline keyed on IDs cannot be applied anywhere else. A firewall policy referencing a
zone stores the zone's name, and it gets resolved back to a local UUID at apply time.

**Only user-defined entities are compared.** Every policy and DNS record carries
`metadata.origin`, and only `USER_DEFINED` entities can be modified. Stock and derived
policies are dropped at capture, because reporting them as drift produces a change you
cannot actually make.

**Firewall policy order is relative.** The absolute `index` from a console depends on how
many stock policies sit above it, and it is deprecated on write in any case. Ordering is
applied through the dedicated ordering endpoint as a second phase.

## Status

Early. `networks`, `wifi`, `firewall` and `dns` capture and diff.

Multi-site consoles are rejected rather than guessed at. Section reads take a single page
of up to 200 entries and fail loudly if a console has more, rather than silently diffing a
partial list.

Writing is not implemented. The name-to-UUID reference resolver, the ordering pass for
firewall policies, and a per-console rollback path all need to land first.

## Not affiliated with Ubiquiti

Unofficial. Not endorsed by or sponsored by Ubiquiti Inc. UniFi and Ubiquiti are
trademarks of their respective owner. Use at your own risk.
