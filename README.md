# mcp-unifi

An MCP server for [UniFi](https://ui.com), running on Cloudflare Workers. Manage a whole
fleet of consoles through one connection instead of one controller at a time.

**Connect UniFi to Claude, Claude Code, Cursor or any MCP client.** No local install, no
Node.js, no Python, no VPN into client networks. It runs as a remote Worker in your own
Cloudflare account, so it works from mobile as well as desktop and keeps working when your
laptop is closed.

> "Which of my sites disagree with the standard firewall policy set?"
> "Do all the guest networks have the same DNS servers and lease time?"
> "Show me every console still running firmware too old to manage remotely."

Reads through the UniFi Site Manager Cloud Connector, so it reaches consoles you have no
network path to.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jason-mspkickstart/mcp-unifi)

One click clones this repo to your GitHub and deploys it to your own Cloudflare account.
Your API key stays in your Worker, never anyone else's. Free on Cloudflare's free plan.

---

## Contents

- [Before you start](#before-you-start)
- [Setup](#setup) — deploy, secrets, connect
- [Connecting your AI assistant](#connecting-your-ai-assistant)
- [Tools](#tools)
- [How it works](#how-it-works)
- [Configuration reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Why another UniFi MCP](#why-another-unifi-mcp)

---

## Before you start

You need three things:

1. **Consoles running firmware 5.0.3 or later.** Below that there is no Cloud Connector
proxy, so the console cannot be managed remotely at all and there is nothing this server
can do about it. `list_consoles` tells you which of yours qualify.
2. **A Cloudflare account.** The free plan is fine.
3. **A UniFi API key.** See below.

You do **not** need Node.js, a terminal, or any local tooling. Everything below can be done
in a browser.

### Getting a UniFi API key

1. Sign in to the UniFi Site Manager at [unifi.ui.com](https://unifi.ui.com) and select the
organisation that administers the consoles you want to manage.
2. Go to **Settings** → **API Keys**.
3. **Create New API Key**, and give it a name.
4. Copy the key. It is shown once and never again.

**The single most common mistake:** there are two different UniFi API keys, and only the
one above works here. The key under a console's **Settings** → **Control Plane** →
**Integrations** is local to that single console and cannot see a fleet. Using it does not
produce a permissions error, it just returns nothing, which looks like a broken server.

The second most common mistake is scoping. Each key is tied to the account or organisation
that created it, so a personal key only reaches consoles you own yourself. If you manage
client consoles, the key has to come from the organisation that administers them.

---

## Setup

### 1. Deploy to Cloudflare

Use the **Deploy to Cloudflare** button at the top of this README. It forks the repo to
your GitHub account and sets the Worker up for you, then redeploys on every push.

**Or set it up manually**

Fork this repository, then in the Cloudflare dashboard go to **Compute (Workers)** →
**Create** → **Import a repository**. Connect GitHub, choose your fork, and set:

| Setting        | Value                 |
| -------------- | --------------------- |
| Branch         | `main`                |
| Build command  | *leave empty*         |
| Deploy command | `npx wrangler deploy` |

Check it worked by visiting `https://mcp-unifi.<your-subdomain>.workers.dev/health` in a
browser. It should say `ok`.

**Prefer the command line?**

```
npm install
npx wrangler login
npx wrangler deploy
```

### 2. Choose your mode

**Private (recommended for MSP use).** Your UniFi key is stored in the Worker and a
separate access token controls who can use it. Continue to step 3.

**Bring your own key.** The Worker stores nothing, and each user sends their own UniFi key.
Use this if you want to share the deployment with others. Skip step 3 entirely and jump to
[Connecting](#connecting-your-ai-assistant), using your UniFi key as the header value.

Think about this one properly. A UniFi key is not scoped to a single console, so private
mode means whoever holds the token can read configuration across every console that key
administers.

### 3. Add your secrets

Generate an access token first. In PowerShell:

```
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
```

Or on macOS and Linux:

```
openssl rand -hex 32
```

In the Cloudflare dashboard, open your Worker → **Settings** → **Variables and Secrets**.
Add these, each as type **Secret** rather than plain text:

| Name                | Value                                                          |
| ------------------- | -------------------------------------------------------------- |
| `UNIFI_API_KEY`     | Your UniFi Site Manager key                                    |
| `MCP_TOKEN`         | The token you just generated                                   |
| `ALLOWED_CONSOLES`  | *Optional.* Comma separated console IDs from `list_consoles`   |

Setting `UNIFI_API_KEY` switches the Worker into private mode, where `MCP_TOKEN` is
mandatory. The Worker refuses to serve anything if you set the key without a token, rather
than quietly exposing your whole estate to anyone who finds the URL.

`ALLOWED_CONSOLES` is optional but worth setting. It restricts which consoles can be
touched, and putting it in as a secret keeps your client list out of a public repository.

### 4. Use a custom domain

Not strictly required, but do it. **Settings** → **Domains & Routes** → **Add** → **Custom
domain**, something like `mcp-unifi.yourdomain.com`.

Cloudflare's Cache API silently does nothing on `workers.dev` subdomains, so without a
custom domain the response cache never works and every console read makes a fresh trip
through the cloud proxy, at roughly 800ms each.

---

## Connecting your AI assistant

### Claude (web, desktop and mobile)

**Settings** → **Connectors** → **Add custom connector**.

| Field          | Value                                   |
| -------------- | --------------------------------------- |
| URL            | `https://mcp-unifi.yourdomain.com/mcp`  |
| Authentication | **None**                                |

Then **Add header**:

| Field       | Value                                                           |
| ----------- | --------------------------------------------------------------- |
| Header name | `x-api-key`                                                     |
| Value       | Your `MCP_TOKEN` (or your UniFi key in bring-your-own-key mode) |
| Required    | ✅                                                              |

**Set Authentication to None, not OAuth.** This server uses an API key, not OAuth. The
`authorization` header is greyed out because Claude reserves it for its own OAuth bearer
token, which is why `x-api-key` is used instead.

### Claude Code

```
claude mcp add --transport http unifi https://mcp-unifi.yourdomain.com/mcp \
  --header "x-api-key: YOUR_MCP_TOKEN"
```

### Clients that only speak stdio

Some clients cannot talk to a remote server directly. Bridge with `mcp-remote`:

```
{
  "mcpServers": {
    "unifi": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://mcp-unifi.yourdomain.com/mcp",
        "--header", "x-api-key:YOUR_MCP_TOKEN"
      ]
    }
  }
}
```

### If your client cannot set headers at all

Put the token in the URL instead:

```
https://mcp-unifi.yourdomain.com/mcp/t/YOUR_MCP_TOKEN
```

This works, but the token then appears in your connector settings, in logs, and in any
screenshot. Prefer the header where you can.

### Check it worked

Ask your assistant: *"list my UniFi consoles"*. You should get your fleet back, with
firmware and whether each one is reachable through the proxy. Then run `verify_console` on
one of them before trusting anything else.

---

## Tools

### Reading

| Tool             | What it does                                                                    |
| ---------------- | ------------------------------------------------------------------------------- |
| `list_consoles`  | Your fleet, with model, firmware and whether the Cloud Connector proxy works    |
| `verify_console` | Checks one console properly and reports which config sections actually read     |
| `get_config`     | One console's configuration, normalised for cross-console comparison            |
| `diff_config`    | Compares a section across a batch of consoles against a baseline console        |
| `raw_request`    | Any request the curated tools do not cover                                      |

Sections are `networks`, `wifi`, `firewall` and `dns`.

Run `verify_console` on an unfamiliar console before trusting a diff, rather than guessing.
It reports firmware, sites and per-section success or the actual error.

`raw_request` paths are relative to the console's `/proxy` prefix, for example
`/network/integration/v1/sites/{siteId}/acl-rules`. It is read only unless writes are
enabled.

### Writing

Off by default. To enable, set the `ENABLE_WRITES` variable to `true` in **Settings** →
**Variables and Secrets** (a plain variable, not a secret).

`apply_config` brings a batch of consoles into line with a baseline console.

When writes are off, this tool is not merely refused, it is not advertised at all.

`apply_config` requires an explicit `confirm: true`. Without it you get the plan and
nothing is changed, which is how you should always call it first.

**Writing is not implemented in this version.** The dry run works and is useful on its own,
but `confirm: true` returns an explicit refusal. The name-to-UUID reference resolver, the
ordering pass for firewall policies and a per-console rollback path all have to land before
this can safely touch a client network.

---

## How it works

### The baseline is a console, not a file

There is no stored golden config. You nominate an existing console as the baseline and it
is captured live. This keeps the Worker genuinely stateless, and it matches how this
actually gets used: make the new site look like the one that already works.

### Which UniFi API this uses

Only the official Network Integration API (v10.4.57), reached through the Cloud Connector
proxy. The classic controller API is not used anywhere, so there are no session cookies, no
`meta`/`data` envelope and no undocumented field names.

That API covers networks, WiFi broadcasts, firewall zones and policies, ACL rules, DNS
policies and traffic matching lists, with full create, update and delete.

### Fan-out is batched, on purpose

Workers caps subrequests per request, at 50 on the free plan, and each proxied UniFi call
adds roughly 800ms. A fleet-wide sweep in one tool call would blow through both limits.

So `diff_config` and `apply_config` take an explicit list of console IDs, process
`MAX_BATCH` of them, and return the rest in `remaining` for the next call. You get visible
progress instead of a call that hangs and then fails at console 37.

One console being offline does not lose the answer for the others. Failures come back in
their own array with the reason.

### What is normalised, and why

Comparing raw UniFi payloads across consoles produces noise rather than drift. Three rules
handle most of it.

**Identity is by name, never by ID.** Every ID in this API is a UUID minted by one console,
so a baseline keyed on IDs cannot be applied anywhere else. A firewall policy referencing a
zone stores the zone's name, to be resolved back to a local UUID at apply time.

**Only user-defined entities are compared.** Every policy and DNS record carries
`metadata.origin`, and only `USER_DEFINED` entities can be modified. Stock and derived
policies are dropped at capture, because reporting them as drift produces a change you
cannot actually make.

**Firewall policy order is relative.** The absolute `index` from a console depends on how
many stock policies sit above it, and it is deprecated on write in any case. Ordering is
applied through the dedicated ordering endpoint as a second phase.

### Limits worth knowing

Multi-site consoles are rejected with the site list rather than guessed at. Section reads
take a single page of up to 200 entries and fail loudly if a console has more, rather than
silently diffing a partial list.

---

## Configuration reference

| Name                  | Type     | Purpose                                                                                                 |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `UNIFI_API_KEY`       | Secret   | Optional. Setting it switches to private mode                                                           |
| `MCP_TOKEN`           | Secret   | Required when `UNIFI_API_KEY` is set. Accepts a comma separated list, so you can rotate without downtime |
| `ALLOWED_CONSOLES`    | Secret   | Optional allowlist of console IDs, comma separated                                                      |
| `ENABLE_WRITES`       | Variable | `true` registers the write tools                                                                        |
| `MAX_BATCH`           | Variable | Consoles per fan-out call. Defaults to 6, capped at 12                                                  |
| `UPSTREAM_TIMEOUT_MS` | Variable | Per upstream call. Defaults to 15000                                                                    |

### Rotating your token without breaking anything

`MCP_TOKEN` accepts a list. Set it to `old-token, new-token`, update each client one at a
time, then set it back to just `new-token`. No downtime, no scramble.

### Accepted credential headers

`x-api-key` is recommended, but `api-key`, `apikey`, `x-apikey`, `x-api-token`,
`api-token`, `x-auth-token` and `Authorization: Bearer` all work, for clients that restrict
which headers you can set.

---

## Troubleshooting

**`list_consoles` returns nothing, or only your own console.** Almost always the wrong key.
The key from a console's Control Plane Integrations page is local to that console. You need
the account-level key from unifi.ui.com under Settings, API Keys, generated from the
organisation that administers the consoles.

**A single console returns 403.** Key scoping. A personal key only reaches consoles
belonging to its owner, so an organisation key is needed for other admins' consoles.

**Every call returns 401 from the Worker.** Your header value does not match `MCP_TOKEN`.
Check for a trailing space when you pasted it.

**The connector shows an OAuth sign-in prompt.** Authentication is set to something other
than None. This server does not use OAuth.

**A console returns 404 for every section.** Either it is not visible to your key, or its
firmware predates 5.0.3 and it has no Cloud Connector proxy. `verify_console` tells those
two apart.

**A console times out but others in the batch are fine.** Proxied calls add roughly 800ms
each, so a slow or flapping uplink can exceed `UPSTREAM_TIMEOUT_MS`. The console is
reported as a failure and the rest of the batch still answers.

**Rate limited sooner than expected.** The documented Site Manager limit is 10,000 requests
per minute, but the connector proxy is newer than the stable v1 endpoint list and may carry
a lower limit. Reduce `MAX_BATCH`.

**A write returns 403 while reads work.** Site Manager keys have historically been
read-only, with write access something you enable and then regenerate the key for. Check
the key's permissions at unifi.ui.com.

**Results seem stale.** Console configuration is cached for 30 seconds and the fleet list
for 60. On a `workers.dev` subdomain there is no caching at all.

---

## Why another UniFi MCP

Several UniFi MCP servers already exist and some are well built. They are all built around
one controller at a time, which is the wrong shape for anyone running more than a handful
of sites. This one differs in three ways:

- **Fleet first.** One connection covers every console your key administers. The interesting
question is not "what is on this gateway" but "where do my sites disagree with each other".
- **Drift detection as a primitive.** Comparison happens in code, not by asking the model to
eyeball two payloads, so the answer is deterministic and you can hand it to a client.
- **Cloud proxy only.** No VPN, no port forward, no local network path required, which is
what makes managing client sites practical.

---

## Development

```
npm install
npm run typecheck
npm run dev     # needs a .dev.vars file, gitignored
npm run tail    # live logs from the deployed worker
```

## Licence

Free and MIT licensed. Provided as-is, with no warranty of any kind and no liability
accepted, as set out in [LICENSE](LICENSE).

You deploy and run this in your own Cloudflare account, so your API keys, your usage and
anything the tools do to your UniFi consoles remain your responsibility. Enabling the write
tools means an AI assistant can change configuration across every console your key
administers, so read that section before turning them on.

Unofficial. Not affiliated with, endorsed by or sponsored by Ubiquiti Inc. UniFi and
Ubiquiti are trademarks of their respective owner.

Maintained in spare time, so issues and pull requests are very welcome but may not get a
fast response.
