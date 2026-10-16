import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

// Every knob is an environment variable so the orchestrator and CI can run
// the same script with short durations or a different gateway path.
const GATEWAY_URL = __ENV.GATEWAY_URL || 'http://api-gateway:3000';
const TARGET_PATH = __ENV.TARGET_PATH || '/products/naive';
const VUS = parseInt(__ENV.VUS || '100', 10);
const SLEEP_DURATION = parseFloat(__ENV.SLEEP_DURATION || '0.1');

// Share of 200 responses that carried the gateway's fallback payload instead
// of the real catalog. Tracked separately from http_req_failed: a degraded
// response is a successful HTTP exchange but not a successful product read.
const degradedResponses = new Rate('degraded_responses');

export const options = {
  stages: [
    { duration: __ENV.RAMP_UP || '5s', target: VUS },
    { duration: __ENV.DURATION || '30s', target: VUS },
    { duration: __ENV.RAMP_DOWN || '5s', target: 0 }
  ],
  thresholds: {
    // Baseline SLOs. Chaos phases are expected to breach some of these.
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<200', 'p(99)<500'],
    checks: ['rate>0.99'],
    degraded_responses: ['rate<0.01']
  }
};

function parseJson(res) {
  try {
    return res.json();
  } catch {
    return undefined;
  }
}

// product-service returns rows from Postgres; DECIMAL columns arrive as strings.
function isProduct(item) {
  return item !== null
    && typeof item === 'object'
    && Number.isInteger(item.id)
    && typeof item.name === 'string' && item.name.length > 0
    && !Number.isNaN(parseFloat(item.price))
    && Number.isInteger(item.stock);
}

function isCatalog(body) {
  return Array.isArray(body) && body.length > 0 && body.every(isProduct);
}

// Shape returned by the resilient path's circuit-breaker fallback.
function isDegradedFallback(body) {
  return body !== null
    && typeof body === 'object'
    && !Array.isArray(body)
    && body.status === 'degraded'
    && Array.isArray(body.data);
}

export default function () {
  const res = http.get(`${GATEWAY_URL}${TARGET_PATH}`);
  const body = res.status === 200 ? parseJson(res) : undefined;
  const degraded = isDegradedFallback(body);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'body is the product catalog': () => isCatalog(body)
  });

  if (res.status === 200) {
    degradedResponses.add(degraded);
  }

  if (SLEEP_DURATION > 0) {
    sleep(SLEEP_DURATION);
  }
}
