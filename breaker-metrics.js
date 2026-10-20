// Prometheus metrics for an opossum circuit breaker, and a reader for them.
//
// The gateway registers these on its /metrics registry; run-suite.js scrapes
// /metrics around every phase and records what the breaker did, so the report
// can show that a phase was (or was not) protected by an open circuit.
//
//   gateway_circuit_breaker_state{breaker}          0 = closed, 1 = half-open, 2 = open
//   gateway_circuit_breaker_events_total{breaker,event}
//     success  the downstream call succeeded
//     failure  the downstream call failed (timeouts included)
//     timeout  the call exceeded the breaker timeout
//     reject   short-circuited because the circuit was open
//     fallback the fallback payload was served
//     open / halfOpen / close  state transitions

const promClient = require('prom-client');

const STATE_METRIC = 'gateway_circuit_breaker_state';
const EVENTS_METRIC = 'gateway_circuit_breaker_events_total';
const STATES = ['closed', 'half_open', 'open'];
const EVENTS = ['success', 'failure', 'timeout', 'reject', 'fallback', 'open', 'halfOpen', 'close'];

function stateOf(breaker) {
  if (breaker.opened) return 'open';
  if (breaker.halfOpen) return 'half_open';
  return 'closed';
}

function registerBreakerMetrics(breaker, register, name) {
  const labels = { breaker: name };

  new promClient.Gauge({
    name: STATE_METRIC,
    help: 'Circuit breaker state: 0 = closed, 1 = half-open, 2 = open',
    labelNames: ['breaker'],
    registers: [register],
    collect() {
      this.set(labels, STATES.indexOf(stateOf(breaker)));
    }
  });

  const events = new promClient.Counter({
    name: EVENTS_METRIC,
    help: 'Circuit breaker events by type',
    labelNames: ['breaker', 'event'],
    registers: [register]
  });

  for (const event of EVENTS) {
    // Start every series at 0 so a scrape before the first event already
    // lists it and deltas between two scrapes are always defined.
    events.inc({ ...labels, event }, 0);
    breaker.on(event, () => events.inc({ ...labels, event }));
  }
}

function parseLabels(text) {
  const labels = {};
  for (const match of text.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) {
    labels[match[1]] = match[2];
  }
  return labels;
}

// Reads one breaker's state and event counters out of a Prometheus text
// exposition. Returns null when the breaker is not exposed at all.
function readBreakerMetrics(text, name) {
  let state = null;
  const events = {};

  for (const line of text.split('\n')) {
    const match = line.match(/^(\w+)\{([^}]*)\}\s+(\S+)/);
    if (!match) continue;
    const [, metric, rawLabels, rawValue] = match;
    const labels = parseLabels(rawLabels);
    if (labels.breaker !== name) continue;
    const value = Number(rawValue);

    if (metric === STATE_METRIC) {
      state = STATES[value] || 'unknown';
    } else if (metric === EVENTS_METRIC && labels.event) {
      events[labels.event] = value;
    }
  }

  if (state === null && Object.keys(events).length === 0) return null;
  return { state, events };
}

// What happened between two readings: the state at the end and how many
// times each event fired in between.
function diffBreakerMetrics(before, after) {
  if (!before || !after) return null;
  const events = {};
  for (const event of EVENTS) {
    events[event] = (after.events[event] || 0) - (before.events[event] || 0);
  }
  return { stateBefore: before.state, stateAfter: after.state, events };
}

module.exports = { registerBreakerMetrics, readBreakerMetrics, diffBreakerMetrics, EVENTS, STATES };
