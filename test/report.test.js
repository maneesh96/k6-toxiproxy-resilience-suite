const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  extractMetrics, evaluateExpectation, buildReport, renderMarkdown, renderSummaryTable, writeReport
} = require('../report');

const FIXTURES = path.join(__dirname, 'fixtures');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

const baseline = load('summary-baseline.json');
const naiveLatency = load('summary-naive-latency.json');
const resilientLatency = load('summary-resilient-latency.json');

function manifest() {
  return {
    startedAt: '2026-10-18T15:00:00.000Z',
    finishedAt: '2026-10-18T15:01:00.000Z',
    phases: [
      {
        id: 1,
        name: 'Steady-state baseline',
        targetPath: '/products/naive',
        chaos: 'none',
        summaryFile: 'phase1_summary.json',
        expectations: [{ kind: 'all-slos', outcome: 'met' }]
      },
      {
        id: 2,
        name: 'Unmitigated downstream latency',
        targetPath: '/products/naive',
        chaos: 'latency 2000ms +/- 500ms',
        summaryFile: 'phase2_summary.json',
        expectations: [{ kind: 'slo', metric: 'http_req_duration', outcome: 'breached' }]
      },
      {
        id: 3,
        name: 'Downstream latency behind circuit breaker',
        targetPath: '/products/resilient',
        chaos: 'latency 2000ms +/- 500ms',
        summaryFile: 'phase3_summary.json',
        thresholds: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(99)<1000'] },
        circuitBreaker: {
          stateBefore: 'closed',
          stateAfter: 'open',
          events: { success: 0, failure: 10, timeout: 10, reject: 370, fallback: 380, open: 1, halfOpen: 0, close: 0 }
        },
        expectations: [
          { kind: 'slo', metric: 'http_req_failed', outcome: 'met' },
          { kind: 'slo', metric: 'degraded_responses', outcome: 'breached' },
          { kind: 'lower-than-phase', stat: 'p95', phase: 2 },
          { kind: 'phase-slos', outcome: 'met' },
          { kind: 'breaker-event', event: 'open', outcome: 'occurred' }
        ]
      }
    ]
  };
}

const summaries = () => new Map([[1, baseline], [2, naiveLatency], [3, resilientLatency]]);

test('extractMetrics reads the k6 summary-export format', () => {
  const m = extractMetrics(naiveLatency);
  assert.equal(m.requests, 20);
  assert.equal(m.rps, 2);
  assert.equal(m.p95, 2450);
  assert.equal(m.p99, 2490);
  assert.equal(m.errorRate, 0);
  assert.equal(m.degradedRate, 0);
});

test('extractMetrics treats a threshold value of true as crossed', () => {
  const thresholds = extractMetrics(naiveLatency).thresholds;
  const p95 = thresholds.find((t) => t.metric === 'http_req_duration' && t.expression === 'p(95)<200');
  const failed = thresholds.find((t) => t.metric === 'http_req_failed');
  assert.equal(p95.passed, false);
  assert.equal(failed.passed, true);
});

test('extractMetrics separates phase SLOs on suite_phase sub-metrics from baseline SLOs', () => {
  const thresholds = extractMetrics(resilientLatency).thresholds;
  const phase = thresholds.filter((t) => t.scope === 'phase');
  assert.deepEqual(phase, [
    { metric: 'http_req_duration', expression: 'p(99)<1000', scope: 'phase', passed: true },
    { metric: 'http_req_failed', expression: 'rate<0.01', scope: 'phase', passed: true }
  ]);
  assert.equal(thresholds.filter((t) => t.scope === 'baseline').length, 5);
});

test('extractMetrics reports a stat missing from the export as null', () => {
  const m = extractMetrics({ metrics: { http_req_duration: { avg: 5, 'p(95)': 9 } } });
  assert.equal(m.p99, null);
  assert.equal(m.requests, null);
  assert.deepEqual(m.thresholds, []);
});

test('deltas are computed against the first phase', () => {
  const report = buildReport(manifest(), summaries());
  const [phase1, phase2] = report.phases;
  assert.equal(phase1.deltas.p95, null);
  assert.equal(phase2.deltas.p95.absolute, 2425);
  assert.equal(phase2.deltas.p95.relative, 97);
  assert.equal(phase2.deltas.rps.absolute, -38);
});

test('rate deltas are absolute only, since a 0% baseline has no relative change', () => {
  const report = buildReport(manifest(), summaries());
  const degraded = report.phases[2].deltas.degradedRate;
  assert.equal(degraded.absolute, 1);
  assert.equal(degraded.relative, null);
});

test('a chaos phase that breaches the latency SLO confirms its hypothesis', () => {
  const report = buildReport(manifest(), summaries());
  const phase2 = report.phases[1];
  assert.equal(phase2.slosMet, false);
  assert.equal(phase2.hypothesisConfirmed, true);
});

test('all expectations must hold for a hypothesis to be confirmed', () => {
  const report = buildReport(manifest(), summaries());
  assert.equal(report.phases[2].hypothesisConfirmed, true);
  assert.equal(report.hypothesesConfirmed, 3);

  const brokenBreaker = manifest();
  const errors = structuredClone(resilientLatency);
  errors.metrics.http_req_failed.value = 0.4;
  errors.metrics.http_req_failed.thresholds['rate<0.01'] = true;
  const report2 = buildReport(brokenBreaker, new Map([[1, baseline], [2, naiveLatency], [3, errors]]));
  const phase3 = report2.phases[2];
  assert.equal(phase3.hypothesisConfirmed, false);
  assert.deepEqual(phase3.expectations.map((e) => e.confirmed), [false, true, true, true, true]);
});

test('baseline SLOs ignore phase thresholds, and phase SLOs are reported on their own', () => {
  const [phase1, phase2, phase3] = buildReport(manifest(), summaries()).phases;
  assert.equal(phase3.slosMet, false);
  assert.equal(phase3.phaseSlosMet, true);
  assert.equal(phase1.phaseSlosMet, null);
  assert.equal(phase2.phaseSlosMet, null);
});

test('phase-slos is not confirmed when a phase threshold was crossed', () => {
  const crossed = structuredClone(resilientLatency);
  crossed.metrics['http_req_duration{suite_phase:3}'].thresholds['p(99)<1000'] = true;
  const result = evaluateExpectation({ kind: 'phase-slos', outcome: 'met' }, extractMetrics(crossed), new Map());
  assert.equal(result.confirmed, false);
  assert.equal(result.observed, 'breached');
});

test('phase-slos is not confirmed when the phase set no thresholds', () => {
  const result = evaluateExpectation({ kind: 'phase-slos', outcome: 'met' }, extractMetrics(baseline), new Map());
  assert.equal(result.confirmed, false);
  assert.equal(result.observed, 'no thresholds');
});

test('breaker-event counts the events recorded during the phase', () => {
  const metrics = extractMetrics(resilientLatency);
  const opened = { stateAfter: 'open', events: { open: 1 } };
  const stayedClosed = { stateAfter: 'closed', events: { open: 0 } };
  const occurred = { kind: 'breaker-event', event: 'open', outcome: 'occurred' };
  const none = { kind: 'breaker-event', event: 'open', outcome: 'none' };

  assert.equal(evaluateExpectation(occurred, metrics, new Map(), opened).confirmed, true);
  assert.equal(evaluateExpectation(occurred, metrics, new Map(), stayedClosed).confirmed, false);
  assert.equal(evaluateExpectation(none, metrics, new Map(), stayedClosed).confirmed, true);
  assert.equal(evaluateExpectation(occurred, metrics, new Map(), opened).observed, '1x');
});

test('breaker-event is not confirmed without a breaker reading', () => {
  const result = evaluateExpectation(
    { kind: 'breaker-event', event: 'open', outcome: 'occurred' },
    extractMetrics(resilientLatency),
    new Map(),
    null
  );
  assert.equal(result.confirmed, false);
  assert.equal(result.observed, 'not measured');
});

test('a baseline that breaches its SLOs is not confirmed', () => {
  const report = buildReport(manifest(), new Map([[1, naiveLatency], [2, naiveLatency], [3, resilientLatency]]));
  assert.equal(report.phases[0].hypothesisConfirmed, false);
});

test('lower-than-phase compares against the referenced phase', () => {
  const metricsByPhase = new Map([[2, extractMetrics(naiveLatency)]]);
  const expectation = { kind: 'lower-than-phase', stat: 'p95', phase: 2 };
  assert.equal(evaluateExpectation(expectation, extractMetrics(resilientLatency), metricsByPhase).confirmed, true);
  assert.equal(evaluateExpectation(expectation, extractMetrics(naiveLatency), metricsByPhase).confirmed, false);
});

test('lower-than-phase is not confirmed when the stat was not measured', () => {
  const result = evaluateExpectation(
    { kind: 'lower-than-phase', stat: 'p95', phase: 9 },
    extractMetrics(resilientLatency),
    new Map()
  );
  assert.equal(result.confirmed, false);
  assert.equal(result.observed, 'not measured');
});

test('a phase without expectations is never reported as confirmed', () => {
  const m = manifest();
  delete m.phases[0].expectations;
  assert.equal(buildReport(m, summaries()).phases[0].hypothesisConfirmed, false);
});

test('buildReport rejects a phase with no summary', () => {
  assert.throws(() => buildReport(manifest(), new Map([[1, baseline]])), /No k6 summary for phase 2/);
});

test('buildReport rejects an unknown expectation kind', () => {
  const m = manifest();
  m.phases[0].expectations = [{ kind: 'vibes' }];
  assert.throws(() => buildReport(m, summaries()), /Unknown expectation kind: vibes/);
});

test('renderMarkdown shows measured values with deltas and verdicts', () => {
  const md = renderMarkdown(buildReport(manifest(), summaries()));
  assert.match(md, /Hypotheses confirmed: 3 of 3/);
  assert.match(md, /\| P95 latency \| 25\.0 ms \| 2450\.0 ms \(\+2425\.0 ms, \+9700%\) \| 800\.0 ms \(\+775\.0 ms, \+3100%\) \|/);
  assert.match(md, /\| Throughput \| 40\.0 req\/s \| 2\.0 req\/s \(-38\.0, -95%\) \|/);
  assert.match(md, /\| Degraded \(fallback\) responses \| 0\.00% \| 0\.00% \(\+0\.00 pp\) \| 100\.00% \(\+100\.00 pp\) \|/);
  assert.match(md, /\| Baseline SLOs \| met \| breached \| breached \|/);
  assert.match(md, /Confirmed: http_req_duration SLO breached \(observed: breached\)/);
  assert.match(md, /\| Phase SLOs \| none set \| none set \| met \|/);
  assert.match(md, /\| Circuit breaker \| n\/a \| n\/a \| open; 1 opened, 10 timeouts, 370 rejected, 380 fallbacks \|/);
  assert.match(md, /- Phase 3\n {2}- Baseline: .*\n {2}- Phase: http_req_duration `p\(99\)<1000` met; http_req_failed `rate<0\.01` met/);
});

test('renderSummaryTable has one row per phase with deltas and verdicts', () => {
  const md = renderSummaryTable(buildReport(manifest(), summaries()));
  const rows = md.split('\n').filter((line) => /^\| \d+\. /.test(line));
  assert.equal(rows.length, 3);
  assert.match(md, /Hypotheses confirmed: 3 of 3/);
  assert.equal(
    rows[0],
    '| 1. Steady-state baseline | `/products/naive` | none | 40.0 req/s | 25.0 ms | 0.00% | 0.00% | met | none set | n/a | confirmed |'
  );
  assert.match(rows[1], /\| 2\.0 req\/s \(-38\.0, -95%\) \| 2450\.0 ms \(\+2425\.0 ms, \+9700%\) \|/);
  assert.match(rows[2], /\| 100\.00% \(\+100\.00 pp\) \| breached \| met \| open \(1 opened\) \| confirmed \|$/);
});

test('renderSummaryTable escapes pipes so a chaos label cannot break the table', () => {
  const m = manifest();
  m.phases[1].chaos = 'latency | jitter';
  const md = renderSummaryTable(buildReport(m, summaries()));
  assert.match(md, /latency \\\| jitter/);
});

test('writeReport reads results/ and writes report.md, report.json and summary.md', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resilience-report-'));
  try {
    const m = manifest();
    fs.writeFileSync(path.join(dir, 'phases.json'), JSON.stringify(m));
    const byId = summaries();
    for (const phase of m.phases) {
      fs.writeFileSync(path.join(dir, phase.summaryFile), JSON.stringify(byId.get(phase.id)));
    }

    const report = writeReport(dir);

    assert.equal(report.phases.length, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')), report);
    assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /^# Resilience suite report/);
    assert.match(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'), /^## Resilience suite/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
