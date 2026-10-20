// Builds the resilience report from what the suite actually measured: the
// phase manifest (results/phases.json) and each phase's k6 summary export.
// Nothing in the report is pre-written; every number, delta and verdict is
// derived from those files.
//
// Three separate questions are answered per phase:
//   1. Baseline SLOs: did the phase meet the shared thresholds in
//      load-test.js? Read from k6's own threshold results, so the report
//      cannot drift from the script.
//   2. Phase SLOs: did the phase meet its own thresholds, the guarantees that
//      must survive its fault? k6 reports them on sub-metrics tagged with
//      suite_phase, which is how they are told apart from the baseline.
//   3. Hypothesis: did the system behave the way the experiment predicted?
//      A chaos phase that breaches the latency SLO confirms its hypothesis;
//      that is a successful experiment, not a failed one.
//
// Usage: node report.js [resultsDir]   (default: ./results)

const fs = require('fs');
const path = require('path');

const MANIFEST_FILE = 'phases.json';
const REPORT_JSON = 'report.json';
const REPORT_MD = 'report.md';
const SUMMARY_MD = 'summary.md';

// Stats compared against the baseline phase. `unit` drives how a delta is shown.
const STATS = [
  { key: 'rps', label: 'Throughput', unit: 'req/s' },
  { key: 'avg', label: 'Avg latency', unit: 'ms' },
  { key: 'med', label: 'Median latency', unit: 'ms' },
  { key: 'p95', label: 'P95 latency', unit: 'ms' },
  { key: 'p99', label: 'P99 latency', unit: 'ms' },
  { key: 'errorRate', label: 'HTTP error rate', unit: 'ratio' },
  { key: 'checkRate', label: 'Checks passed', unit: 'ratio' },
  { key: 'degradedRate', label: 'Degraded (fallback) responses', unit: 'ratio' }
];

const STAT_LABELS = Object.fromEntries(STATS.map((s) => [s.key, s.label]));

// load-test.js puts phase SLOs on `<metric>{suite_phase:<id>}` sub-metrics.
const PHASE_SUBMETRIC = /^(\w+)\{suite_phase:[^}]*\}$/;

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Reads the legacy --summary-export format: trend stats sit directly on the
// metric, rates expose `value`, and each threshold maps to `true` when it was
// crossed (failed).
function extractMetrics(summary) {
  const metrics = (summary && summary.metrics) || {};
  const duration = metrics.http_req_duration || {};
  const reqs = metrics.http_reqs || {};

  const thresholds = [];
  for (const [key, data] of Object.entries(metrics)) {
    const phaseMatch = key.match(PHASE_SUBMETRIC);
    const metric = phaseMatch ? phaseMatch[1] : key;
    const scope = phaseMatch ? 'phase' : 'baseline';
    for (const [expression, crossed] of Object.entries(data.thresholds || {})) {
      thresholds.push({ metric, expression, scope, passed: crossed === false });
    }
  }
  // k6 exports metrics in no fixed order; sort so reports diff cleanly.
  thresholds.sort((a, b) => a.scope.localeCompare(b.scope)
    || a.metric.localeCompare(b.metric)
    || a.expression.localeCompare(b.expression));

  return {
    requests: numberOrNull(reqs.count),
    rps: numberOrNull(reqs.rate),
    avg: numberOrNull(duration.avg),
    med: numberOrNull(duration.med),
    p95: numberOrNull(duration['p(95)']),
    p99: numberOrNull(duration['p(99)']),
    errorRate: numberOrNull(metrics.http_req_failed && metrics.http_req_failed.value),
    checkRate: numberOrNull(metrics.checks && metrics.checks.value),
    degradedRate: numberOrNull(metrics.degraded_responses && metrics.degraded_responses.value),
    thresholds
  };
}

// Latency and throughput deltas are relative; rates are absolute (percentage
// points), because a relative change from a 0% baseline error rate is undefined.
function delta(stat, value, baselineValue) {
  if (value === null || baselineValue === null) return null;
  const absolute = value - baselineValue;
  if (stat.unit === 'ratio') return { absolute, relative: null };
  return { absolute, relative: baselineValue === 0 ? null : absolute / baselineValue };
}

function describeExpectation(expectation) {
  switch (expectation.kind) {
    case 'all-slos':
      return `all SLOs ${expectation.outcome}`;
    case 'slo':
      return `${expectation.metric} SLO ${expectation.outcome}`;
    case 'lower-than-phase':
      return `${STAT_LABELS[expectation.stat] || expectation.stat} lower than phase ${expectation.phase}`;
    case 'phase-slos':
      return `phase SLOs ${expectation.outcome}`;
    case 'breaker-event':
      return `circuit breaker ${expectation.event} event ${expectation.outcome}`;
    default:
      throw new Error(`Unknown expectation kind: ${expectation.kind}`);
  }
}

function sloOutcome(thresholds) {
  if (thresholds.length === 0) return null;
  return thresholds.every((t) => t.passed) ? 'met' : 'breached';
}

const baselineThresholds = (metrics) => metrics.thresholds.filter((t) => t.scope === 'baseline');
const phaseThresholds = (metrics) => metrics.thresholds.filter((t) => t.scope === 'phase');

// circuitBreaker: the phase's breaker reading from the manifest (state at the
// end and event counts during the phase), or undefined if none was taken.
function evaluateExpectation(expectation, metrics, metricsByPhase, circuitBreaker) {
  const description = describeExpectation(expectation);
  let observed;
  let confirmed;

  switch (expectation.kind) {
    case 'all-slos':
      observed = sloOutcome(baselineThresholds(metrics));
      confirmed = observed === expectation.outcome;
      break;
    case 'slo':
      observed = sloOutcome(baselineThresholds(metrics).filter((t) => t.metric === expectation.metric));
      confirmed = observed === expectation.outcome;
      break;
    case 'phase-slos':
      observed = sloOutcome(phaseThresholds(metrics));
      confirmed = observed === expectation.outcome;
      break;
    case 'breaker-event': {
      const count = circuitBreaker && circuitBreaker.events
        ? circuitBreaker.events[expectation.event]
        : undefined;
      if (typeof count !== 'number') {
        observed = 'not measured';
        confirmed = false;
      } else {
        observed = `${count}x`;
        if (expectation.outcome === 'occurred') confirmed = count > 0;
        else if (expectation.outcome === 'none') confirmed = count === 0;
        else throw new Error(`Unknown breaker-event outcome: ${expectation.outcome}`);
      }
      break;
    }
    case 'lower-than-phase': {
      const other = metricsByPhase.get(expectation.phase);
      const value = metrics[expectation.stat];
      const reference = other ? other[expectation.stat] : null;
      if (value === null || reference === null) {
        observed = 'not measured';
        confirmed = false;
      } else {
        observed = `${value.toFixed(1)} vs ${reference.toFixed(1)}`;
        confirmed = value < reference;
      }
      break;
    }
    default:
      throw new Error(`Unknown expectation kind: ${expectation.kind}`);
  }

  return { description, observed: observed === null ? 'no thresholds' : observed, confirmed };
}

// manifest: contents of phases.json. summaries: Map of phase id -> parsed
// k6 summary export. The first phase is the baseline every delta refers to.
function buildReport(manifest, summaries) {
  const phases = manifest.phases || [];
  if (phases.length === 0) {
    throw new Error('Manifest lists no phases');
  }

  const metricsByPhase = new Map();
  for (const phase of phases) {
    const summary = summaries.get(phase.id);
    if (!summary) {
      throw new Error(`No k6 summary for phase ${phase.id}`);
    }
    metricsByPhase.set(phase.id, extractMetrics(summary));
  }

  const baseline = phases[0];
  const baselineMetrics = metricsByPhase.get(baseline.id);

  const reportPhases = phases.map((phase) => {
    const metrics = metricsByPhase.get(phase.id);
    const deltas = {};
    for (const stat of STATS) {
      deltas[stat.key] = phase.id === baseline.id
        ? null
        : delta(stat, metrics[stat.key], baselineMetrics[stat.key]);
    }
    const circuitBreaker = phase.circuitBreaker || null;
    const expectations = (phase.expectations || [])
      .map((expectation) => evaluateExpectation(expectation, metrics, metricsByPhase, circuitBreaker));
    const phaseSlos = sloOutcome(phaseThresholds(metrics));

    return {
      id: phase.id,
      name: phase.name,
      targetPath: phase.targetPath,
      chaos: phase.chaos,
      hypothesis: phase.hypothesis || null,
      metrics,
      deltas,
      slosMet: sloOutcome(baselineThresholds(metrics)) === 'met',
      phaseSlosMet: phaseSlos === null ? null : phaseSlos === 'met',
      circuitBreaker,
      expectations,
      hypothesisConfirmed: expectations.length > 0 && expectations.every((e) => e.confirmed)
    };
  });

  return {
    startedAt: manifest.startedAt || null,
    finishedAt: manifest.finishedAt || null,
    baselinePhase: baseline.id,
    phases: reportPhases,
    hypothesesConfirmed: reportPhases.filter((p) => p.hypothesisConfirmed).length
  };
}

function formatValue(stat, value) {
  if (value === null) return 'n/a';
  if (stat.unit === 'ratio') return `${(value * 100).toFixed(2)}%`;
  if (stat.unit === 'req/s') return `${value.toFixed(1)} req/s`;
  return `${value.toFixed(1)} ms`;
}

function formatDelta(stat, d) {
  if (d === null) return '';
  const sign = d.absolute >= 0 ? '+' : '-';
  if (stat.unit === 'ratio') {
    return ` (${sign}${Math.abs(d.absolute * 100).toFixed(2)} pp)`;
  }
  const absolute = stat.unit === 'req/s'
    ? `${sign}${Math.abs(d.absolute).toFixed(1)}`
    : `${sign}${Math.abs(d.absolute).toFixed(1)} ms`;
  const relative = d.relative === null ? '' : `, ${sign}${Math.abs(d.relative * 100).toFixed(0)}%`;
  return ` (${absolute}${relative})`;
}

function formatPhaseSlos(phase) {
  if (phase.phaseSlosMet === null) return 'none set';
  return phase.phaseSlosMet ? 'met' : 'breached';
}

function formatBreaker(phase) {
  const cb = phase.circuitBreaker;
  if (!cb) return 'n/a';
  const e = cb.events;
  return `${cb.stateAfter}; ${e.open} opened, ${e.timeout} timeouts, ${e.reject} rejected, ${e.fallback} fallbacks`;
}

function escapeCell(text) {
  return String(text).replace(/\|/g, '\\|');
}

function renderMarkdown(report) {
  const phases = report.phases;
  const lines = [];
  const header = phases.map((p) => `Phase ${p.id}: ${escapeCell(p.name)}`);

  lines.push('# Resilience suite report', '');
  if (report.startedAt) {
    lines.push(`Run: ${report.startedAt} to ${report.finishedAt || 'unfinished'}`, '');
  }
  lines.push(
    `Hypotheses confirmed: ${report.hypothesesConfirmed} of ${phases.length}. ` +
      `Deltas are against phase ${report.baselinePhase} (baseline).`,
    ''
  );

  lines.push('## Measurements', '');
  lines.push(`| Metric | ${header.join(' | ')} |`);
  lines.push(`| :--- | ${phases.map(() => ':---').join(' | ')} |`);
  lines.push(`| Endpoint | ${phases.map((p) => `\`${p.targetPath}\``).join(' | ')} |`);
  lines.push(`| Chaos | ${phases.map((p) => escapeCell(p.chaos)).join(' | ')} |`);
  lines.push(`| Requests | ${phases.map((p) => (p.metrics.requests === null ? 'n/a' : p.metrics.requests)).join(' | ')} |`);
  for (const stat of STATS) {
    const cells = phases.map((p) => formatValue(stat, p.metrics[stat.key]) + formatDelta(stat, p.deltas[stat.key]));
    lines.push(`| ${stat.label} | ${cells.join(' | ')} |`);
  }
  lines.push(`| Baseline SLOs | ${phases.map((p) => (p.slosMet ? 'met' : 'breached')).join(' | ')} |`);
  lines.push(`| Phase SLOs | ${phases.map(formatPhaseSlos).join(' | ')} |`);
  lines.push(`| Circuit breaker | ${phases.map(formatBreaker).join(' | ')} |`);
  lines.push(`| Hypothesis | ${phases.map((p) => (p.hypothesisConfirmed ? 'confirmed' : 'not confirmed')).join(' | ')} |`);
  lines.push('');

  lines.push('## SLOs per phase', '');
  const listThresholds = (thresholds) => (thresholds.length === 0
    ? 'none'
    : thresholds.map((t) => `${t.metric} \`${t.expression}\` ${t.passed ? 'met' : 'breached'}`).join('; '));
  for (const phase of phases) {
    lines.push(`- Phase ${phase.id}`);
    lines.push(`  - Baseline: ${listThresholds(baselineThresholds(phase.metrics))}`);
    lines.push(`  - Phase: ${listThresholds(phaseThresholds(phase.metrics))}`);
  }
  lines.push('');

  lines.push('## Hypotheses', '');
  for (const phase of phases) {
    const verdict = phase.hypothesisConfirmed ? 'confirmed' : 'not confirmed';
    lines.push(`### Phase ${phase.id}: ${phase.name} (${verdict})`, '');
    if (phase.hypothesis) lines.push(phase.hypothesis, '');
    if (phase.expectations.length === 0) {
      lines.push('- No expectations defined for this phase.');
    }
    for (const e of phase.expectations) {
      lines.push(`- ${e.confirmed ? 'Confirmed' : 'Not confirmed'}: ${e.description} (observed: ${e.observed})`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

// Compact one-row-per-phase comparison for the CI job summary, where the
// full report's wide per-metric table is hard to scan.
function renderSummaryTable(report) {
  const byKey = Object.fromEntries(STATS.map((s) => [s.key, s]));
  const cell = (phase, key) => formatValue(byKey[key], phase.metrics[key]) + formatDelta(byKey[key], phase.deltas[key]);
  const lines = [
    '## Resilience suite',
    '',
    `Hypotheses confirmed: ${report.hypothesesConfirmed} of ${report.phases.length}. ` +
      `Deltas are against phase ${report.baselinePhase} (baseline).`,
    '',
    '| Phase | Endpoint | Chaos | Throughput | P95 latency | HTTP errors | Degraded | Baseline SLOs | Phase SLOs | Breaker | Hypothesis |',
    '| :--- | :--- | :--- | ---: | ---: | ---: | ---: | :--- | :--- | :--- | :--- |'
  ];
  for (const phase of report.phases) {
    lines.push(`| ${[
      `${phase.id}. ${escapeCell(phase.name)}`,
      `\`${phase.targetPath}\``,
      escapeCell(phase.chaos),
      cell(phase, 'rps'),
      cell(phase, 'p95'),
      cell(phase, 'errorRate'),
      cell(phase, 'degradedRate'),
      phase.slosMet ? 'met' : 'breached',
      formatPhaseSlos(phase),
      phase.circuitBreaker ? `${phase.circuitBreaker.stateAfter} (${phase.circuitBreaker.events.open} opened)` : 'n/a',
      phase.hypothesisConfirmed ? 'confirmed' : 'not confirmed'
    ].join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeReport(resultsDir) {
  const manifest = readJson(path.join(resultsDir, MANIFEST_FILE));
  const summaries = new Map();
  for (const phase of manifest.phases || []) {
    summaries.set(phase.id, readJson(path.join(resultsDir, phase.summaryFile)));
  }

  const report = buildReport(manifest, summaries);
  fs.writeFileSync(path.join(resultsDir, REPORT_JSON), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(resultsDir, REPORT_MD), renderMarkdown(report));
  fs.writeFileSync(path.join(resultsDir, SUMMARY_MD), renderSummaryTable(report));
  return report;
}

module.exports = { extractMetrics, evaluateExpectation, buildReport, renderMarkdown, renderSummaryTable, writeReport };

if (require.main === module) {
  const resultsDir = path.resolve(process.argv[2] || path.join(__dirname, 'results'));
  try {
    const report = writeReport(resultsDir);
    console.log(`Report written to ${path.join(resultsDir, REPORT_MD)} ` +
      `(${report.hypothesesConfirmed} of ${report.phases.length} hypotheses confirmed)`);
  } catch (error) {
    console.error(`Could not build report: ${error.message}`);
    process.exitCode = 1;
  }
}
