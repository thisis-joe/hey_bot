import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { promisify } from 'node:util';

test('public free-model probe pins provider, rejects mutable price and never sends an unsafe inference request', async t => {
  const key = 'openrouter-fixture-key', model = 'fixture/code-model:free', upstream = 'fixture-region';
  const calls = [];
  let mode = 'free';
  const api = createServer(async (req, res) => {
    const route = decodeURIComponent(req.url);
    const authorization = req.headers.authorization;
    if (req.method === 'GET') {
      calls.push({ route, authorization });
      const tag = mode === 'unapproved' ? 'unknown-upstream' : upstream;
      res.end(JSON.stringify({ data: { id: model, endpoints: [{
        tag, provider_name: 'Fixture Provider', supported_parameters: ['response_format', 'structured_outputs'],
        pricing: { prompt: mode === 'paid' ? '0.001' : '0', completion: '0', request: '0' },
      }] } }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ route, authorization, body: JSON.parse(raw) });
    if (mode === 'limited') { res.statusCode = 429; res.setHeader('retry-after', '18'); res.end('{}'); return; }
    res.end(JSON.stringify({ model, provider: 'Fixture Provider', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      premise: null, answer: '17', why: null, unverified: null, evidence: [{ path: 'sample.ts', line: 1, side: 'RIGHT', reason: 'Sample declaration' }],
    }) } }] }));
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(() => api.close());
  const env = { OPENROUTER_FREE_API_KEY: key, OPENROUTER_FREE_MODEL: model, OPENROUTER_FREE_PROVIDER: upstream,
    OPENROUTER_FREE_URL: `http://127.0.0.1:${api.address().port}/api/v1/` };
  const check = (options = {}) => promisify(execFile)(process.execPath, [new URL('../dist/runner-server.js', import.meta.url).pathname, '--check-free-model'], {
    env: { PATH: process.env.PATH, ...env, ...options }, timeout: 5000,
  });
  assert.deepEqual(JSON.parse((await check()).stdout), { ok: true, provider: 'openrouter-free', model, inferenceProvider: upstream });
  assert.deepEqual(calls.map(call => call.route), ['/api/v1/models/fixture/code-model:free/endpoints', '/api/v1/chat/completions']);
  const { body } = calls[1];
  assert.ok(calls.every(call => call.authorization === `Bearer ${key}`));
  assert.deepEqual(body.provider, {
    only: [upstream], allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0, completion: 0, request: 0 },
  });
  assert.equal(body.model, model);
  assert.match(JSON.stringify(body.messages), /defaultPageSize = 17/);
  assert.equal(body.response_format.type, 'json_schema');
  for (mode of ['paid', 'unapproved']) {
    await assert.rejects(() => check(), error => JSON.parse(error.stderr).failure.code === 'configuration');
  }
  assert.equal(calls.filter(call => call.body).length, 1);
  await assert.rejects(() => check({ OPENROUTER_FREE_MODEL: 'fixture/code-model' }), error => JSON.parse(error.stderr).failure.code === 'configuration');
  assert.equal(calls.length, 4, 'invalid model configuration performs no network request');
  mode = 'limited';
  await assert.rejects(() => check(), error => {
    const { failure } = JSON.parse(error.stderr);
    assert.equal(failure.code, 'rate_limit');
    assert.equal(failure.apiStatus, 429);
    assert.ok(Date.parse(failure.retryAt) > Date.now());
    return true;
  });
});
