# Page Pulse

A production-grade URL audit service. Give it a URL; it returns a health report:
reachability, HTTP status, redirect chain, response timing, transport security,
security-header coverage, and lightweight on-page (SEO) signals.

Built as a MERN application:

- **server/** — Express + Node API (the audit engine)
- **client/** — React (Vite) front end that calls the API
- **MongoDB** — durable, shared cache of audit results (TTL-expired)

---

## Why it's built this way (the short version)

The core problem is that auditing arbitrary user-supplied URLs means making outbound
requests whose latency and behaviour we don't control. Every design choice flows from
that: aggressive timeouts, a bounded concurrency limiter, SSRF protection on every
redirect hop, a cache so repeat audits are instant, and per-client rate limiting so one
caller can't starve the rest. Persistence sits behind a small store interface with an
in-memory implementation, which keeps the whole test suite hermetic (no database needed
in CI) while production uses MongoDB. The full reasoning for the scale version is in
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## Quick start

### Requirements
- Node.js ≥ 20
- (Optional) MongoDB — omit it and the API uses an in-memory cache

### Run the API
```bash
cd server
cp .env.example .env      # optional; sensible defaults are baked in
npm install
npm start                 # http://localhost:8080
```

### Run the client
```bash
cd client
npm install
npm run dev               # http://localhost:5173 (proxies /v1 -> :8080)
```

### Run everything with Docker (API + MongoDB)
```bash
docker compose up --build   # API on http://localhost:8080 with Mongo
```

---

## Configuration

All configuration is via environment variables with production-ready defaults
(see `server/.env.example`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `MONGODB_URI` | *(empty)* | Mongo connection string. Empty ⇒ in-memory cache |
| `AUDIT_TIMEOUT_MS` | `8000` | Timeout per outbound request hop |
| `AUDIT_MAX_REDIRECTS` | `5` | Redirect hops allowed before failing |
| `AUDIT_MAX_RESPONSE_BYTES` | `2000000` | Body bytes read before truncation |
| `AUDIT_MAX_CONCURRENCY` | `20` | Max simultaneous outbound audits |
| `AUDIT_ACQUIRE_TIMEOUT_MS` | `4000` | Max wait for a concurrency slot before 503 |
| `AUDIT_ALLOW_PRIVATE_IPS` | `false` | Disable SSRF blocking (dev only) |
| `CACHE_TTL_MS` | `60000` | Cache window — repeat audits served without refetch |
| `CACHE_MAX_ENTRIES` | `5000` | In-memory store bound (LRU eviction) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window |
| `RATE_LIMIT_MAX` | `60` | Requests per window per client |

---

## API contract

Base path: `/v1`. All responses are JSON.

### `POST /v1/audit`
Audit a URL.

**Request body**
```json
{ "url": "https://example.com" }
```

`GET /v1/audit?url=https://example.com` is also supported.
Add `?refresh=true` to bypass the cache read (result is still cached afterward).

**Headers**
| Header | Purpose |
| --- | --- |
| `X-Api-Key` | Optional. If present, rate limiting is keyed per API key instead of per IP. |
| `X-Request-Id` | Optional. Echoed back for correlation; generated if omitted. |

**200 response**
```json
{
  "data": {
    "requestedUrl": "https://example.com/",
    "finalUrl": "https://example.com/",
    "reachable": true,
    "statusCode": 200,
    "ok": true,
    "redirectCount": 0,
    "redirectChain": [],
    "timing": { "totalMs": 142 },
    "transport": { "https": true },
    "response": {
      "contentType": "text/html; charset=utf-8",
      "contentLengthBytes": 1256,
      "bodyTruncated": false,
      "server": "nginx"
    },
    "securityHeaders": {
      "hsts": true, "csp": false, "xContentTypeOptions": true,
      "xFrameOptions": true, "referrerPolicy": false, "permissionsPolicy": false
    },
    "seo": {
      "isHtml": true, "title": "Example Domain", "titleLength": 14,
      "metaDescription": null, "h1Count": 1
    },
    "auditedAt": "2026-01-01T00:00:00.000Z",
    "cached": false
  },
  "meta": { "requestId": "…", "cache": { "hit": false, "ttlMs": 60000 } }
}
```

**Response headers**
- `X-Cache: HIT | MISS | BYPASS`
- `X-Request-Id: <id>`
- `RateLimit-*` (remaining budget)

### `GET /healthz`
Liveness. Returns `200 { "status": "ok", "uptimeSec": N }`. Never touches dependencies.

### `GET /readyz`
Readiness. `200` when the store is reachable, `503` when degraded. Includes concurrency stats.

### Error envelope
Every error uses the same shape and a stable `code`:
```json
{ "error": { "code": "INVALID_URL", "message": "…", "requestId": "…" } }
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| `INVALID_URL` | 400 | Missing/malformed URL or unsupported protocol |
| `BLOCKED_TARGET` | 403 | Host resolves to a private/reserved range (SSRF guard) |
| `UPSTREAM_TIMEOUT` | 504 | Target did not respond within the timeout |
| `UPSTREAM_UNREACHABLE` | 502 | DNS/connection failure |
| `TOO_MANY_REDIRECTS` | 502 | Redirect limit exceeded |
| `CAPACITY_EXCEEDED` | 503 | No concurrency slot available in time |
| `RATE_LIMITED` | 429 | Per-client rate limit exceeded |
| `NOT_FOUND` | 404 | Unknown route |
| `INTERNAL` | 500 | Unexpected error (details are logged, not returned) |

---

## How this meets the "production, not demo" bar

| Requirement | Where |
| --- | --- |
| Input validation | `services/ssrf.js` (`parseAndValidateUrl`) + early route validation |
| Request timeouts | `services/auditor.js` — `AbortController` per hop |
| Concurrency limits | `services/concurrency.js` — bounded semaphore, fail-fast 503 |
| Structured error responses | `errors.js` + `middleware/errorHandler.js` |
| Configurable cache window | `stores/*` + `CACHE_TTL_MS`; `X-Cache` header |
| Per-client rate limiting | `middleware/rateLimit.js` (keyed by API key or IP) |
| Structured logging + request IDs | `middleware/logging.js` (pino + `X-Request-Id`) |
| Test suite | `server/test/*` — 33 tests, hermetic (no network/DB) |
| CI on every push | `.github/workflows/ci.yml` |
| **SSRF protection** | `services/ssrf.js` — private-range block, re-checked per redirect hop |

---

## Testing & CI

```bash
cd server && npm test      # 33 tests: unit + supertest integration
cd server && npm run lint  # eslint, zero warnings
cd client && npm run build # production build
```

CI (`.github/workflows/ci.yml`) lints and tests the server and builds the client on
every push and pull request. Tests inject fakes for the network and use the in-memory
store, so they're fast and deterministic — no live site or database required.

> **Note on `npm audit`:** the only advisories are in the dev-only test toolchain
> (`vitest → vite → esbuild`). They are not part of the production runtime shipped in the
> Docker image (`npm ci --omit=dev`).

---

## Deployment

The API is a stateless container — deploy it anywhere that runs Docker (Render, Railway,
Fly.io, ECS, etc.) and point `MONGODB_URI` at a managed MongoDB (e.g. Atlas). The client
is static — build it (`npm run build`) and host on any static/CDN provider, or serve it
same-origin in front of the API so `/v1` calls need no CORS. Set `VITE_API_BASE_URL` if
the client and API live on different origins.

---

## AI usage

AI assistance (Claude) was used to scaffold the Express API and React client, generate the
initial test suite, and produce the first drafts of this README and the architecture
document. I reviewed the result, ran the test suite and a live audit myself to confirm the
behaviour, and worked through each component — the SSRF guard, the fail-fast concurrency
limiter, the pluggable cache store, and the technology tradeoffs in `ARCHITECTURE.md` — so
I can explain and defend every design decision.

---

Built for [Digital Heroes Training Task](https://digitalheroesco.com).
