# Cloudflare Integration

Lets NanoClaw agents deploy to Cloudflare (Pages, Workers, Tunnels), manage DNS,
and register domains — with WhatsApp-based HITL approval for any operation that
costs money.

## Setup

### 1. Create a Cloudflare account (one-time, manual)

The Cloudflare public API does **not** support account creation. Sign up once at
<https://dash.cloudflare.com/sign-up>. After that, everything below is fully
programmatic for the agent.

### 2. Create an API token

Go to <https://dash.cloudflare.com/profile/api-tokens> and create a token with
these permissions:

| Resource | Permission | Why |
|----------|-----------|-----|
| Account › Workers Scripts | Edit | `cloudflare_deploy_worker` |
| Account › Cloudflare Pages | Edit | `cloudflare_deploy_pages` |
| Account › Cloudflare Tunnel | Edit | `cloudflare_setup_tunnel` |
| Account › Account Settings | Read | `cloudflare_whoami`, listing |
| Zone › DNS | Edit | `cloudflare_add_dns_record` |
| Zone › Zone | Edit | `cloudflare_add_zone` |
| Account › Domains (Registrar) | Edit | `cloudflare_register_domain` *(optional)* |

Find your account ID at <https://dash.cloudflare.com> → right sidebar → "Account ID".

### 3. Add credentials to `.env`

```
CLOUDFLARE_API_TOKEN=cf-pat-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef

# Safety caps on cloudflare_register_domain (optional)
CLOUDFLARE_MAX_DOMAIN_PRICE_USD=50
CLOUDFLARE_MAX_REGISTRATION_YEARS=5
```

### 4. Rebuild the agent container

```
./container/build.sh
```

The Cloudflare tools are loaded automatically in the `main` group. The
container reads `CLOUDFLARE_API_TOKEN` from the secrets passed in via stdin
(never written to disk inside the container).

## MCP Tools

All tools are available to agents running in the `main` group. The agent calls
them by name; results come back as JSON text.

### `cloudflare_whoami`

Verifies the API token and returns a `notes` block documenting what is / isn't
possible. **Always run this first** when debugging.

### `cloudflare_check_domain`

```
cloudflare_check_domain(domain: "example.com")
→ { available: true, note: "..." }
```

Does not charge anything. Pure availability check.

### `cloudflare_register_domain` *(HITL gated)*

```
cloudflare_register_domain(
  domain: "example.com",
  years: 1,
  estimated_price_usd: 10.44,
  privacy: true,
  auto_renew: true,
)
```

This **does not** register immediately. The flow is:

1. Container sends an IPC request to the host.
2. Host's `DomainPurchaseGate` validates against `CLOUDFLARE_MAX_DOMAIN_PRICE_USD`
   and `CLOUDFLARE_MAX_REGISTRATION_YEARS`. If the request exceeds either cap,
   the agent gets an immediate error response — no WhatsApp prompt is sent.
3. Host sends a WhatsApp message to the user with an 8-character hex token:
   ```
   🌐 *Domain Registration — Approval Required*
   *Domain:* example.com
   *Period:* 1 year
   *Estimated cost:* $10.44/yr × 1 = *$10.44 USD*
   *WHOIS privacy:* enabled
   *Auto-renew:* enabled

   Reply:  *approve-domain abcd1234*
           *reject-domain abcd1234*
   (expires in 30 minutes)
   ```
4. User replies in WhatsApp. The host either calls the Cloudflare Registrar API
   (on approval) or skips and notifies (on rejection).
5. The agent's `cloudflare_register_domain` call resolves with `{ success, message, details }`.

The container's poll timeout is 10 minutes; if the user doesn't reply by then,
the tool returns an error. The gate itself expires the proposal after 30 minutes.

Every decision is written to `data/audit/cloudflare-domains/<timestamp>-<token>.json`.

### `cloudflare_list_zones`

Lists all zones in the account.

### `cloudflare_add_zone`

Adds a zone for an externally-registered domain. Returns the Cloudflare
nameservers the user must set at their existing registrar.

### `cloudflare_add_dns_record`

Creates `A`, `AAAA`, `CNAME`, `TXT`, or `MX` records in a zone.

### `cloudflare_deploy_pages`

Creates or reuses a Pages project. Returns the `*.pages.dev` subdomain. For
the actual file upload, follow up with `wrangler pages deploy <dir>
--project-name=<name>` — that requires the wrangler CLI on the host or
container, which is intentionally out of scope for this MCP tool.

### `cloudflare_deploy_worker`

Uploads a Worker script (source code passed as `script_content`). Uses the
multipart Workers API directly.

### `cloudflare_setup_tunnel`

Creates a named `cloudflared` tunnel and returns the tunnel ID. The user must
install and run `cloudflared` on the host that originates the tunnel (the tool
does not start the daemon).

## HITL Approval Flow (in detail)

```
agent → cloudflare_register_domain (container)
     │
     ▼
writes /workspace/ipc/messages/cf-register-…json
     │
     ▼  (host polls IPC dir every 500ms)
src/ipc.ts → integration.handleIpcMessage
     │
     ▼
src/integrations/cloudflare/ipc-handlers.ts
   ├─ domainPurchaseGate.propose() → returns token
   ├─ sendMessage(chatJid, formatted prompt)
   └─ does NOT write IPC response yet
            │
            ▼  (user replies in WhatsApp)
src/index.ts message loop → integration.tryHandleApproval
     │
     ▼
domainPurchaseGate.tryHandleApproval()
   ├─ matches /\b(approve|reject)-domain ([a-f0-9]{8})\b/i
   ├─ approve → CloudflareClient.registerDomain()
   ├─ writes audit log
   ├─ notify user of result
   └─ invokes proposal.onResult() → writes IPC response
            │
            ▼
container's pollResponse() returns → tool result returned to agent
```

## Safety

- **Account creation is impossible via API** — the agent cannot create new
  Cloudflare accounts on the user's behalf. Surface this with `cloudflare_whoami`.
- **All cost-incurring operations require HITL approval** — `cloudflare_register_domain`
  is the only one. DNS edits, deploys, and tunnel creation are free.
- **Hard caps** — `CLOUDFLARE_MAX_DOMAIN_PRICE_USD` (default $50) and
  `CLOUDFLARE_MAX_REGISTRATION_YEARS` (default 5) reject proposals at the host
  level. Bump them in `.env` to raise the ceiling.
- **30-minute token expiry** — pending proposals auto-expire and the response
  is returned as `{ success: false, message: "Approval token expired …" }`.
- **Per-domain dedup** — proposing a second registration for the same domain
  replaces the earlier proposal.
- **Audit log** — every decision (approved / rejected / errored / expired) is
  appended to `data/audit/cloudflare-domains/`.

## Testing

```
npx vitest run src/__tests__/cloudflare-client.test.ts \
               src/__tests__/cloudflare-domain-gate.test.ts
```

19 unit tests cover the HTTP client (with stubbed `fetch`) and the
`DomainPurchaseGate` lifecycle (validation, approval, rejection, error
handling, expiry, dedup, message formatting). No real Cloudflare API calls
are made during tests.

## Known Limitations

| What you might want | Why it doesn't work | Workaround |
|---------------------|---------------------|------------|
| Agent signs up for a new Cloudflare account | No public API for signup | Manual one-time signup at dashboard |
| Agent registers a `.io` for $35/year | Default cap is $50 — under it | Just works |
| Agent registers a `.dev` for $80/year | Exceeds default $50 cap | Raise `CLOUDFLARE_MAX_DOMAIN_PRICE_USD` |
| Agent uploads HTML files to Pages | Direct Upload API is multi-step | Use `wrangler pages deploy <dir>` after `cloudflare_deploy_pages` |
| Agent starts a cloudflared tunnel | Daemon must run on host | Tool creates the tunnel; user runs `cloudflared tunnel run` |
