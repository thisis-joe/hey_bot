import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
  const runner = await startRunner(t, { ...storage, DATA_ROOT: root, OPENAI_RESPONSES_URL: gateway + '/v1/responses' });
  const model = new HttpModel(runner.url, runner.token);
  const admin = 'admin-fixture-0000000000000000000000';
  const env = { ...storage, ADMIN_PASSWORD: admin, INTERNAL_TOKEN: 'n8n-fixture-token', RUNNER_TOKEN: runner.token,
    RUNNER_URL: runner.url, OPENAI_RESPONSES_URL: 'http://127.0.0.1:1/v1/responses' };
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
  for (const token of [runner.token, env.INTERNAL_TOKEN]) {
    const response = await fetch(runner.url + '/model-setup', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 401);
    await response.body.cancel();
  }
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

  const checkRestored = () => promisify(execFile)(process.execPath, [
    new URL('../dist/runner-server.js', import.meta.url).pathname, '--check-active-model',
  ], { env: { PATH: process.env.PATH, ...storage }, timeout: 5000 });
  const { stdout } = await checkRestored();
  assert.deepEqual(JSON.parse(stdout), { ok: true, provider: 'openai', model: modelId });
  assert.equal(credentials.at(-1), `Bearer ${rotated}`);

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

test('the admin registers Claude and keyless Ollama with their own catalog and endpoint', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hey-admin-providers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = '88888888-8888-4888-8888-888888888888';
  await mkdir(join(root, 'jobs', workspace, 'source'), { recursive: true });
  const calls = [];
  const gateway = await local(t, createServer(async (req, res) => {
    calls.push({ url: req.url, key: req.headers['x-api-key'], auth: req.headers.authorization });
    if (req.url.startsWith('/v1/models')) {
      res.end(JSON.stringify({ data: [{ id: 'claude-fixture', display_name: 'Claude Fixture' }], has_more: false, last_id: 'claude-fixture' })); return;
    }
    if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'local:fixture', size: 23 }] })); return; }
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw), claude = req.url === '/v1/messages';
    const checking = body.messages.some(message => /^Use the snapshot read tool/.test(message.content));
    const reply = JSON.stringify(checking ? { premise: null, answer: '17', why: null, unverified: null,
      evidence: [{ path: 'sample.ts', line: 1, side: 'RIGHT', reason: 'Declared value' }] } : { questions: initialQuestions() });
    if (claude) {
      assert.equal(body.model, 'claude-fixture');
      const tool = checking && body.messages.length < 2;
      res.end(JSON.stringify(tool ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'sample', name: 'read_file', input: { path: 'sample.ts' } }] }
        : { stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] }));
    } else {
      assert.equal(body.model, 'local:fixture');
      const message = { role: 'assistant', content: body.format ? reply : '' };
      if (checking && body.tools) message.tool_calls = [{ type: 'function', function: { name: 'read_file', arguments: { path: 'sample.ts' } } }];
      res.end(JSON.stringify({ done: true, done_reason: 'stop', message }));
    }
  }));
  const storage = { MODEL_SETTINGS_PATH: join(root, 'settings.json'), MODEL_SETTINGS_KEY: 'fd'.repeat(32) };
  const runner = await startRunner(t, { ...storage, DATA_ROOT: root, CLAUDE_API_BASE_URL: gateway, OLLAMA_URL: gateway });
  const admin = 'admin-fixture-0000000000000000000000';
  const url = await local(t, application({}, [], { ...storage, ADMIN_PASSWORD: admin, RUNNER_URL: runner.url,
    CLAUDE_API_BASE_URL: gateway, OLLAMA_URL: gateway }));
  const login = await fetch(url + '/admin', { headers: { authorization: `Basic ${Buffer.from(`admin:${admin}`).toString('base64')}` } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const csrf = (await login.text()).match(/name="csrf" value="([^"]+)"/)[1];
  for (const [provider, model, key] of [['claude-api', 'claude-fixture', 'fixture-claude-api-key'], ['ollama', 'local:fixture', '']]) {
    const submit = intent => fetch(url + '/admin', { method: 'POST', redirect: 'manual', headers: { cookie, origin: url },
      body: new URLSearchParams({ intent, csrf, provider, model, key }) });
    const list = await submit('catalog');
    assert.equal(list.status, 200);
    assert.match(await list.text(), new RegExp(model));
    const save = await submit('save');
    assert.equal(save.status, 303, await save.text());
    const active = await new HttpModel(runner.url, runner.token).run('initial_questions', 'Fixture questions', workspace, 5000);
    assert.deepEqual(active, { questions: initialQuestions() });
    assert.doesNotMatch(await readFile(storage.MODEL_SETTINGS_PATH, 'utf8'), /fixture-claude-api-key/);
  }
  assert.ok(calls.some(call => call.url === '/v1/messages' && call.key === 'fixture-claude-api-key'));
  assert.ok(calls.some(call => call.url === '/api/chat' && call.auth === undefined && call.key === undefined));
});
