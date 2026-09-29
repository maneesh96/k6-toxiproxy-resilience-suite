import http from 'k6/http';
import { check, sleep } from 'k6';

// Read target configurations from environment variables
const TARGET_PATH = __ENV.TARGET_PATH || '/products/naive';
const GATEWAY_URL = __ENV.GATEWAY_URL || 'http://api-gateway:3000';
const SLEEP_DURATION = parseFloat(__ENV.SLEEP_DURATION || '0.1');

export const options = {
  stages: [
    { duration: __ENV.RAMP_UP || '5s', target: 100 },     // Ramp up to 100 VUs
    { duration: __ENV.DURATION || '30s', target: 100 },   // Sustain at 100 VUs
    { duration: __ENV.RAMP_DOWN || '5s', target: 0 }      // Graceful ramp down
  ],
  thresholds: {
    // Service Level Objectives (SLOs)
    http_req_failed: ['rate < 0.01'],                       // Error rate must be less than 1%
    http_req_duration: ['p(95) < 200', 'p(99) < 500']      // P95 < 200ms, P99 < 500ms
  }
};

export default function () {
  const url = `${GATEWAY_URL}${TARGET_PATH}`;
  
  const res = http.get(url);
  
  // Verify that the request succeeded
  const isOk = check(res, {
    'status is 200': (r) => r.status === 200,
  });
  
  // Pace the virtual user execution to prevent unbound request flooding
  // and simulate a steady arrival rate pattern.
  if (SLEEP_DURATION > 0) {
    sleep(SLEEP_DURATION);
  }
}
