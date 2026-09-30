import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 5,
  duration: '30s',
  thresholds: { http_req_failed: ['rate<0.01'], checks: ['rate>0.99'] },
};

export default function () {
  const response = http.get(`${__ENV.BASE_URL || 'http://localhost:3000'}/orders`, {
    tags: { name: 'GET /orders' },
    timeout: '10s',
  });
  check(response, {
    'orders returns 200': (r) => r.status === 200,
    'orders returns a bounded array': (r) => {
      try { const body = r.json(); return Array.isArray(body) && body.length <= 20; }
      catch { return false; }
    },
  });
  sleep(1);
}
