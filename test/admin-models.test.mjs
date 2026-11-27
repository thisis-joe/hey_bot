import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { application } from '../dist/application.js';
import { HttpModel } from '../dist/codex.js';
import { initialQuestions } from './fixtures.mjs';
import { startRunner } from './model-runner-fixture.mjs';

async function local(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('administrator tests, replaces and clears the active key through the shared Runner settings', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'hey-admin-models-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = '88888888-8888-4888-8888-888888888888';
  await mkdir(join(root, 'jobs', workspace, 'source'), { recursive: true });
  const modelId = 'responses-fixture-model', key = 'active-fixture-key', drafts = { questions: initialQuestions() };
  const calls = [], credentials = [], rotated = 'rotated-fixture-key';
  let paused;
  const gateway = await local(t, createServer(async (req, res) => {
    calls.push(req.url);
    credentials.push(req.headers.authorization);
    if (![key, rotated].some(value => req.headers.authorization === `Bearer ${value}`)) { res.statusCode = 401; res.end('{}'); return; }
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: modelId }] })); return; }
    let raw = '';
    for await (const part of req) raw += part;
    const input = JSON.parse(raw), check = input.text.format.name === 'answer';
    assert.equal(input.model, modelId);
    if (!check && paused) {
      paused.arrived.resolve();
      await paused.release.promise;
      res.end(JSON.stringify({ status: 'completed', output: [
        { type: 'function_call', name: 'list_files', call_id: 'after-revoke', arguments: '{}' },
      ] }));
      return;
    }
    const output = check && !input.input.some(item => item.type === 'function_call_output')
      ? [{ type: 'function_call', name: 'read_file', call_id: 'file', arguments: '{"path":"sample.ts"}' }]
      : [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(check ? {
        premise: null, answer: '17', why: null, unverified: null, evidence: [{ path: 'sample.ts', line: 1, side: 'RIGHT', reason: 'Sample declaration' }],
      } : drafts) }] }];
    res.end(JSON.stringify({ status: 'completed', output }));
  }));
  const storage = { MODEL_SETTINGS_PATH: join(root, 'settings.json'), MODEL_SETTINGS_KEY: 'ba'.repeat(32) };
  const runner = await startRunner(t, { ...storage, DATA_ROOT: root });
  const model = new HttpModel(runner.url, runner.token);
  const admin = 'admin-fixture-0000000000000000000000';
  const env = { ...storage, ADMIN_PASSWORD: admin, INTERNAL_TOKEN: 'n8n-fixture-token', RUNNER_TOKEN: runner.token,
    RUNNER_URL: runner.url, OPENAI_RESPONSES_URL: gateway + '/v1/responses' };
  const url = await local(t, application({}, [], env));
  const auth = `Basic ${Buffer.from(`admin:${admin}`).toString('base64')}`;
  const login = await fetch(url + '/admin', { headers: { authorization: auth } });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly.*SameSite=Strict/);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const html = await login.text(), csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf);
  const submit = (values, headers = {}) => fetch(url + '/admin', {
    method: 'POST', redirect: 'manual', headers: { cookie, origin: url, ...headers },
    body: new URLSearchParams({ csrf, provider: 'openai', model: modelId, key, ...values }),
  });
  const getModel = () => model.run('initial_questions', 'Fixture questions', workspace, 5000);
  await assert.rejects(getModel, error => error.failure?.code === 'unconfigured');
  for (const [values, headers, expected] of [
    [{ intent: 'save' }, { cookie: '', authorization: `Bearer ${runner.token}` }, 401],
    [{ intent: 'save' }, { cookie: '', authorization: `Bearer ${env.INTERNAL_TOKEN}` }, 401],
    [{ intent: 'save', csrf: 'wrong' }, {}, 403],
    [{ intent: 'save' }, { origin: 'http://other.test' }, 403],
  ]) {
    const denied = await submit(values, headers);
    assert.equal(denied.status, expected);
    await denied.text();
  }
  assert.equal(calls.length, 0);
  const catalog = await submit({ intent: 'catalog', model: '' });
  assert.equal(catalog.status, 200);
  assert.match(await catalog.text(), new RegExp(modelId));

  const applied = await submit({ intent: 'save' });
  assert.equal(applied.status, 303);
  assert.deepEqual(await getModel(), drafts);
  const saved = await readFile(storage.MODEL_SETTINGS_PATH, 'utf8');
  assert.doesNotMatch(saved, /active-fixture-key/);
  const active = await fetch(url + '/admin', { headers: { cookie } });
  assert.equal(active.status, 200);
  const page = await active.text();
  assert.match(page, new RegExp(modelId));
  assert.doesNotMatch(page, /active-fixture-key/);

  const failure = await submit({ intent: 'save', key: 'wrong-fixture-key' });
  assert.equal(failure.status, 422);
  assert.doesNotMatch(await failure.text(), /wrong-fixture-key/);
  assert.equal(await readFile(storage.MODEL_SETTINGS_PATH, 'utf8'), saved);
  assert.deepEqual(await getModel(), drafts);
  assert.equal(credentials.at(-1), `Bearer ${key}`);

  assert.equal((await submit({ intent: 'save', key: rotated })).status, 303);
  assert.deepEqual(await getModel(), drafts);
  assert.equal(credentials.at(-1), `Bearer ${rotated}`);
  assert.doesNotMatch(await readFile(storage.MODEL_SETTINGS_PATH, 'utf8'), /rotated-fixture-key/);

  paused = { arrived: Promise.withResolvers(), release: Promise.withResolvers() };
  const inFlight = assert.rejects(getModel, error => error.failure?.code === 'configuration');
  await paused.arrived.promise;
  try {
    assert.equal((await submit({ intent: 'clear' })).status, 303);
  } finally {
    paused.release.resolve();
  }
  const beforeClear = calls.length;
  await inFlight;
  await assert.rejects(getModel, error => error.failure?.code === 'unconfigured');
  assert.equal(calls.length, beforeClear, 'revocation prevents further rounds and new requests');
});
