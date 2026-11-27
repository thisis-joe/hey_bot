import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import * as contracts from '../dist/contracts.js';
import { Codex, HttpModel } from '../dist/codex.js';
import { ClaudeCode } from '../dist/claude.js';
import { generateQuestions } from '../dist/review.js';
import { readPolicy } from '../dist/policy.js';
import { changeQuestions, checked, snapshot } from './fixtures.mjs';

const questions = count => Array.from({ length: count }, (_, i) => ({
  ...changeQuestions()[i % 3], question: `변경된 처리 조건 ${i + 1}은 무엇인가요?`,
}));

test('initial question contract accepts exactly two basic questions and rejects review output', () => {
  assert.ok(contracts.InitialQuestionsSchema, 'initial question contract must be exported');
  assert.equal(contracts.InitialQuestionsSchema.safeParse({ questions: questions(2) }).success, true);
  assert.equal(contracts.InitialQuestionsSchema.safeParse({ questions: questions(2).reverse() }).success, true, 'both priority orders are accepted');
  for (const count of [0, 1, 3, 4, 5, 10]) {
    assert.equal(contracts.InitialQuestionsSchema.safeParse({ questions: questions(count) }).success, false);
  }
  for (const levels of [['basic', 'basic'], ['advanced', 'advanced']]) {
    assert.equal(contracts.InitialQuestionsSchema.safeParse({ questions: questions(2).map((q, i) => ({ ...q, level: levels[i] })) }).success, levels.every(level => level === 'basic'), levels.join());
  }
  for (const field of ['summary', 'findings', 'checks', 'recommendedTests', 'limitations', 'resolutions']) {
    assert.equal(contracts.InitialQuestionsSchema.safeParse({ questions: questions(2), [field]: [] }).success, false, field);
  }
});

// The subprocess reads the actual CLI schema, then returns output through the provider's real boundary.
// This catches mapping mistakes that a Model mock cannot exercise.
for (const [provider, Model] of [['Codex', Codex], ['Claude', ClaudeCode]]) {
  test(`${provider} initial question CLI receives only the two-question schema`, { timeout: 30000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'crb-initial-questions-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const id = '77777777-7777-4777-8777-777777777777';
    await mkdir(join(root, 'jobs', id, 'source'), { recursive: true });
    const binary = join(root, `fake-${provider.toLowerCase()}`);
    const model = new Model(root, join(root, 'auth'), binary);
    const reply = value => `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2), at = flag => args[args.indexOf(flag) + 1];
const codex = args.includes('--output-schema');
const schema = codex ? JSON.parse(fs.readFileSync(at('--output-schema'), 'utf8')) : JSON.parse(at('--json-schema'));
if (schema.additionalProperties !== false || Object.keys(schema.properties).join() !== 'questions' || schema.required.join() !== 'questions' || schema.properties.questions.minItems !== 2 || schema.properties.questions.maxItems !== 2) process.exit(42);
if (schema.properties.questions.items.properties.level.const !== 'basic') process.exit(44);
if (!codex && !/question and learning assistant/i.test(at('--system-prompt'))) process.exit(43);
const value = ${JSON.stringify(value)};
if (codex) fs.writeFileSync(at('-o'), JSON.stringify(value));
else process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: value }));
`;
    const value = { questions: questions(2) };
    await writeFile(binary, reply(value), { mode: 0o755 });
    assert.deepEqual(await model.run('initial_questions', 'Ask about the pinned code change.', id, 5000), value);
    for (const value of [{ questions: questions(3) }, { questions: questions(5) }, { questions: questions(2), findings: [] }]) {
      await writeFile(binary, reply(value), { mode: 0o755 });
      await assert.rejects(() => model.run('initial_questions', 'Ask about the pinned code change.', id, 5000));
    }
  });
}

for (const phase of ['initial_questions', 'csinterview', 'morecs']) test(`isolated runner HTTP accepts the ${phase} phase`, { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'crb-initial-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = '88888888-8888-4888-8888-888888888888';
  await mkdir(join(root, 'jobs', id, 'source'), { recursive: true });
  const outputs = { initial_questions: { questions: questions(2) }, csinterview: { questions: questions(2).map(checked), unavailableReason: null },
    morecs: { questions: questions(2).map(q => checked({ ...q, kind: 'followup', anchor: '면접1' })), unavailableReason: '면접1만 더 파고들 근거가 있습니다.' } };
  const binary = join(root, 'fake-codex'), value = outputs[phase];
  await writeFile(binary, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.writeFileSync(args[args.indexOf('-o') + 1], ${JSON.stringify(JSON.stringify(value))});
`, { mode: 0o755 });
  const { url, token } = await startRunner(t, { MODEL_PROVIDER: 'codex', DATA_ROOT: root, CODEX_HOME: join(root, 'auth'), CODEX_BINARY: binary });
  const response = await fetch(`${url}/run`, {
    method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ phase, prompt: 'Ask about the pinned code change.', workspaceId: id, timeoutMs: 5000 }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), value);
});

async function startRunner(t, env) {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const token = 'initial-questions-runner-test-token';
  const child = spawn(process.execPath, [new URL('../dist/runner-server.js', import.meta.url).pathname], {
    env: { PATH: process.env.PATH, PORT: String(port), RUNNER_TOKEN: token, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Runner did not become ready')), 5000);
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('"ready":true')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Runner exited before readiness (${code})`)); });
  });
  return { url: `http://127.0.0.1:${port}`, token };
}

test('controller-to-runner HTTP uses the blind gate for Luna and leaves Sol on one stage', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'crb-blind-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = '88888888-8888-4888-8888-888888888888', sourceDir = join(root, 'jobs', id, 'source');
  const path = 'src/pay.ts', source = 'function pay() {\n  charge();\n}', calls = [];
  await mkdir(join(sourceDir, 'src'), { recursive: true });
  await writeFile(join(sourceDir, path), source);
  const drafts = questions(2), replacement = { ...drafts[0], question: '재출제된 처리 조건은 무엇인가요?' };
  const solution = (id, answer) => ({ id, answer, evidence: { path, line: 2, side: 'RIGHT', reason: '승인 호출' } });
  const gateway = createHttpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), phase = body.text.format.name;
    calls.push({ model: body.model, phase, input: body.input });
    const n = calls.length;
    const result = phase === 'initial_questions' ? { questions: drafts }
      : phase === 'repair_initial_questions' ? { questions: [{ id: 1, ...replacement }] }
      : { checks: n === 2 ? [solution(1, 'A'), solution(2, 'B')] : [solution(1, 'B')] };
    res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }));
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => gateway.close());
  const ctx = { files: { [path]: source }, diff: { [path]: { oldPath: path, patch: '@@ -2 +2 @@\n+  charge();', lines: new Set([2]) } }, excluded: [], limited: false, sourceDir };
  for (const name of ['gpt-6-luna', 'gpt-6.1-sol']) {
    const selection = name === 'gpt-6-luna' ? {} : { MODEL_PROVIDER: 'gms', GMS_MODEL: name };
    const { url, token } = await startRunner(t, { ...selection, DATA_ROOT: root, GMS_KEY: 'fixture-only', GMS_RESPONSES_URL: `http://127.0.0.1:${gateway.address().port}/responses` });
    const result = await generateQuestions(new HttpModel(url, token), id, snapshot(), readPolicy(), ctx, null, [], [], 'full', 5000);
    assert.deepEqual(result.questions, name === 'gpt-6-luna' ? [replacement, drafts[1]] : drafts);
  }
  assert.deepEqual(calls.map(c => [c.model, c.phase]), [
    ['gpt-6-luna', 'initial_questions'], ['gpt-6-luna', 'verify_initial_questions'],
    ['gpt-6-luna', 'repair_initial_questions'], ['gpt-6-luna', 'verify_initial_questions'], ['gpt-6.1-sol', 'initial_questions'],
  ]);
  for (const { input } of [calls[1], calls[3]]) {
    assert.equal(input.length, 1, 'solver starts without writer history');
    assert.doesNotMatch(input[0].content, /정답은 B입니다|보기 해설/);
  }
});

test('OpenAI connection checks public sample tools and generates questions through the normal runner', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'hey-openai-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = '88888888-8888-4888-8888-888888888888', sourceDir = join(root, 'jobs', id, 'source');
  const path = 'src/pay.ts', source = 'function pay() {\n  charge();\n}';
  await mkdir(join(sourceDir, 'src'), { recursive: true });
  await writeFile(join(sourceDir, path), source);
  const drafts = questions(2), requests = [];
  let skipSampleRead = false;
  const gateway = createHttpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), phase = body.text.format.name;
    requests.push({ authorization: req.headers.authorization, url: req.url, body });
    const isCheck = phase === 'answer', file = isCheck ? 'sample.ts' : path;
    const toolResult = body.input.find(item => item.type === 'function_call_output');
    const result = isCheck
      ? { premise: null, answer: '17', why: null, evidence: [{ path: file, line: 1, side: 'RIGHT', reason: 'Declared value' }], unverified: null }
      : { questions: drafts };
    const output = toolResult || (isCheck && skipSampleRead)
      ? [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }]
      : [{ type: 'function_call', name: 'read_file', call_id: 'read-1', arguments: JSON.stringify({ path: file }) }];
    res.end(JSON.stringify({ status: 'completed', output }));
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => gateway.close());
  const env = {
    MODEL_PROVIDER: 'openai', OPENAI_MODEL: 'fixture-responses-model', OPENAI_API_KEY: 'openai-fixture-only',
    OPENAI_RESPONSES_URL: `http://127.0.0.1:${gateway.address().port}/v1/responses`, DATA_ROOT: root,
    GMS_KEY: 'inactive-gms-key',
  };
  const checkModel = () => promisify(execFile)(process.execPath, [new URL('../dist/runner-server.js', import.meta.url).pathname, '--check-model'], {
    env: { PATH: process.env.PATH, ...env }, timeout: 5000,
  });
  const { stdout } = await checkModel();
  assert.deepEqual(JSON.parse(stdout), { ok: true, provider: 'openai', model: 'fixture-responses-model' });
  assert.equal(requests.length, 2);
  assert.doesNotMatch(JSON.stringify(requests), /src\/pay.ts|charge\(\)|inactive-gms-key/);
  assert.match(requests[1].body.input.at(-1).output, /defaultPageSize = 17/);

  const { url, token } = await startRunner(t, env);
  const ctx = { files: { [path]: source }, diff: { [path]: { oldPath: path, patch: '@@ -2 +2 @@\n+  charge();', lines: new Set([2]) } }, excluded: [], limited: false, sourceDir };
  const result = await generateQuestions(new HttpModel(url, token), id, snapshot(), readPolicy(), ctx, null, [], [], 'full', 5000);
  assert.deepEqual(result.questions, drafts);
  assert.equal(requests.length, 4);
  for (const { authorization, url, body } of requests) {
    assert.equal(authorization, 'Bearer openai-fixture-only');
    assert.equal(url, '/v1/responses');
    assert.equal(body.model, 'fixture-responses-model');
    assert.equal(body.store, false);
    assert.deepEqual(body.include, ['reasoning.encrypted_content']);
    assert.ok(body.tools.some(tool => tool.name === 'read_file'));
    assert.equal(body.text.format.type, 'json_schema');
  }
  assert.match(requests[3].body.input.at(-1).output, /charge\(\)/);
  skipSampleRead = true;
  await assert.rejects(checkModel, error => {
    assert.equal(error.code, 1);
    assert.deepEqual(JSON.parse(error.stderr), { ok: false, failure: { code: 'invalid_output', provider: 'openai' } });
    return true;
  });
  assert.equal(requests.length, 5);
});

test('runner stays healthy with absent or invalid model configuration and reports distinct execution failures', async t => {
  for (const { env, modelStatus, failure } of [
    { env: {}, modelStatus: 'unconfigured', failure: { code: 'unconfigured' } },
    { env: { MODEL_PROVIDER: 'gms' }, modelStatus: 'invalid', failure: { code: 'configuration', provider: 'gms' } },
    { env: { MODEL_PROVIDER: 'openai', OPENAI_API_KEY: 'fixture' }, modelStatus: 'invalid', failure: { code: 'configuration', provider: 'openai' } },
  ]) {
    const { url, token } = await startRunner(t, env);
    assert.deepEqual(await (await fetch(`${url}/healthz`)).json(), { ok: true, busy: false, modelStatus });
    await assert.rejects(() => new HttpModel(url, token).run('initial_questions', 'fixture', '88888888-8888-4888-8888-888888888888', 5000),
      error => { assert.deepEqual(error.failure, failure); return true; });
  }
});

test('runner keeps legacy CLI model selection, login directories and credential variables', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hey-cli-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = '88888888-8888-4888-8888-888888888888';
  await mkdir(join(root, 'jobs', id, 'source'), { recursive: true });
  const value = { questions: questions(2) };
  for (const provider of ['codex', 'claude']) {
    const prefix = provider.toUpperCase();
    const home = join(root, provider), binary = join(root, `fake-${provider}`), model = `${provider}-fixture-model`;
    const codex = provider === 'codex';
    const homeKey = codex ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR', tokenKey = codex ? 'CODEX_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN';
    await writeFile(binary, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2), at = name => args[args.indexOf(name) + 1];
if (at('--model') !== ${JSON.stringify(model)} || process.env.${homeKey} !== ${JSON.stringify(home)} || process.env.${tokenKey} !== 'legacy-cli-fixture') process.exit(42);
const value = ${JSON.stringify(value)};
if (${codex}) fs.writeFileSync(at('-o'), JSON.stringify(value));
else console.log(JSON.stringify({ type: 'result', subtype: 'success', structured_output: value }));
`, { mode: 0o755 });
    const { url, token } = await startRunner(t, {
      MODEL_PROVIDER: provider, DATA_ROOT: root, [homeKey]: home, [tokenKey]: 'legacy-cli-fixture',
      [`${prefix}_MODEL`]: model, [`${prefix}_BINARY`]: binary,
    });
    const result = await new HttpModel(url, token).initialQuestions('fixture', id, 5000);
    assert.deepEqual(result, { output: value, verify: false });
  }
});

test('Claude API lists models for its key and uses the chosen ID through the runner', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'hey-claude-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = '88888888-8888-4888-8888-888888888888', source = join(root, 'jobs', id, 'source');
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, 'src/pay.ts'), 'function pay() {\n  charge();\n}');
  const drafts = questions(2), requests = [];
  let rateLimited = false, invalidDrafts = false;
  const gateway = createHttpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://fixture'), body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, url, headers: req.headers, body });
    res.setHeader('content-type', 'application/json');
    if (req.headers['x-api-key'] !== 'anthropic-fixture-only') {
      res.statusCode = 401; res.end('{"error":{"message":"provider-private-auth-detail"}}'); return;
    }
    if (req.method === 'GET') {
      const after = url.searchParams.get('after_id');
      const model = after ? { id: 'claude-fixture-20261127', display_name: 'Fixture Two' } : { id: 'claude-fixture-20261021', display_name: 'Fixture One' };
      res.end(JSON.stringify({ data: [model], has_more: !after, last_id: model.id })); return;
    }
    if (rateLimited) {
      res.statusCode = 429; res.setHeader('retry-after', '19'); res.end('{"error":{"message":"provider-private-quota-detail"}}'); return;
    }
    const prompt = body.messages[0].content, isCheck = /^Use the snapshot read tool/.test(prompt);
    const toolResult = body.messages.length > 1;
    const result = isCheck
      ? { premise: null, answer: '17', why: null, evidence: [{ path: 'sample.ts', line: 1, side: 'RIGHT', reason: 'Declared value' }], unverified: null }
      : { questions: invalidDrafts ? drafts.slice(0, 1) : drafts };
    res.end(JSON.stringify(toolResult
      ? { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(result) }] }
      : { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: isCheck ? 'sample.ts' : 'src/pay.ts' } }] }));
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => gateway.close());
  const env = {
    MODEL_PROVIDER: 'claude-api', ANTHROPIC_API_KEY: 'anthropic-fixture-only', CLAUDE_API_BASE_URL: `http://127.0.0.1:${gateway.address().port}`,
    DATA_ROOT: root, CLAUDE_CODE_OAUTH_TOKEN: 'inactive-cli-credential',
  };
  const cli = (arg, settings = {}) => promisify(execFile)(process.execPath, [new URL('../dist/runner-server.js', import.meta.url).pathname, arg], {
    env: { PATH: process.env.PATH, ...env, ...settings }, timeout: 5000,
  });
  const { stdout } = await cli('--list-models');
  assert.deepEqual(JSON.parse(stdout), { ok: true, provider: 'claude-api', models: [
    { id: 'claude-fixture-20261021', name: 'Fixture One' },
    { id: 'claude-fixture-20261127', name: 'Fixture Two' },
  ] });
  assert.equal(requests[1].url.searchParams.get('after_id'), 'claude-fixture-20261021');
  assert.ok(requests.slice(0, 2).every(r => r.url.pathname === '/v1/models' && r.method === 'GET'));

  const selected = { CLAUDE_MODEL: 'claude-fixture-20261127' };
  const check = await cli('--check-model', selected);
  assert.deepEqual(JSON.parse(check.stdout), { ok: true, provider: 'claude-api', model: selected.CLAUDE_MODEL });
  assert.match(requests[3].body.messages.at(-1).content[0].content, /defaultPageSize = 17/);
  assert.doesNotMatch(JSON.stringify(requests.slice(2, 4)), /src\/pay.ts|charge\(\)/);

  const { url, token } = await startRunner(t, { ...env, ...selected });
  const model = new HttpModel(url, token);
  assert.deepEqual(await model.initialQuestions('Create two questions.', id, 5000), { output: { questions: drafts }, verify: false });
  const called = requests.slice(2, 6);
  for (const { method, url, headers, body } of called) {
    assert.equal(method, 'POST'); assert.equal(url.pathname, '/v1/messages');
    assert.equal(headers['x-api-key'], env.ANTHROPIC_API_KEY);
    assert.ok(headers['anthropic-version']); assert.equal(headers.authorization, undefined);
    assert.equal(body.model, selected.CLAUDE_MODEL);
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.ok(body.tools.some(tool => tool.name === 'read_file'));
  }
  const finalMessage = requests[5].body.messages.at(-1);
  assert.equal(finalMessage.role, 'user');
  assert.equal(finalMessage.content[0].tool_use_id, 'toolu_1');
  assert.match(finalMessage.content[0].content, /charge\(\)/);
  assert.equal(requests[5].body.output_config.format.schema.properties.questions.maxItems, undefined);
  assert.doesNotMatch(JSON.stringify(requests), /inactive-cli-credential/);

  invalidDrafts = true;
  await assert.rejects(() => model.run('initial_questions', 'Create two questions.', id, 5000), error => error.failure?.code === 'invalid_output');
  rateLimited = true;
  await assert.rejects(() => model.run('initial_questions', 'Create two questions.', id, 5000), error => {
    assert.equal(error.failure?.code, 'rate_limit'); assert.equal(error.failure.apiStatus, 429);
    const wait = Date.parse(error.failure.retryAt) - Date.now();
    assert.ok(wait > 16000 && wait <= 19000, `Unexpected retry delay ${wait}`);
    assert.doesNotMatch(String(error), /provider-private/);
    return true;
  });
  await assert.rejects(() => cli('--list-models', { ANTHROPIC_API_KEY: 'wrong-fixture-key' }), error => {
    assert.deepEqual(JSON.parse(error.stderr), { ok: false, failure: { code: 'authentication', provider: 'claude-api', apiStatus: 401 } });
    return true;
  });
  const wrong = await startRunner(t, { ...env, ...selected, ANTHROPIC_API_KEY: 'wrong-fixture-key' });
  await assert.rejects(() => new HttpModel(wrong.url, wrong.token).run('initial_questions', 'fixture', id, 5000), error => {
    assert.deepEqual(error.failure, { code: 'authentication', provider: 'claude-api', apiStatus: 401 });
    return true;
  });
});
