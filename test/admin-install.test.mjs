import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { application } from '../dist/application.js';

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('the local setup page authenticates an administrator and shows the unconfigured runner', async t => {
  let runnerCalls = 0;
  const runner = await listen(t, createServer((req, res) => {
    runnerCalls++;
    assert.equal(req.url, '/healthz');
    res.end(JSON.stringify({ ok: true, modelStatus: 'unconfigured' }));
  }));
  const password = 'fixture-admin-only-password-000000', internal = 'fixture-internal-only-token-000000', token = 'fixture-runner-only-token-0000000';
  const url = await listen(t, application({}, [], { ADMIN_PASSWORD: password, INTERNAL_TOKEN: internal, RUNNER_TOKEN: token, RUNNER_URL: runner }));
  for (const authorization of ['', `Bearer ${internal}`, `Bearer ${token}`, `Basic ${Buffer.from(`admin:${internal}`).toString('base64')}`]) {
    const denied = await fetch(`${url}/admin`, { headers: { authorization } });
    assert.equal(denied.status, 401);
    await denied.text();
  }
  assert.equal(runnerCalls, 0);
  const authorization = `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
  const response = await fetch(`${url}/admin`, { headers: { authorization } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(await response.text(), /모델 미설정/);
  assert.equal(runnerCalls, 1);
});
