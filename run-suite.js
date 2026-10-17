// Orchestrates the four resilience phases against the docker-compose stack:
// starts the stack, waits until every hop answers, configures Toxiproxy,
// then runs k6 (in its container) once per phase with the phase's toxics.
//
// Raw k6 summaries and a phase manifest are written to results/. A k6
// threshold breach is recorded, not treated as a suite failure: chaos phases
// are expected to breach the baseline SLOs. The process exits non-zero only
// when the experiment itself could not be carried out.
//
// Environment overrides:
//   VUS, RAMP_UP, DURATION, RAMP_DOWN, SLEEP_DURATION  forwarded to load-test.js
//   TOXIPROXY_API_URL  default http://localhost:8474
//   GATEWAY_URL        default http://localhost:3000 (as seen from the host)
//   KEEP_STACK_UP=1    leave the containers running after the suite

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const RESULTS_DIR = path.join(ROOT, 'results');
const TOXIPROXY_API = process.env.TOXIPROXY_API_URL || 'http://localhost:8474';
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3000';
const KEEP_STACK_UP = process.env.KEEP_STACK_UP === '1';
const K6_OVERRIDES = ['VUS', 'RAMP_UP', 'DURATION', 'RAMP_DOWN', 'SLEEP_DURATION'];

const PROXY = {
  name: 'product_service',
  listen: '0.0.0.0:8080',
  upstream: 'product-service:3001',
  enabled: true
};

const LATENCY_TOXIC = {
  name: 'latency_downstream',
  type: 'latency',
  stream: 'downstream',
  toxicity: 1.0,
  attributes: { latency: 2000, jitter: 500 }
};

const PHASES = [
  {
    id: 1,
    name: 'Steady-state baseline',
    targetPath: '/products/naive',
    chaos: 'none',
    toxics: []
  },
  {
    id: 2,
    name: 'Unmitigated downstream latency',
    targetPath: '/products/naive',
    chaos: 'latency 2000ms +/- 500ms',
    toxics: [LATENCY_TOXIC]
  },
  {
    id: 3,
    name: 'Bandwidth starvation and payload slicing',
    targetPath: '/products/naive',
    chaos: 'bandwidth 10 KB/s + 10-byte slices',
    toxics: [
      {
        name: 'bandwidth_downstream',
        type: 'bandwidth',
        stream: 'downstream',
        toxicity: 1.0,
        attributes: { rate: 10 }
      },
      {
        name: 'slicer_downstream',
        type: 'slicer',
        stream: 'downstream',
        toxicity: 1.0,
        attributes: { average_size: 10, size_variation: 5, delay: 1000 }
      }
    ]
  },
  {
    id: 4,
    name: 'Downstream latency behind circuit breaker',
    targetPath: '/products/resilient',
    chaos: 'latency 2000ms +/- 500ms',
    toxics: [LATENCY_TOXIC]
  }
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function compose(args, { allowFailure = false } = {}) {
  const result = spawnSync('docker', ['compose', ...args], { cwd: ROOT, stdio: 'inherit' });
  if (result.error) {
    throw new Error(`Could not run docker compose: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`docker compose ${args.join(' ')} exited with ${result.status}`);
  }
  return result.status;
}

// Retries only network-level failures (no HTTP response at all), which a
// reused keep-alive socket can produce; HTTP errors are reported immediately.
async function toxiproxy(method, urlPath, body, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`${TOXIPROXY_API}${urlPath}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (error) {
      const reason = error.cause ? `${error.message}: ${error.cause.message}` : error.message;
      if (attempt >= attempts) {
        throw new Error(`Toxiproxy ${method} ${urlPath} failed: ${reason}`);
      }
      console.warn(`- Toxiproxy ${method} ${urlPath} failed (${reason}), retrying`);
      await delay(1000);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Toxiproxy ${method} ${urlPath} returned ${res.status}: ${await res.text()}`);
    }
    return res;
  }
}

// Polls `probe` until it resolves true; probe errors count as "not ready yet".
async function waitFor(description, probe, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    try {
      if (await probe()) {
        console.log(`- ${description}: ready`);
        return;
      }
    } catch (error) {
      lastError = error.message;
    }
    await delay(1000);
  }
  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${description} (${lastError})`);
}

async function configureProxy() {
  await waitFor('Toxiproxy control API', async () => (await fetch(`${TOXIPROXY_API}/version`)).ok);

  const existing = await fetch(`${TOXIPROXY_API}/proxies/${PROXY.name}`);
  if (existing.ok) {
    await toxiproxy('DELETE', `/proxies/${PROXY.name}`);
  }
  await toxiproxy('POST', '/proxies', PROXY);
  console.log(`- Proxy ${PROXY.name}: ${PROXY.listen} -> ${PROXY.upstream}`);
}

// The gateway's own healthcheck only proves the process is up; the first phase
// must not start until a real catalog comes back through Toxiproxy.
async function waitForCatalogThroughGateway() {
  await waitFor('catalog via gateway -> toxiproxy -> product-service', async () => {
    const res = await fetch(`${GATEWAY_URL}/products/naive`);
    if (!res.ok) return false;
    const body = await res.json();
    return Array.isArray(body) && body.length > 0;
  });
}

async function clearToxics() {
  const res = await toxiproxy('GET', `/proxies/${PROXY.name}/toxics`);
  for (const toxic of await res.json()) {
    await toxiproxy('DELETE', `/proxies/${PROXY.name}/toxics/${toxic.name}`);
    console.log(`- Removed toxic ${toxic.name}`);
  }
}

async function applyToxics(toxics) {
  for (const toxic of toxics) {
    await toxiproxy('POST', `/proxies/${PROXY.name}/toxics`, toxic);
    console.log(`- Toxic ${toxic.name}: ${JSON.stringify(toxic.attributes)}`);
  }
}

// k6 exit codes: 0 = all thresholds met, 99 = thresholds crossed. Anything
// else means the run itself failed and its numbers cannot be trusted.
function runK6(phase) {
  const summaryFile = `phase${phase.id}_summary.json`;
  const k6Env = [`TARGET_PATH=${phase.targetPath}`];
  for (const name of K6_OVERRIDES) {
    if (process.env[name]) k6Env.push(`${name}=${process.env[name]}`);
  }

  // Run as the host user so k6 can write into the bind-mounted results/ dir.
  const userArgs = typeof process.getuid === 'function'
    ? ['--user', `${process.getuid()}:${process.getgid()}`]
    : [];

  const status = compose([
    '--profile', 'load', 'run', '--rm', '--no-deps', ...userArgs,
    'k6', 'run',
    ...k6Env.flatMap((pair) => ['-e', pair]),
    '--summary-export', `/results/${summaryFile}`,
    '/scripts/load-test.js'
  ], { allowFailure: true });

  if (status !== 0 && status !== 99) {
    throw new Error(`k6 run for phase ${phase.id} failed with exit code ${status}`);
  }
  if (!fs.existsSync(path.join(RESULTS_DIR, summaryFile))) {
    throw new Error(`k6 did not write ${summaryFile}`);
  }
  return { summaryFile, k6ExitCode: status, thresholdsPassed: status === 0 };
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, '.env'))) {
    throw new Error('.env not found: copy .env.example to .env first');
  }
  fs.rmSync(RESULTS_DIR, { recursive: true, force: true });
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  console.log('Starting stack (waits for postgres, product-service and api-gateway healthchecks)');
  compose(['build']);

  try {
    compose(['up', '-d', '--wait', '--wait-timeout', '120']);
    await configureProxy();
    await waitForCatalogThroughGateway();

    const manifest = { startedAt: new Date().toISOString(), phases: [] };
    for (const phase of PHASES) {
      console.log(`\n--- Phase ${phase.id}: ${phase.name} (${phase.targetPath}, chaos: ${phase.chaos}) ---`);
      await clearToxics();
      await applyToxics(phase.toxics);
      const outcome = runK6(phase);
      await clearToxics();
      console.log(`Phase ${phase.id}: k6 thresholds ${outcome.thresholdsPassed ? 'met' : 'breached'}`);
      manifest.phases.push({
        id: phase.id,
        name: phase.name,
        targetPath: phase.targetPath,
        chaos: phase.chaos,
        ...outcome
      });
    }
    manifest.finishedAt = new Date().toISOString();

    const manifestPath = path.join(RESULTS_DIR, 'phases.json');
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`\nAll ${PHASES.length} phases completed; results in ${path.relative(ROOT, RESULTS_DIR)}/`);
  } finally {
    if (KEEP_STACK_UP) {
      await clearToxics().catch(() => {});
      console.log('KEEP_STACK_UP=1: containers left running');
    } else {
      compose(['--profile', 'load', 'down', '--volumes', '--remove-orphans'], { allowFailure: true });
    }
  }
}

main().catch((error) => {
  console.error(`Suite aborted: ${error.message}`);
  process.exitCode = 1;
});
