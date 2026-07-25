# Page Pulse at Scale — Architecture

**Target:** 10,000 audits/day, bursts of **500 concurrent** requests, a customer-facing
**response-time SLA**.

---

## 1. The shape of the problem

Average load is small: 10,000/day is ~0.12 audits/sec. The design is **not** driven by
throughput — it's driven by two things:

1. **Burst concurrency (500 at once).** Peaks are ~4,000× the average, so the system must
   absorb spikes without falling over or blowing the SLA.
2. **We don't control the target.** Each audit makes an outbound request to an arbitrary
   site that may be slow, hostile, or down. If we answer audits synchronously, our tail
   latency is hostage to the slowest target. **This is the central tension** and the SLA
   is what forces the answer.

The resolution is a **cache-first, queue-backed hybrid**: serve the common case (repeat
audits) instantly from cache, and decouple cache-miss work from the request via a queue
and a bounded worker pool so a burst becomes queue depth, not 500 stalled sockets.

---

## 2. Architecture overview

![Page Pulse architecture: clients reach stateless API instances through a load
balancer; the API reads/writes a Redis hot cache and enqueues cache-miss jobs; a
stateless auditor worker pool drains the queue, fetches the target site, and writes
results to MongoDB while warming the cache. Green = stateless compute, amber = stateful
stores, grey = external.](docs/architecture.png)

*Green boxes are stateless compute (scale horizontally); amber ◆ boxes are the only
places state lives; grey is external and untrusted.*

**Request flow**

1. **Cache hit (the common path).** API validates, checks Redis (hot) then Mongo
   (durable). A fresh result is returned immediately — comfortably inside the SLA.
2. **Cache miss.** The API enqueues an audit job and returns `202 Accepted` with a
   `jobId` and a `Location` to poll (or a callback/webhook for bulk clients). Workers
   process the queue; the result lands in Mongo + Redis; the poll then returns it.
   Because the SLA is on *our* acknowledgement, not on an unknown third party, we can
   meet it even when a target takes 30s or never responds.

For interactive single-URL use where clients expect a synchronous answer, a **fast
synchronous path** is retained for cache misses, guarded by the concurrency limiter and a
tight timeout; if no worker slot is free within the budget it degrades to the async `202`
path rather than blocking.

---

## 3. Component responsibilities & where state lives

Read each component as: **what it does** and **what state it holds**.

**Load balancer / API gateway** — *stateless.*
Terminates TLS, applies a coarse outer throttle, and routes only to healthy instances.
Holds no application state.

**API instances** — *stateless.*
Validate input, run the SSRF check, apply per-client rate limits, look in the cache, and
either return a hit or enqueue a job. Any instance can serve any request, so they scale
out horizontally and can be replaced or rolled back freely.
*State held: none.*

**Auditor worker pool** — *stateless.*
Drain the job queue and run the actual audit: outbound fetch with a timeout, redirect +
SSRF re-checks on every hop, body-size cap. Persist the result and warm the cache. Scales
independently of the API (add workers when the queue backs up).
*State held: none (only in-flight jobs, which live in the queue).*

**Redis** — *stateful.*
The fast, shared layer: the **hot cache** (sub-millisecond reads), the **rate-limit
counters** (shared so limits are global across instances), and the **job queue**.

**MongoDB** — *stateful.*
The durable record: **audit results and history**, expired automatically by a **TTL
index** set to the cache window.

**Target sites** — *external, untrusted.*
The pages being audited. Latency and behaviour are outside our control — the reason for
timeouts, the circuit breaker, and the async path.

> **Where state lives, in one line:** only in **Redis** (hot/ephemeral) and **MongoDB**
> (durable). Nothing stateful sits on an API or worker instance — which is exactly what
> makes horizontal scaling and one-command rollback safe (§6).

---

## 4. Technology decision record

Each decision names the alternative rejected and why.

**API tier — Node/Express.**
Chosen for excellent I/O-bound concurrency (audits are almost all waiting on the network),
fast iteration, and a shared JS/JSON toolchain with the React client.
*Rejected:* **Go** — better raw concurrency and lower memory per connection, but slower to
iterate and less aligned with a JS-centric team; the bottleneck here is target latency,
not CPU, so Node's model is sufficient. *Also rejected:* Python/FastAPI — fine, but the
Node↔React shared stack tipped it.

**Queue — Redis + BullMQ.**
Chosen because we already run Redis (for cache and rate limiting), so it adds no new
infrastructure, and BullMQ gives retries, backoff, delayed jobs, and concurrency control
out of the box. At 10k/day the volume is tiny for Redis.
*Rejected:* **Kafka** — built for high-throughput event streaming and replay we don't
need; operationally heavy for this scale. *Rejected:* **SQS** — a good managed option (and
the choice if we standardise on AWS), but it locks us to a cloud and we'd still want Redis
anyway.

**Durable store — MongoDB (+ Redis hot cache).**
Audit results are a flexible, evolving document; Mongo's schema flexibility and a native
**TTL index** for cache expiry fit well. Redis fronts it as a hot cache for the tightest
latency.
*Rejected:* **Postgres** — strong choice, but the audit shape changes as we add checks and
we don't need relational joins or transactions here. *Rejected:* **Redis-only** — not
durable enough for history/analytics and expensive to hold everything in memory.

**Rate limiting — Redis-backed, shared across instances.**
A per-instance limiter is meaningless once traffic is spread across N instances by the LB.
*Rejected:* **gateway-only throttling** — necessary as a coarse outer layer, but it can't
express per-API-key budgets or the per-audit *concurrency* limit the workers need.

**Concurrency control — bounded worker pool + per-target circuit breaker.**
The pool caps simultaneous outbound requests; the breaker stops hammering a target that is
timing out.
*Rejected:* **unbounded async fan-out** — a 500-burst against slow targets would exhaust
sockets/file descriptors and memory; bounding + shedding is the resilient choice.

---

## 5. Failure mode analysis

The three most likely failures **at this scale**, with mitigations.

### 5.1 Slow or hostile targets exhaust the worker pool (head-of-line blocking)
*Most likely and most damaging.* A batch of URLs pointing at slow/hanging hosts ties up
every worker; healthy audits queue behind them and the SLA breaks.
**Mitigations:** hard per-hop timeout (already implemented); bounded worker concurrency so
damage is contained; a **per-target-host circuit breaker** that fast-fails hosts currently
timing out; queue backpressure so overflow becomes `202`/`503` (shed load) rather than
unbounded latency; response-body byte cap to prevent memory blowups from huge pages.

### 5.2 A datastore degrades (Redis or Mongo slow/unavailable)
Redis down ⇒ no cache and (naively) no rate limiting; Mongo down ⇒ no durable results.
**Mitigations:** **cache fail-open** — treat cache errors as a miss and proceed, so a Redis
blip degrades performance, not availability; **rate-limit fail-safe** with an explicit,
documented policy (fail-open to protect availability, with the gateway's coarse limit as a
backstop); short connection/pool timeouts so a slow store doesn't cascade into request
pile-up; `/readyz` reflects store health so the LB pulls unhealthy instances; Redis in HA
(replica + sentinel) and Mongo as a replica set.

### 5.3 Traffic burst beyond provisioned capacity (the 500-spike, or worse)
A spike larger than the worker pool can drain, or an abusive client.
**Mitigations:** per-client rate limiting (implemented); a **bounded queue** that sheds
load with `503 CAPACITY_EXCEEDED` once full, keeping accepted work fast rather than making
everything slow; **autoscaling workers on queue depth / oldest-job-age**; SSRF guard and a
redirect cap to blunt amplification/DoS via the auditor itself.

---

## 6. Observability & rollback

### What we monitor
- **RED per endpoint:** request Rate, Error rate, Duration (p50/p95/**p99** — the SLA is a
  tail metric, so p99 is the one that matters).
- **Audit outcomes:** success / timeout / unreachable / blocked / too-many-redirects.
- **Cache hit ratio** — the leading indicator of SLA health; a drop precedes latency pain.
- **Queue depth and oldest-job age** — the earliest signal of falling behind.
- **Worker saturation** — time spent at max concurrency; sustained saturation = scale up.
- **Outbound audit latency distribution**, DNS failure rate, SSRF blocks, rate-limit
  rejections.
- **Dependency health:** Redis/Mongo latency, errors, connection-pool saturation.

Every request already carries a **request ID** in structured logs; extend this to
**distributed tracing** (OpenTelemetry) spanning API → queue → worker so a slow audit is
traceable end to end.

### What we alert on
- p99 latency over SLA for N consecutive minutes (page).
- Error rate above threshold, or a spike in `5xx`.
- Queue oldest-job-age climbing / depth beyond a ceiling (workers falling behind).
- Cache hit ratio dropping sharply.
- `/readyz` failing or instances flapping.
- Redis/Mongo connection errors or latency breach.

### Deploy & rollback
- **Immutable, versioned images**; deploy via **canary** — shift a small % of traffic,
  watch error rate and p99 against the baseline, and **auto-abort** if they regress.
- **Post-deploy smoke test:** hit `/readyz` and run a synthetic audit before widening.
- **Backward-compatible schema changes only** (expand/contract): the new version writes
  data the old version can still read, so rollback never strands data. **Version queue job
  payloads** so old and new workers can drain the same queue during a rollout.
- **Rollback = redeploy the previous image tag.** Because the API and workers are stateless
  and all state is in Redis/Mongo, this is safe and fast; the cache self-heals via TTL.
- **Feature-flag** risky changes (e.g. a new audit check) so they can be disabled without a
  redeploy.

---

Built for [Digital Heroes Training Task](https://digitalheroesco.com).
