# Security policy

## Reporting a vulnerability

Please do not open a public GitHub issue for security problems.

Report it through the contact form at [jasonparsons.co.uk](https://jasonparsons.co.uk/)
instead, and include enough detail to reproduce the issue. I will acknowledge it and work
on a fix, though this project is maintained in spare time so please allow a reasonable
window before disclosing publicly.

## What is in scope

This Worker holds a UniFi Site Manager API key, which is not scoped to a single console. It
reaches every console the owning account or organisation administers, so a leak exposes a
whole estate rather than one site. Things worth reporting:

* Anything that leaks `UNIFI_API_KEY`, `MCP_TOKEN` or `ALLOWED_CONSOLES`, including through
  error messages, cached responses or logs
* Any way to bypass the `MCP_TOKEN` check
* Any way to reach a console outside a configured `ALLOWED_CONSOLES` list
* Any way to reach a write tool, or send a non-GET request through `raw_request`, when
  `ENABLE_WRITES` is not `true`
* Any way to bypass the confirmation required by `apply_config`
* Any way to make the Worker proxy a request to a host other than the intended console,
  for example through path traversal in a `raw_request` path
* Cache poisoning, or one caller reading another caller's cached responses

## What is not in scope

* Vulnerabilities in Ubiquiti's APIs or the Cloud Connector proxy, which should go to
  Ubiquiti
* Vulnerabilities in Cloudflare Workers, which should go to Cloudflare
* Anything requiring an attacker to already hold your API key or MCP token
* Misconfiguration of your own deployment, such as putting secrets in `wrangler.toml`

## For anyone running this

Your UniFi API key is the sensitive item here, more so than any token. It is account or
organisation scoped rather than console scoped, and it does not expire.

* Never put it in `wrangler.toml`. Secrets belong in the Cloudflare dashboard under
  Settings, Variables and Secrets, set as type Secret rather than plain text.
* If it is ever exposed, create a new key at unifi.ui.com and delete the old one
  immediately.
* Set `ALLOWED_CONSOLES` even when the key already has the right scope. It limits the blast
  radius if the token leaks, and keeping it as a secret rather than a plain variable keeps
  your client list out of a public repository.
* If `UNIFI_API_KEY` is set and `MCP_TOKEN` is not, the Worker refuses every request. It
  will not fall back to serving unauthenticated, because that would expose the fleet to
  anyone who finds the URL.
* Leave `ENABLE_WRITES` off unless you need it. While it is false the write tools are not
  registered at all, so they never appear in `tools/list`, and `raw_request` rejects
  anything other than GET.
* `MCP_TOKEN` accepts a comma separated list, so you can rotate it without downtime: add
  the new value alongside the old, migrate your clients, then remove the old one. Tokens
  are compared in constant time with no early exit.
* Use a custom domain. On a `workers.dev` subdomain the Cache API silently does nothing,
  which is a performance problem rather than a security one, but it also means the
  key-scoped cache isolation described above is never exercised.
