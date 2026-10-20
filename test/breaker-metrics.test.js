const { test } = require('node:test');
const assert = require('node:assert/strict');
const CircuitBreaker = require('opossum');
const promClient = require('prom-client');

const { registerBreakerMetrics, readBreakerMetrics, diffBreakerMetrics } = require('../breaker-metrics');

const EXPOSITION = [
  '# HELP gateway_circuit_breaker_state Circuit breaker state: 0 = closed, 1 = half-open, 2 = open',
  '# TYPE gateway_circuit_breaker_state gauge',
  'gateway_circuit_breaker_state{breaker="product_service"} 2',
  'gateway_circuit_breaker_state{breaker="other"} 0',
  '# TYPE gateway_circuit_breaker_events_total counter',
  'gateway_circuit_breaker_events_total{breaker="product_service",event="open"} 1',
  'gateway_circuit_breaker_events_total{breaker="product_service",event="reject"} 42',
  'gateway_circuit_breaker_events_total{breaker="other",event="reject"} 7',
  'process_cpu_seconds_total 0.5'
].join('\n');

// A breaker that trips after a single failure, with metrics on its own registry.
function instrumentedBreaker(action) {
  const breaker = new CircuitBreaker(action, {
    name: 'product_service',
    timeout: 100,
    errorThresholdPercentage: 50,
    volumeThreshold: 1,
    resetTimeout: 5000
  });
  breaker.fallback(() => 'fallback');
  const register = new promClient.Registry();
  registerBreakerMetrics(breaker, register, breaker.name);
  const read = async () => readBreakerMetrics(await register.metrics(), breaker.name);
  return { breaker, read };
}

test('readBreakerMetrics picks the named breaker out of a Prometheus exposition', () => {
  assert.deepEqual(readBreakerMetrics(EXPOSITION, 'product_service'), {
    state: 'open',
    events: { open: 1, reject: 42 }
  });
});

test('readBreakerMetrics returns null for a breaker that is not exposed', () => {
  assert.equal(readBreakerMetrics(EXPOSITION, 'missing'), null);
  assert.equal(readBreakerMetrics('', 'product_service'), null);
});

test('diffBreakerMetrics counts events between two readings', () => {
  const before = { state: 'closed', events: { open: 0, reject: 5 } };
  const after = { state: 'open', events: { open: 1, reject: 47, fallback: 40 } };
  const diff = diffBreakerMetrics(before, after);
  assert.equal(diff.stateBefore, 'closed');
  assert.equal(diff.stateAfter, 'open');
  assert.equal(diff.events.open, 1);
  assert.equal(diff.events.reject, 42);
  assert.equal(diff.events.fallback, 40);
  assert.equal(diff.events.success, 0);
});

test('diffBreakerMetrics is null when a reading is missing', () => {
  assert.equal(diffBreakerMetrics(null, { state: 'open', events: {} }), null);
});

test('a fresh breaker is exposed as closed with every event at zero', async () => {
  const { breaker, read } = instrumentedBreaker(async () => 'ok');
  try {
    const reading = await read();
    assert.equal(reading.state, 'closed');
    assert.equal(reading.events.open, 0);
    assert.equal(reading.events.fallback, 0);
    assert.equal(Object.keys(reading.events).length, 8);
  } finally {
    breaker.shutdown();
  }
});

test('the exposed state and events follow the breaker through a trip', async () => {
  const { breaker, read } = instrumentedBreaker(async () => {
    throw new Error('downstream down');
  });
  try {
    assert.equal(await breaker.fire(), 'fallback');
    const tripped = await read();
    assert.equal(tripped.state, 'open');
    assert.equal(tripped.events.failure, 1);
    assert.equal(tripped.events.open, 1);
    assert.equal(tripped.events.fallback, 1);

    assert.equal(await breaker.fire(), 'fallback');
    const rejected = await read();
    assert.equal(rejected.events.reject, 1);
    assert.equal(rejected.events.fallback, 2);

    breaker.close();
    const closed = await read();
    assert.equal(closed.state, 'closed');
    assert.equal(closed.events.close, 1);
  } finally {
    breaker.shutdown();
  }
});

test('a call slower than the breaker timeout is counted as a timeout', async () => {
  const { breaker, read } = instrumentedBreaker(() => new Promise((resolve) => {
    setTimeout(() => resolve('late'), 300).unref();
  }));
  try {
    assert.equal(await breaker.fire(), 'fallback');
    const reading = await read();
    assert.equal(reading.events.timeout, 1);
    assert.equal(reading.events.failure, 1);
  } finally {
    breaker.shutdown();
  }
});
