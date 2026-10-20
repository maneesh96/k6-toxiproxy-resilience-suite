# Watching the circuit breaker and reading per-phase SLOs

## What the gateway exposes

`GET /metrics` on the API gateway (port 3000) is a Prometheus scrape endpoint.
Next to the default Node.js process metrics it carries the state and events of
the circuit breaker in front of the product service (`/products/resilient`):

| Metric | Type | Meaning |
| :--- | :--- | :--- |
| `gateway_circuit_breaker_state{breaker="product_service"}` | gauge | `0` closed, `1` half-open, `2` open |
| `gateway_circuit_breaker_events_total{breaker="product_service",event=...}` | counter | events since the gateway started |

Events: `success`, `failure` (timeouts included), `timeout` (slower than the
800 ms breaker timeout), `reject` (short-circuited while open), `fallback`
(degraded payload served), and the transitions `open`, `halfOpen`, `close`.
Every series starts at 0, so the first scrape already lists all of them.

The naive path (`/products/naive`) does not go through the breaker, so its
counters only move during phase 4.

## Watching it live

Start the stack and keep it up after a run:

```sh
cp .env.example .env
KEEP_STACK_UP=1 npm run suite
```

In a second terminal, while phase 4 runs:

```sh
watch -n 1 "curl -s http://localhost:3000/metrics | grep '^gateway_circuit_breaker'"
```

Expected sequence in phase 4: a burst of `timeout` and `failure` while the
circuit is closed, `open` goes to 1 and the state to `2`, then `reject` and
`fallback` climb with every request. Every 10 s (`resetTimeout`) the state
drops to `1` (half-open) for one trial call; it times out under the latency
toxic and the circuit opens again. Once the toxic is removed, the first
request after the circuit goes half-open succeeds, `close` increments and the
state returns to `0`.

The gateway also logs each transition (`Circuit Breaker OPENED`, `HALF-OPEN`,
`CLOSED`): `docker compose logs -f api-gateway`.

To graph it, point any Prometheus at `api-gateway:3000/metrics` on the
`resilience-network` network; no extra exporter is needed.

## What the suite records

`run-suite.js` scrapes `/metrics` right before and right after each phase's
k6 run. `results/phases.json` stores, per phase, the breaker state at the end
and how often each event fired during that phase. The report shows it in the
"Circuit breaker" row, and phase 4's hypothesis requires at least one `open`
event: a phase 4 that only looks fast without the circuit ever opening is not
counted as a confirmed experiment.

## Per-phase SLOs

Each phase is judged against two sets of k6 thresholds:

- **Baseline SLOs** (`load-test.js`), identical for every phase so phases
  compare: errors < 1%, p95 < 200 ms, p99 < 500 ms, checks > 99%,
  degraded responses < 1%. Chaos phases are expected to breach some of them.
- **Phase SLOs** (`thresholds` per phase in `run-suite.js`): what that phase
  must still guarantee under its fault. They are passed to k6 as
  `PHASE_THRESHOLDS` and set on sub-metrics tagged `suite_phase:<id>`, so k6
  reports them separately from the baseline thresholds on the same metric.

| Phase | Fault | Phase SLOs | Why |
| :--- | :--- | :--- | :--- |
| 1 | none | baseline only | the baseline is this phase's contract |
| 2 | latency 2000 ± 500 ms, naive path | errors < 1%, checks > 99%, p99 < 3000 ms | the slowdown passes through, but the catalog still arrives within the injected 2.5 s worst case plus 500 ms |
| 3 | 10 KB/s + 10-byte slices, naive path | errors < 1%, checks > 99%, p95 < 1000 ms | the ~1 KB catalog costs a few hundred ms on the starved link but must arrive intact |
| 4 | latency 2000 ± 500 ms, resilient path | errors < 1%, p95 < 200 ms, p99 < 1000 ms | the breaker sheds slow calls; p99 is bounded by its 800 ms timeout on the calls made before it opens; degraded responses are expected, so checks are not bounded |

Bounds were set from the measured CI runs (10 VUs) with headroom. Each phase's
hypothesis includes "phase SLOs met", so a regression such as the gateway
adding delay of its own, or the breaker no longer bounding tail latency, turns
that phase's hypothesis to "not confirmed" in the report.
