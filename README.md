# freebuff-toolkit

Reverse-engineered toolchain for **freebuff.com** (the codebuff.com free tier):
mass account registration via GitHub OAuth, CLI-token extraction, and an
OpenAI-compatible gateway on top of the free model pool.

Built 2026-10-08 against the **limited tier** (`accessTier: limited`).
Everything below was verified end-to-end: 1 account registered from a
172-account GH pool, CLI token extracted, gateway serving 55 models.

```
GH pool ──► reg.py ──► freebuff_accounts.jsonl (session cookies)
                              │
                              ▼
                    extract_cli_token.py ──► auth_tokens.jsonl (CLI authToken)
                              │
                              ▼
                    gateway/ (Node) ──► OpenAI-compatible API on :8789
                              │
                              ▼
              any OpenAI client (curl, Python SDK, ChatBox, …)
```

## Pieces

| File / dir | What it is |
|---|---|
| `reg.py` | Mass reger: GH pool → Turnstile → NextAuth GitHub OAuth (+TOTP 2FA) → freebuff session cookies → `freebuff_accounts.jsonl` |
| `extract_cli_token.py` | Freebuff/GitHub session → codebuff CLI `authToken` (the token the gateway eats) → `auth_tokens.jsonl` |
| `gateway/` | OpenAI-compatible gateway (wintopic/FreeBuff2API fork, Node): token pool rotation, dynamic model catalog, `/v1/chat/completions`, admin panel |
| `gh_accounts.example.json` | Pool file format |

## Prerequisites

- Python 3.10+ — `pip install -r requirements.txt` (`requests`, `pyotp`)
- Node 18+ for the gateway
- A **GitHub account pool**: JSON array of
  `{login, email, password, totp}` (see `gh_accounts.example.json`).
  Accounts must be **fresh and unflagged** — spam-flagged GH accounts fail
  OAuth with *"cannot authorize third party application"* (~60% of a farmed
  pool in our test). `totp` = base32 2FA secret; enable TOTP 2FA on each GH
  account beforehand or the login step dies.
- A **Cloudflare Turnstile solver**. freebuff gates signup with Turnstile
  (sitekey `0x4AAAAAACvi5pdE5_cnLWnI`) submitted to
  `POST /api/auth/signup-challenge`. The scripts call a local sidecar:

  ```
  POST http://127.0.0.1:8877/solve
  {"type": "turnstile", "sitekey": "0x4AAAAAACvi5pdE5_cnLWnI",
   "url": "https://freebuff.com/login", "real_page": true}
  → {"token": "0.xxxx"}     (takes ~13 s)
  ```

  Any solver that produces a real-page Turnstile token works
  (browser-based solvers, 2captcha `TurnstileTaskProxyless`, etc.).
  Point the scripts at yours via the `FB_SIDECAR` env var, or replace
  `solve_turnstile()`.

## Quick start

### 1. Register accounts

```bash
cp gh_accounts.example.json gh_accounts.json   # fill with your pool
python reg.py 5            # reg up to 5 accounts
# output: freebuff_accounts.jsonl  (one JSON per line: login, session, cookies)
# state.json tracks tried logins — reruns skip them
```

Typical per-account outcome: `OK` / `FLAGGED` (GH spam-flagged) /
`FAIL` (empty fb session, 502, checkup page). ~1 usable account per
10–20 pool entries on a farmed pool; much better with clean accounts.

### 2. Extract the CLI token

The gateway authenticates upstream with a **codebuff CLI authToken**, not the
web session cookie:

```bash
python extract_cli_token.py               # next untried pool account
python extract_cli_token.py --login mygh  # specific account
# output: auth_tokens.jsonl  → {"login": …, "authToken": "<36 chars>"}
```

### 3. Run the gateway

```bash
cd gateway
npm install
mkdir -p credentials
cat > credentials/freebuff_credentials.json <<'EOF'
{"accounts": {"acc1": {"email": "x@y.z", "authToken": "<token>"}}}
EOF
PORT=8789 HOST=127.0.0.1 node server.js
```

Verify:

```bash
curl http://127.0.0.1:8789/healthz
curl -H "Authorization: Bearer freebuff-default-key" http://127.0.0.1:8789/v1/models
# → 55 models (dynamic catalog re-pulled from CodebuffAI/freebuff TS sources every 6 h)
```

### 4. Chat

```bash
curl http://127.0.0.1:8789/v1/chat/completions \
  -H "Authorization: Bearer freebuff-default-key" -H "Content-Type: application/json" \
  -d '{"model":"mimo/mimo-v2.5","messages":[{"role":"user","content":"Say OK"}]}'
```

or from Python:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8789/v1", api_key="freebuff-default-key")
print(client.chat.completions.create(model="mimo/mimo-v2.5",
      messages=[{"role": "user", "content": "Say OK"}]).choices[0].message.content)
```

Any OpenAI-compatible client works (ChatBox, OpenWebUI, LangChain, …) —
just set base URL `http://127.0.0.1:8789/v1` and key `freebuff-default-key`
(or configure your own). Multiple tokens in `credentials/` are rotated by the
gateway automatically. Admin panel: `http://127.0.0.1:8789/admin`.

## Access tiers — how to get the good models

This is the part most people get wrong. From the upstream sources
(`freebuff-models.ts`):

- **Tier is resolved SERVER-SIDE from the country of the request IP**,
  per request — never from anything the client sends, and *not* pinned to
  the account. Fails closed: unresolvable country = non-US = paywall.
- **US IP → `accessTier: full`** → premium pool opens:
  **Claude Haiku 5.5, Claude Fable 5.1, Opus 5.5, GPT-6 Luna/Sol,
  Gemini 3.8 Flash** — free, but drawn from a shared premium pool
  (~4–5 free premium sessions/day, reset Pacific).
  GPT-6.1 Sol is US-or-paid only.
- **Non-US → `accessTier: limited`** → hard-coded catalog
  (`LIMITED_FREEBUFF_MODEL_IDS`): MiMo 2.6 Flash (wire id `mimo/mimo-v2.5`),
  GLM 5.3 Flash, DeepSeek V4 Flash, Solar Mini/Pro 4.
  Haiku 5.5 shows up in `/api/workspace/models` as `access: locked,
  premium: true` — it is *visible* but not usable.
- **Rate limits (limited):** ~6 requests/day per model per account,
  `pacific_day` reset. N accounts in the gateway pool → ~6N/day.
- Referrals/streaks only add reward *sessions* (GLM), never premium models.
- There is **no client-side bypass**: `FREEBUFF_FORCE_LIMITED_MODE` is a
  server debug flag; country never comes from the client.

**Practical consequence:** since tier is computed per request, you do **not**
need to re-register — route the session/chat requests through a **US
residential proxy** and the same token starts returning `accessTier: full`.
Verify with:

```bash
curl -H "Authorization: Bearer freebuff-default-key" \
     https://www.codebuff.com/api/v1/freebuff/session
# accessTier: limited  → full when the egress IP is US
```

The gateway supports a **per-account proxy**: add a `"proxy"` field to the
credential entry and start with `FREE_PROXY_ACCOUNTS=1`:

```json
{"accounts": {"acc1": {"email": "x@y.z", "authToken": "<token>",
  "proxy": "http://user:pass@us-residential:port"}}}
```

```bash
FREE_PROXY_ACCOUNTS=1 PORT=8789 HOST=127.0.0.1 node server.js
```

## The protocol (reverse-engineered)

### Auth
- freebuff.com login = **NextAuth v4 + GitHub OAuth only** (no email/password).
- **Cloudflare Turnstile** gate: sitekey `0x4AAAAAACvi5pdE5_cnLWnI`,
  submitted to `POST /api/auth/signup-challenge {"token": …}`.
- Flow: `/api/auth/csrf` → `POST /api/auth/signin/github {csrfToken,
  callbackUrl, json:true}` → GitHub authorize (login form + TOTP 2FA)
  → OAuth consent page → callback → `__Secure-next-auth.session-token`
  cookie = the freebuff session.

### CLI token (what the gateway needs)
1. `POST https://www.codebuff.com/api/auth/cli/code
   {"fingerprintId": "codebuff-cli-<hex8>"}`
   → `{loginUrl (…auth_code=…), fingerprintHash, expiresAt}`
2. OAuth into codebuff.com with `callbackUrl = loginUrl`
   (callback 301s to the `www` host — follow it).
3. `GET /onboard?auth_code=…` — page holds a Next.js **RSC server action**
   form `CliLoginApproval`, `encType="multipart/form-data"`.
4. POST **all** hidden `<input>` fields (`$ACTION_KEY`, `$ACTION_ID_*`,
   `auth_code`, …) as multipart. Partial field sets silently fail;
   urlencoded instead of multipart fails too.
5. Poll `GET /api/auth/cli/status?fingerprintId=…&fingerprintHash=…&expiresAt=…`
   → `{authToken}` (36 chars).

### Upstream chat
- `GET/POST /api/v1/freebuff/session` — **single-session lock**: switching
  model requires `DELETE /api/v1/freebuff/session` (with header
  `x-freebuff-instance-id`) first, else `409 model_locked`. On limited tier
  the session model is *always* forced to `deepseek/deepseek-v4-flash`
  regardless of what you request.
- `POST /api/v1/agent-runs {action:"START", agentId:"base2-free-<vendor>"}`
  → runId. Wrong agent/model pair → `403 free_mode_invalid_agent_model`.
- `POST /api/v1/chat/completions` with `codebuff_metadata`
  (freebuff_instance_id, trace_session_id, run_id,
  client_id `freebuff-cli-*`, cost_mode `free`) + header
  `x-freebuff-instance-id` + UA
  `ai-sdk/openai-compatible/1.0.25/codebuff`.
- **`403 free_mode_cli_required`** unless the first system message starts
  byte-exact with `You are Buffy, the strategic coding assistant.` — the
  gateway injects this automatically.
- Model catalog: `GET https://freebuff.com/api/workspace/models`
  (13 rows on limited tier, version `v0.g1.e82938.limited.7`).
- Quotas: `GET /api/v1/usage` (freebucks, 25 on signup);
  `GET /api/v1/freebuff/session` with header
  `x-freebuff-include-unused-rate-limits: 1` → `rateLimitsByModel`
  (e.g. `mimo/mimo-v2.5` 2.4/6, reset 07:00 PT).

## Operational risks (read before farming)

Harvested from upstream issue trackers (pingmike2 #24/#26/#27, lza6 #2) —
this is what actually bites people in production:

- **Ban waves are real.** Users report mass suspensions, including
  barely-used accounts, on both Cloudflare Workers *and* self-hosted
  Docker/VPS. Symptom: `create session failed: 403 {"status":"banned"}`.
  A banned token is dead — remove it from the pool and rotate.
- **Cloudflare Workers deployments are actively detected.** Upstream added
  a CF-egress fingerprinting module (`cf-worker-signals.ts`): `cf-worker` /
  `cf-ray` headers (added by the CF edge, cannot be removed in code),
  Worker zone signatures, `wf-*` client_id formats → observe/block/ban.
  **Do not deploy the gateway on Cloudflare Workers.** Run it on your own
  VPS/Docker/home machine.
- **Keep usage looking human.** Bursty 24/7 traffic from datacenter IPs is
  the ban pattern. Low volume, residential IP, and per-account proxies
  (`FREE_PROXY_ACCOUNTS=1`) materially reduce risk. Don't share one token
  across a team.
- **Agent-id migration (base2 → base3).** Upstream periodically renames
  free agents (`base2-free-*` → `base3-free-*`). Stale agent ids return
  `403 free_mode_invalid_agent_model` for almost every model. This fork
  pulls the catalog dynamically every 6 h — keep the gateway updated and
  restart it after upstream releases.
- **429 = daily quota burned**, not a bug:
  `Rate limit exceeded: free-models-per-day-high-balance`. Resets daily
  (Pacific). Tool-call requests count against the same pool. With N tokens
  the gateway rotates; a 429'd token parks until reset.
- **Requested model may be silently swapped.** On limited tier the session
  always resolves to `deepseek/deepseek-v4-flash`; older static catalogs
  also mismatched ds→mimo. Trust `GET /api/v1/freebuff/session` `model`
  field, not your request body.
- **Tokens are long-lived** — no daily re-extraction needed. They stay
  valid as long as the account lives (don't log the GH account out /
  rotate its credentials).
- **Value drift:** upstream users note free-pool value dropping
  (deepseek-pro removed from free, flash models increasingly
  night-only / 503). Treat this as a bonus capacity source, not a primary.

## Error reference

| Symptom | Meaning / fix |
|---|---|
| `409 model_locked` | Session pinned to another model. DELETE session (with `x-freebuff-instance-id`) then re-create. |
| `403 free_mode_cli_required` | Missing CLI fingerprint: system prompt must start with `You are Buffy, the strategic coding assistant.`, UA must be `ai-sdk/openai-compatible/1.0.25/codebuff`, metadata `client_id` must be `freebuff-cli-*`. |
| `403 free_mode_invalid_agent_model` | agentId doesn't match the session's assigned model (limited tier always assigns deepseek → use `base2-free-deepseek-flash`). |
| `503 The model is temporarily unavailable` | Upstream outage for the free-tier model — nothing client-side; retry later. |
| `409 chat_moved` | You're hitting the legacy codebuff chat path; chat moved to the new freebuff workspace API. |
| `unsupported_model` from gateway | Model not in the gateway catalog (stale `freebuff-models.json` or premium-only id on limited tier). |
| *"cannot authorize third party application"* on GH | Account spam-flagged — unusable, skip it. |
| empty fb session after OAuth | GH flagged or OAuth consent silently refused — skip account. |
| `StopIteration` in extract | Pool exhausted (all logins in `cli_state.json`). |
| `403 {"status":"banned"}` on session create | Account suspended (ban wave). Token is dead — delete from credentials, rotate pool. |
| `429 free-models-per-day-high-balance` | Daily quota burned (tool calls count too). Wait for Pacific reset or switch token. |

## Known limits

- GH pool yield: ~60% of farmed accounts hit *"cannot authorize third party
  application"*, ~40% return an empty session. Fresh, unflagged GitHub
  accounts required for scale.
- Limited tier = ~6 free requests/day per model (`pacific_day` reset).
  Pool of N accounts → ~6N/day.
- Mass-registering accounts does **not** upgrade the tier — tier is
  geo-based per request (see above). Accounts only multiply limited-tier
  quota.
- At build time the limited-tier upstream model
  (`deepseek/deepseek-v4-flash`) was returning 503 for extended periods;
  the gateway surfaces it as-is.

## Credits

Gateway: fork of [wintopic/FreeBuff2API](https://github.com/wintopic/FreeBuff2API)
(itself from [pingmike2/freebuff2api-wokers](https://github.com/pingmike2/freebuff2api-wokers)),
patched: un-paused `deepseek/deepseek-v4-flash`, Buffy system-prompt injection.
Farmer reference: [senastor/freebuff-farmer](https://github.com/senastor/freebuff-farmer).
Rust alternative (older protocol): [lza6/Freebuff-2API](https://github.com/lza6/Freebuff-2API).
