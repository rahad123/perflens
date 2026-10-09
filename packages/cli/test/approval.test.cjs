const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuditApprovals } = require('../dist/audit/approval');

test('known Docker restart and bounded load share one explicit approval', async () => {
  const questions = [];
  const approvals = createAuditApprovals({
    target: 'http://localhost:3000', endpoints: [{ method: 'GET', path: '/orders' }, { method: 'GET', path: '/products' }], profiles: ['baseline', 'normal'],
    prompt: async question => { questions.push(question); return true; },
  });
  assert.equal(await approvals.approveRestart('api'), true);
  assert.equal(await approvals.approveLoad(), true);
  assert.equal(questions.length, 1);
  assert.match(questions[0], /Target: http:\/\/localhost:3000/);
  assert.match(questions[0], /GET \/orders[\s\S]*GET \/products/);
  assert.match(questions[0], /baseline, normal/);
  assert.match(questions[0], /temporarily restart the local Node service "api"/);
});

test('denied restart approval cannot be upgraded to load approval', async () => {
  let prompts = 0;
  const approvals = createAuditApprovals({ target: 'http://localhost:3000', endpoints: [{ method: 'GET', path: '/orders' }], profiles: ['baseline', 'normal'], prompt: async () => { prompts++; return false; } });
  assert.equal(await approvals.approveRestart('api'), false);
  assert.equal(await approvals.approveLoad(), false);
  assert.equal(prompts, 2);
});

test('load-only approval includes the tested scope when no restart is needed', async () => {
  let question = '';
  const approvals = createAuditApprovals({ target: 'http://localhost:3000', endpoints: [{ method: 'GET', path: '/orders' }], profiles: ['baseline'], prompt: async message => { question = message; return true; } });
  assert.equal(await approvals.approveLoad(), true);
  assert.match(question, /GET \/orders/);
  assert.doesNotMatch(question, /restart/);
});
