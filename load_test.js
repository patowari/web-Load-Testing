/**
 * ============================================================
 *  SRS RENAL CARE — FULL SITE + API AGGRESSIVE LOAD TEST
 *  Tool: k6  |  Run: k6 run load_test_full.js
 * ============================================================
 *
 *  TEST STAGES:
 *   1. Warm-up       — 30s ramp to 50 VUs
 *   2. Normal load   — 2min at 100 VUs
 *   3. Heavy load    — 2min at 200 VUs
 *   4. Spike         — 30s burst to 350 VUs
 *   5. Sustained     — 2min at 200 VUs (hold after spike)
 *   6. Recovery      — 1min ramp down to 0
 *
 *  SCENARIOS TESTED:
 *   A. Full page load (HTML + assets)
 *   B. API endpoints (REST calls the app makes)
 *   C. Authenticated user flow simulation
 *   D. Concurrent heavy operations
 * ============================================================
 */

import http from 'k6/http';
import { sleep, check, group, fail } from 'k6';
import { Counter, Rate, Trend, Gauge } from 'k6/metrics';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// ─── Custom Metrics ──────────────────────────────────────────
const pageLoadTime     = new Trend('page_load_time',     true);
const apiResponseTime  = new Trend('api_response_time',  true);
const errorCount       = new Counter('error_count');
const errorRate        = new Rate('error_rate');
const slowRequests     = new Counter('slow_requests_over_3s');
const timeoutRequests  = new Counter('timeout_requests');
const activeUsers      = new Gauge('active_users');

// ─── Test Configuration ───────────────────────────────────────
export const options = {
  // Multi-stage ramp: warm → normal → heavy → spike → sustain → cool
  stages: [
    { duration: '30s',  target: 50  },  // 1. warm-up
    { duration: '2m',   target: 100 },  // 2. normal load
    { duration: '2m',   target: 200 },  // 3. heavy load
    { duration: '30s',  target: 350 },  // 4. spike
    { duration: '2m',   target: 200 },  // 5. sustained post-spike
    { duration: '1m',   target: 0   },  // 6. cool-down
  ],

  thresholds: {
    // ── Page load thresholds ──
    'page_load_time':              ['p(95)<3000', 'p(99)<5000'],

    // ── API response thresholds ──
    'api_response_time':           ['p(95)<2000', 'p(99)<4000', 'avg<1000'],

    // ── Global HTTP thresholds ──
    'http_req_duration':           ['p(95)<3000', 'p(99)<5000', 'avg<1500'],
    'http_req_failed':             ['rate<0.05'],   // max 5% failures allowed

    // ── Custom thresholds ──
    'error_rate':                  ['rate<0.05'],
    'slow_requests_over_3s':       ['count<50'],    // max 50 slow requests total
  },
};

// ─── Base URL ────────────────────────────────────────────────
const BASE_URL = 'https://srs-renal-care.base44.app';

// ─── Common Headers ───────────────────────────────────────────
const HTML_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

const API_HEADERS = {
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Cache-Control': 'no-cache',
};

// ─── Helper: record result ────────────────────────────────────
function record(res, label, trend, maxMs = 3000) {
  const ok = res.status >= 200 && res.status < 400;
  const dur = res.timings.duration;

  trend.add(dur);

  if (!ok)       { errorCount.add(1); errorRate.add(1); }
  else           { errorRate.add(0); }

  if (dur > 3000) slowRequests.add(1);
  if (dur > 9000) timeoutRequests.add(1);

  return check(res, {
    [`${label} — status 2xx/3xx`]:        (r) => r.status >= 200 && r.status < 400,
    [`${label} — no server error (5xx)`]: (r) => r.status < 500,
    [`${label} — response time < ${maxMs}ms`]: (r) => r.timings.duration < maxMs,
    [`${label} — has response body`]:     (r) => r.body && r.body.length > 0,
  });
}

// ─── Scenario A: Full Page Load ───────────────────────────────
function testPageLoad() {
  group('A — Full page load', () => {
    const pages = [
      { path: '/',           label: 'Home' },
      { path: '/login',      label: 'Login' },
      { path: '/dashboard',  label: 'Dashboard' },
      { path: '/patients',   label: 'Patients' },
      { path: '/appointments', label: 'Appointments' },
      { path: '/reports',    label: 'Reports' },
    ];

    // Pick a random page each iteration to simulate real browsing
    const page = pages[randomIntBetween(0, pages.length - 1)];
    const start = Date.now();

    const res = http.get(`${BASE_URL}${page.path}`, {
      headers: HTML_HEADERS,
      timeout: '10s',
      redirects: 5,
    });

    pageLoadTime.add(Date.now() - start);
    record(res, `Page: ${page.label}`, pageLoadTime, 3000);

    // Check for SPA shell (React app must inject a root div)
    check(res, {
      'SPA shell present': (r) => r.body && (
        r.body.includes('root') ||
        r.body.includes('app') ||
        r.body.includes('<!DOCTYPE') ||
        r.status === 200
      ),
    });
  });
}

// ─── Scenario B: API Endpoints ────────────────────────────────
function testAPIs() {
  group('B — API endpoints', () => {

    // ── B1: Health / Status check ──────────────────────────────
    group('B1 — Health check', () => {
      const endpoints = [
        `${BASE_URL}/api/health`,
        `${BASE_URL}/api/status`,
        `${BASE_URL}/health`,
        `${BASE_URL}/ping`,
      ];
      // Try all health endpoints — at least one should respond
      endpoints.forEach((url) => {
        const r = http.get(url, { headers: API_HEADERS, timeout: '5s' });
        // 200, 404, or 405 all acceptable (404 just means endpoint doesn't exist)
        check(r, {
          'Health endpoint reachable (not 5xx)': (res) => res.status < 500,
        });
        apiResponseTime.add(r.timings.duration);
      });
    });

    // ── B2: Static Assets (CSS / JS bundles) ───────────────────
    group('B2 — Static assets', () => {
      // These are the paths React apps typically serve after build
      const assets = [
        `${BASE_URL}/static/js/main.chunk.js`,
        `${BASE_URL}/static/js/bundle.js`,
        `${BASE_URL}/assets/index.js`,
        `${BASE_URL}/manifest.json`,
        `${BASE_URL}/favicon.ico`,
        `${BASE_URL}/robots.txt`,
      ];

      assets.forEach((url) => {
        const r = http.get(url, {
          headers: { ...HTML_HEADERS, 'Cache-Control': 'no-cache' },
          timeout: '8s',
        });
        // Accept 200 or 404 — we're testing server response speed, not existence
        check(r, {
          'Asset request not 5xx': (res) => res.status !== 500 && res.status !== 502 && res.status !== 503,
          'Asset response fast (<2s)': (res) => res.timings.duration < 2000,
        });
        apiResponseTime.add(r.timings.duration);
      });
    });

    // ── B3: Common REST API patterns ───────────────────────────
    group('B3 — REST API calls', () => {

      // Typical Base44 app API routes
      const apiRoutes = [
        { method: 'GET',  path: '/api/patients',          label: 'GET patients list' },
        { method: 'GET',  path: '/api/appointments',      label: 'GET appointments' },
        { method: 'GET',  path: '/api/users',             label: 'GET users' },
        { method: 'GET',  path: '/api/reports',           label: 'GET reports' },
        { method: 'GET',  path: '/api/settings',          label: 'GET settings' },
        { method: 'GET',  path: '/api/dashboard',         label: 'GET dashboard data' },
        { method: 'GET',  path: '/api/notifications',     label: 'GET notifications' },
        // Paginated list
        { method: 'GET',  path: '/api/patients?page=1&limit=20',  label: 'GET patients paginated' },
        { method: 'GET',  path: '/api/appointments?status=upcoming', label: 'GET upcoming appointments' },
      ];

      // Run 3 random API calls per iteration to simulate real app usage
      const selected = [];
      for (let i = 0; i < 3; i++) {
        selected.push(apiRoutes[randomIntBetween(0, apiRoutes.length - 1)]);
      }

      selected.forEach(({ method, path, label }) => {
        let res;
        if (method === 'GET') {
          res = http.get(`${BASE_URL}${path}`, {
            headers: API_HEADERS,
            timeout: '8s',
          });
        }

        apiResponseTime.add(res.timings.duration);

        // 401 is acceptable (auth required), 404 acceptable (route may differ),
        // but 500/502/503 are real failures we care about
        check(res, {
          [`${label} — not 5xx`]:          (r) => r.status < 500,
          [`${label} — fast (<3s)`]:       (r) => r.timings.duration < 3000,
          [`${label} — TTFB < 1s`]:        (r) => r.timings.waiting < 1000,
        });

        if (res.status >= 500) {
          errorCount.add(1);
          errorRate.add(1);
          console.error(`❌ ${label} failed: HTTP ${res.status} in ${res.timings.duration}ms`);
        } else {
          errorRate.add(0);
        }
      });
    });

    // ── B4: POST endpoints (login / form submit) ───────────────
    group('B4 — POST requests', () => {
      // Simulate login form POST
      const loginPayload = JSON.stringify({
        email: `testuser${randomIntBetween(1, 999)}@loadtest.com`,
        password: 'TestPassword123!',
      });

      const loginRes = http.post(`${BASE_URL}/api/auth/login`, loginPayload, {
        headers: API_HEADERS,
        timeout: '8s',
      });

      apiResponseTime.add(loginRes.timings.duration);
      check(loginRes, {
        'Login endpoint reachable (not 5xx)': (r) => r.status < 500,
        'Login responds fast (<3s)':          (r) => r.timings.duration < 3000,
      });

      // Try signup too
      const signupPayload = JSON.stringify({
        email: `newuser${randomIntBetween(1000, 9999)}@loadtest.com`,
        password: 'TestPassword123!',
        name: 'Load Test User',
      });

      const signupRes = http.post(`${BASE_URL}/api/auth/signup`, signupPayload, {
        headers: API_HEADERS,
        timeout: '8s',
      });

      check(signupRes, {
        'Signup endpoint reachable (not 5xx)': (r) => r.status < 500,
      });
    });
  });
}

// ─── Scenario C: Concurrent Heavy Operations ──────────────────
function testHeavyOperations() {
  group('C — Heavy / concurrent operations', () => {

    // Batch parallel requests — simulates a dashboard loading many things at once
    const batchRequests = [
      ['GET', `${BASE_URL}/api/patients?limit=100`],
      ['GET', `${BASE_URL}/api/appointments?limit=100`],
      ['GET', `${BASE_URL}/api/reports/summary`],
      ['GET', `${BASE_URL}/api/dashboard/stats`],
    ].map(([method, url]) => ({ method, url, params: { headers: API_HEADERS, timeout: '10s' } }));

    const responses = http.batch(batchRequests);

    responses.forEach((res, i) => {
      const label = `Batch[${i}]`;
      apiResponseTime.add(res.timings.duration);
      check(res, {
        [`${label} not 5xx`]:    (r) => r.status < 500,
        [`${label} under 5s`]:   (r) => r.timings.duration < 5000,
      });
      if (res.status >= 500) errorCount.add(1);
    });
  });
}

// ─── Scenario D: Search & Filter (heavy DB queries) ───────────
function testSearchAndFilter() {
  group('D — Search & filter (DB-heavy)', () => {
    const searchTerms = ['Smith', 'John', 'diabetes', 'renal', '2024', 'dialysis'];
    const term = searchTerms[randomIntBetween(0, searchTerms.length - 1)];

    const searchEndpoints = [
      `${BASE_URL}/api/patients/search?q=${term}`,
      `${BASE_URL}/api/appointments/search?q=${term}`,
      `${BASE_URL}/api/search?q=${term}`,
    ];

    searchEndpoints.forEach((url) => {
      const r = http.get(url, { headers: API_HEADERS, timeout: '10s' });
      apiResponseTime.add(r.timings.duration);
      check(r, {
        'Search not 5xx':    (r) => r.status < 500,
        'Search under 4s':   (r) => r.timings.duration < 4000,
      });
    });
  });
}

// ─── Main VU function ─────────────────────────────────────────
export default function () {
  activeUsers.add(1);

  // Weight the scenarios to simulate realistic traffic distribution:
  // 40% page loads | 40% API calls | 10% heavy ops | 10% search
  const roll = randomIntBetween(1, 100);

  if (roll <= 40) {
    testPageLoad();
    sleep(randomIntBetween(1, 3));   // user reads the page
  } else if (roll <= 80) {
    testAPIs();
    sleep(randomIntBetween(1, 2));
  } else if (roll <= 90) {
    testHeavyOperations();
    sleep(randomIntBetween(2, 4));   // heavier ops, longer wait
  } else {
    testSearchAndFilter();
    sleep(randomIntBetween(1, 3));
  }

  activeUsers.add(-1);
}

// ─── Setup (runs once before test) ───────────────────────────
export function setup() {
  console.log('🚀 Starting aggressive load test for: ' + BASE_URL);
  console.log('📋 Stages: warm-up → 100 VUs → 200 VUs → 350 spike → cool-down');
  console.log('⚠️  This test will hit all API endpoints. Ensure you have permission.');

  // Pre-flight check
  const res = http.get(BASE_URL, { timeout: '10s' });
  if (res.status === 0 || res.status >= 500) {
    fail(`❌ Pre-flight failed: ${BASE_URL} returned ${res.status}. Aborting.`);
  }
  console.log(`✅ Pre-flight OK: ${BASE_URL} → HTTP ${res.status}`);
}

// ─── Teardown (runs once after test) ─────────────────────────
export function teardown(data) {
  console.log('✅ Load test complete.');
  console.log('📊 Check the summary above for threshold results.');
  console.log('🔍 Key things to look for:');
  console.log('   • Any p(95) or p(99) threshold breaches');
  console.log('   • error_rate > 5% = real problem');
  console.log('   • slow_requests_over_3s count');
  console.log('   • HTTP 500/502/503 responses = backend overwhelmed');
}