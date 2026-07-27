// Backend Phase 3, acceptance criterion 6: 200 concurrent snapshot saves.
//
//   k6 run apps/api/loadtest/snapshot.js
//   BASE_URL=https://staging.example.com VUS=200 k6 run apps/api/loadtest/snapshot.js
//
// Each virtual user signs up its own account, so there is no shared-row
// contention that would make this a test of one workspace's lock rather than
// of the service. Requires the API reachable at BASE_URL with signups enabled.
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:8000';
const VUS = parseInt(__ENV.VUS || '200', 10);

const snapshotSave = new Trend('snapshot_save_ms', true);
const snapshotRead = new Trend('snapshot_read_ms', true);
const errors = new Rate('business_errors');

export const options = {
  scenarios: {
    snapshot_saves: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: VUS },
        { duration: '1m', target: VUS },
        { duration: '15s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    // Under concurrency, not the single-request budget. Phase 2's "p95 < 150ms
    // for a snapshot GET" is measured unloaded by tests/test_performance.py
    // (~12ms against PostgreSQL); expecting that number while 200 users hammer
    // one instance would just be a threshold nobody trusts. What matters here
    // is that the service stays correct and bounded as load rises.
    'snapshot_save_ms': ['p(95)<1500'],
    'snapshot_read_ms': ['p(95)<800'],
    // These are the real assertions: nothing fails, nothing errors.
    'business_errors': ['rate<0.01'],
    'http_req_failed': ['rate<0.01'],
  },
};

function uuid(seed) {
  // k6 has no crypto.randomUUID. Child ids are global primary keys, so they
  // must differ per virtual user *and* per iteration — a shared snapshot makes
  // every VU after the first collide instead of exercising the save path.
  const hex = (n) => Math.floor(Math.random() * 16 ** n).toString(16).padStart(n, '0');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${seed.toString(16).padStart(12, '0')}`;
}

function buildSnapshot() {
  const queries = [];
  for (let i = 0; i < 50; i++) {
    queries.push({
      id: uuid(i),
      name: `query ${i}`,
      sql: `SELECT region, sum(amount) FROM orders WHERE region = 'r${i}' GROUP BY region`,
      position: i,
    });
  }
  const charts = [];
  for (let i = 0; i < 20; i++) {
    charts.push({
      id: uuid(1000 + i),
      query_id: queries[i].id,
      spec: { version: 1, type: 'bar', x: 'region', y: 'amount' },
    });
  }
  return {
    name: 'Load test workspace',
    settings: { theme: 'dark' },
    datasets: [
      {
        id: uuid(2000),
        name: 'orders',
        format: 'csv',
        schema: { columns: [{ name: 'id', type: 'BIGINT' }, { name: 'region', type: 'VARCHAR' }] },
        row_count: 1000000,
      },
    ],
    queries,
    charts,
    dashboards: [{ id: uuid(3000), name: 'Overview', layout: { version: 1, grid: [] } }],
  };
}

const json = (token) => ({
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
});

export function setup() {
  const res = http.get(`${BASE}/healthz`);
  check(res, { 'api is up': (r) => r.status === 200 });
  return {};
}

export default function () {
  // Built per iteration so its ids are unique (see `uuid`).
  const snapshot = buildSnapshot();
  // email-validator rejects reserved TLDs like .invalid/.test, so use the
  // same example.com the test suite uses.
  const email = `load-${__VU}-${__ITER}-${Date.now()}@example.com`;
  const password = 'load-test-password';
  let token;

  group('signup', () => {
    const res = http.post(
      `${BASE}/api/v1/auth/signup`,
      JSON.stringify({ email, password }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    // 429 is the rate limiter doing its job, not a failure of the service.
    if (res.status === 429) return;
    check(res, { 'signed up': (r) => r.status === 201 }) || errors.add(1);

    const login = http.post(
      `${BASE}/api/v1/auth/login`,
      JSON.stringify({ email, password }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    if (login.status === 200) token = login.json('access_token');
  });

  if (!token) {
    sleep(1);
    return;
  }

  let workspaceId;
  group('create workspace', () => {
    const res = http.post(
      `${BASE}/api/v1/workspaces`,
      JSON.stringify({ name: 'Load test' }),
      json(token),
    );
    check(res, { 'workspace created': (r) => r.status === 201 }) || errors.add(1);
    if (res.status === 201) workspaceId = res.json('id');
  });

  if (!workspaceId) return;
  const url = `${BASE}/api/v1/workspaces/${workspaceId}/snapshot`;

  group('snapshot save', () => {
    const res = http.put(url, JSON.stringify(snapshot), json(token));
    snapshotSave.add(res.timings.duration);
    check(res, { 'snapshot saved': (r) => r.status === 200 }) || errors.add(1);
  });

  group('snapshot read', () => {
    const res = http.get(url, json(token));
    snapshotRead.add(res.timings.duration);
    check(res, {
      'snapshot read': (r) => r.status === 200,
      'has 50 queries': (r) => (r.json('queries') || []).length === 50,
    }) || errors.add(1);
  });

  sleep(1);
}
