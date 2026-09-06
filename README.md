# mcp-unifi

An MCP server for [UniFi Site Manager](https://unifi.ui.com), running on Cloudflare
Workers. Manage a fleet of UniFi consoles from an AI assistant, across every site at
once.

**Connect UniFi to Claude, Claude Code, Cursor or any MCP client.** No local install,
no Node.js, no Python, no VPN. It runs as a remote Worker in your own Cloudflare
account, reaching each console through UniFi's Cloud Connector proxy, so it works from
mobile as well as desktop and keeps working when your laptop is closed.

> "Is anything wrong across my sites?"
> "Which devices have firmware updates pending?"
> "Does the new site match how we build sites?"
> "Which clients are having a bad time on WiFi at the pub?"

Built for MSPs and anyone running more than one console. The UniFi interface shows you
one site at a time; this shows you all of them in one answer.

---

## Contents

- [Before you start](#before-you-start)
- [Setup](#setup)
- [Connecting your AI assistant](#connecting-your-ai-assistant)
- [Tools](#tools)
- [Configuration reference](#configuration-reference)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)

---

## Before you start

You need:

1. **A UniFi account with consoles adopted into it**, visible at
   [unifi.ui.com](https://unifi.ui.com).
2. **Console firmware 5.0.3 or later.** Below that there is no Cloud Connector proxy
   and the console cannot be reached from the cloud at all.
3. **A Site Manager API key.** At [unifi.ui.com](https://unifi.ui.com), open your
   account settings and create an API key.
4. **A Cloudflare account.** The free plan is fine.

**The key must come from unifi.ui.com**, not from an individual console's settings. A
console-local key only works against that console's local API and will be rejected by
`api.ui.com`. This is the most common setup mistake.

You do **not** need Node.js or any local tooling. Everything below is done in a browser.

---

## Setup

### 1. Deploy to Cloudflare

Fork this repository, then in the Cloudflare dashboard go to **Compute (Workers)** →
**Create** → **Import a repository**. Connect GitHub, choose your fork, and set:

| Setting | Value |
| --- | --- |
| Branch | `main` |
| Build command | *leave empty* |
| Deploy command | `npx wrangler deploy` |

Check `https://mcp-unifi.<your-subdomain>.workers.dev/health` returns `ok`.

### 2. Generate an access token

PowerShell:

```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
```

macOS or Linux:

```bash
openssl rand -hex 32
```

### 3. Add your secrets

Cloudflare dashboard → your Worker → **Settings** → **Variables and Secrets**. Add each
as type **Secret**, not Text:

| Name | Value |
| --- | --- |
| `UNIFI_API_KEY` | Your Site Manager API key |
| `MCP_TOKEN` | The token from step 2 |
| `ALLOWED_CONSOLES` | *Optional.* Comma separated console IDs to restrict this deployment |

**Check the names carefully.** They must match exactly. A secret named
`UNIFI_API_TOKEN` will not bind, and the server will tell you so rather than failing in
a confusing way.

**Secret, not Text, matters.** Plain-text variables declared in `wrangler.toml` replace
all dashboard variables on every deploy. Secrets survive.

### 4. Use a custom domain

**Settings** → **Domains & Routes** → **Add** → **Custom domain**.

Cloudflare's Cache API silently does nothing on `workers.dev` subdomains, so without a
custom domain no response caching happens at all and every call hits UniFi.

---

## Connecting your AI assistant

### Claude (web, desktop and mobile)

**Settings** → **Connectors** → **Add custom connector**.

| Field | Value |
| --- | --- |
| URL | `https://your-worker-domain/mcp` |
| Authentication | **None** |

Then **Add header**: name `x-api-key`, value your `MCP_TOKEN`, Required ticked.

**Authentication must be None.** This server uses an API key, not OAuth. The
`authorization` header is greyed out because Claude reserves it for its own OAuth
token, hence `x-api-key`.

### Claude Code

```bash
claude mcp add --transport http unifi https://your-worker-domain/mcp \
  --header "x-api-key: YOUR_MCP_TOKEN"
```

### Clients that only speak stdio

```json
{
  "mcpServers": {
    "unifi": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://your-worker-domain/mcp",
        "--header", "x-api-key:YOUR_MCP_TOKEN"
      ]
    }
  }
}
```

### Check it worked

Ask: *"list my UniFi consoles"*, then *"how is the fleet looking?"*

**Adding tools requires a reconnect.** Tool lists are cached by the client at
connection time, so after deploying a version with new tools, toggle the connector off
and on before they appear.

---

## Tools

### Fleet state

| Tool | What it does |
| --- | --- |
| `list_consoles` | Every console the key can reach, with model, firmware and connector capability |
| `fleet_health` | Health across every site in one call, with a `needsAttention` list |
| `get_health` | One site in detail: WAN availability and latency, ISP, clients, gateway CPU and memory |
| `list_devices` | Devices on one console, with `onlyProblems` to surface just the unhappy ones |
| `list_clients` | Clients with signal, retry rate and experience score, filterable to problems only |
| `fleet_inventory` | Every device across every site as an asset register, grouped by model |
| `firmware_report` | Pending updates fleet-wide, plus models running mixed versions across sites |

### Configuration

| Tool | What it does |
| --- | --- |
| `verify_console` | Whether a console is reachable and which config sections read cleanly |
| `get_config` | Networks, WiFi, firewall or DNS from one console, normalised for comparison |
| `diff_config` | Compare a section across sites against a baseline, reporting exactly what differs |

### Escape hatch

`raw_request` sends an arbitrary request through the Cloud Connector proxy for anything
the curated tools do not cover. Read-only unless `ENABLE_WRITES` is set. Paths are
validated to prevent escaping the console's `/proxy` prefix.

### Writes

`apply_config` exists but **deliberately refuses to write**. Without name-to-UUID
reference resolution, a firewall policy ordering pass and per-console rollback, applying
config to a live client network is not safe. The dry run shows the plan. Enabling
`ENABLE_WRITES` allows non-GET `raw_request` calls, not config application.

---

## Configuration reference

| Name | Type | Purpose |
| --- | --- | --- |
| `UNIFI_API_KEY` | Secret | Your Site Manager key. Omit to run in bring-your-own-key mode |
| `MCP_TOKEN` | Secret | Required when `UNIFI_API_KEY` is set. Comma separated list accepted, for rotation |
| `ALLOWED_CONSOLES` | Secret | Optional console ID allowlist |
| `ENABLE_WRITES` | Variable | `true` allows non-GET `raw_request` |
| `MAX_BATCH` | Variable | Upper bound on consoles per fan-out call. Default 6 |
| `UPSTREAM_TIMEOUT_MS` | Variable | Per-call timeout. Default 15000 |

### Rotating your token without downtime

Set `MCP_TOKEN` to `old-token, new-token`, update each client, then set it back to just
`new-token`.

### Accepted credential headers

`x-api-key` is recommended, but `api-key`, `apikey`, `x-apikey`, `x-api-token`,
`api-token`, `x-auth-token` and `Authorization: Bearer` all work.

---

## How it works

Config comes from the **Network Integration API**, the officially supported one. State
comes from the **classic controller API**, which is still where health, devices and
clients live. Both are reached through the Site Manager Cloud Connector proxy, so no
VPN or open port is needed.

**Everything reduces hard.** The raw device payload for a four-device site, or the
client list for a small office, is large enough to exhaust an LLM context window on its
own. No tool passes raw UniFi payloads through; each has a size guard that fails with a
clear message rather than dumping.

**Identity is by name, never by ID.** Every UUID in these APIs is minted by one console,
so a config captured from one site cannot be matched to another by ID. Networks, zones
and traffic lists are stored by name and resolved per console.

**Subrequest budgeting.** Workers caps subrequests per request (50 on the free plan) and
fan-out calls consume several per console. Batch sizes are computed from the cost of the
section being read, and anything not processed comes back in `remaining` to feed into
the next call rather than failing the whole request.

**Failures are partial, not fatal.** One unreachable console never loses the answer for
the rest. Consoles the cloud already reports as disconnected are listed separately under
`offline`, with the time they went down, rather than reported as errors.

---

## Troubleshooting

**401 from UniFi.** The key is wrong, expired, or was generated on a console rather than
at unifi.ui.com. Test it directly:

```bash
curl.exe -s -H "X-API-KEY: YOUR_KEY" https://api.ui.com/v1/hosts
```

**"UNIFI_API_KEY is not visible to the runtime."** The secret name does not match. The
error lists every binding the Worker can see, so compare that list against the expected
name.

**A console returns 404 on everything.** Either it is offline, or the path does not
exist on that version. `list_consoles` shows connection state. Not every classic API
endpoint exists in every UniFi Network release: `stat/alarm` and `stat/event` are gone
in 10.x, while `stat/health`, `stat/device` and `stat/sta` remain.

**`firewall` fails but `networks` works.** That console has no zone-based firewalling
configured. Networks still reads, but `zoneRef` will be null and the result carries a
warning saying so.

**A WiFi diff shows everything as added and removed.** Identity is by name, so
site-specific SSIDs like `Site_Priv` will not match across consoles. That is correct
behaviour; diffs are most useful between sites built from a shared template.

**New tools do not appear.** The client caches the tool list. Reconnect the connector.

---

## Development

```bash
npm install
npm run typecheck
npm run dev     # needs a .dev.vars file, gitignored
npm run tail    # live logs from the deployed worker
```

## Licence

Free and MIT licensed. Provided as-is, with no warranty of any kind and no liability
accepted, as set out in [LICENSE](LICENSE).

You deploy and run this in your own Cloudflare account, so your API key, your usage and
anything the tools do to your UniFi estate remain your responsibility. This reaches
production networks belonging to real clients: read the section on writes before
enabling `ENABLE_WRITES`.

Maintained in spare time, so issues and pull requests are very welcome but may not get a
fast response.
