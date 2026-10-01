const test = require('node:test');
const assert = require('node:assert/strict');
const { readPerfLensCorrelation } = require('../dist/index.js');

const runId = 'pfl_20260930T120000000Z_123e4567-e89b-12d3-a456-426614174000';

test('maps valid PerfLens audit correlation headers without copying unrelated headers', () => {
  assert.deepEqual(readPerfLensCorrelation({
    'x-perflens-run-id': runId, 'x-perflens-profile': 'normal', authorization: 'Bearer secret', cookie: 'secret=1',
  }), { runId, profile: 'normal' });
});

test('allows absent and malformed correlation without creating metadata', () => {
  assert.deepEqual(readPerfLensCorrelation({}), {});
  assert.deepEqual(readPerfLensCorrelation({ 'x-perflens-run-id': 'not-a-run', 'x-perflens-profile': 'stress' }), {});
  assert.deepEqual(readPerfLensCorrelation({ 'x-perflens-run-id': runId, 'x-perflens-profile': 'unknown' }), { runId });
  assert.deepEqual(readPerfLensCorrelation({ 'x-perflens-run-id': 'x'.repeat(100000), 'x-perflens-profile': 'normal' }), {});
});
