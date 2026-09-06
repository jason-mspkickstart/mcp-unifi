# Security

## Reporting a vulnerability

Please open a private security advisory on this repository rather than a public issue.

## What this server can reach

A UniFi API key generated at unifi.ui.com is not scoped to a single console. It reaches
every console the owning account administers, and an organisation key reaches every
console in the organisation. Deploying this server therefore hands whoever holds the MCP
token the ability to read configuration across that whole estate, and to change it if
writes are enabled.

Treat the deployment accordingly.

## Configuration expectations

- `UNIFI_API_KEY` and `MCP_TOKEN` are Cloudflare secrets, never values in `wrangler.toml`.
- If `UNIFI_API_KEY` is set and `MCP_TOKEN` is not, the server refuses every request. It
  will not fall back to serving unauthenticated, because that would expose the fleet.
- `ALLOWED_CONSOLES` is a secret rather than a plain variable, so a public repository does
  not disclose which clients sit behind the deployment.
- `ENABLE_WRITES` defaults to `false`. While it is false the write tools are not
  registered at all, so they do not appear in `tools/list`.

## Token rotation

`MCP_TOKEN` accepts a comma separated list. Add the new token, migrate clients, then
remove the old one. Tokens are compared in constant time with no early exit.

## Writes

`apply_config` returns a plan and changes nothing unless called with `confirm: true`.
Actual writing is not implemented in this version and returns an explicit refusal, because
a partially applied change across a fleet of client networks is worse than no change.
