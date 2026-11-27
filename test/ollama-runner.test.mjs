import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { HttpModel } from '../dist/codex.js';
import { readPolicy } from '../dist/policy.js';
import { renderReveal } from '../dist/render.js';
import { generateQuestions } from '../dist/review.js';
import { initialQuestions, snapshot } from './fixtures.mjs';
import { startRunner } from './model-runner-fixture.mjs';

test('Ollama lists installed local models and runs questions, answers and explanations without credentials', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'hey-ollama-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = '88888888-8888-4888-8888-888888888888', sourceDir = join(root, 'jobs', id, 'source');
  const path = 'src/pay.ts', source = 'function pay() {\n  charge();\n}';
  await mkdir(join(sourceDir, 'src'), { recursive: true });
  await writeFile(join(sourceDir, path), source);
  const drafts = initialQuestions(), modelId = 'qwen3:fixture', requests = [];
  let remote = false;
  const gateway = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ url: req.url, headers: req.headers, body });
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: [
        { name: modelId, size: 2500, ...(remote ? { remote_host: 'https://example.invalid' } : {}) },
        { name: 'provider-alias:local', remote_model: 'cloud-model', size: 500 },
      ] })); return;
    }
    const isCheck = body.messages.some(m => /^Use the snapshot read tool/.test(m.content));
    const askedForQuestion = body.format?.properties?.questions;
    const file = isCheck ? 'sample.ts' : path;
    const evidence = [{ path: file, line: isCheck ? 1 : 2, side: 'RIGHT', reason: 'Verified fixture source' }];
    let message = { role: 'assistant', content: '' };
    if (body.format) {
      const result = askedForQuestion ? { questions: drafts } : { premise: null, answer: isCheck ? '17' : 'charge is called.', why: null, evidence, unverified: null };
      message.content = JSON.stringify(result);
    } else if (!body.messages.some(m => m.role === 'tool')) {
      message.tool_calls = [{ type: 'function', function: { index: 0, name: 'read_file', arguments: { path: file } } }];
    } else {
      message.content = 'I have the source needed.';
    }
    res.end(JSON.stringify({ done: true, done_reason: 'stop', message }));
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => gateway.close());
  const env = { MODEL_PROVIDER: 'ollama', OLLAMA_URL: `http://127.0.0.1:${gateway.address().port}`, DATA_ROOT: root };
  const cli = (arg, settings = {}) => promisify(execFile)(process.execPath, [new URL('../dist/runner-server.js', import.meta.url).pathname, arg], {
    env: { PATH: process.env.PATH, ...env, ...settings }, timeout: 5000,
  });
  const { stdout } = await cli('--list-models');
  assert.deepEqual(JSON.parse(stdout), { ok: true, provider: 'ollama', models: [{ id: modelId, name: modelId, sizeBytes: 2500 }] });
  const selected = { OLLAMA_MODEL: modelId };
  const check = await cli('--check-model', selected);
  assert.deepEqual(JSON.parse(check.stdout), { ok: true, provider: 'ollama', model: modelId });
  const publicRequests = requests.filter(r => r.body);
  assert.doesNotMatch(JSON.stringify(publicRequests), /src\/pay.ts|charge\(\)/);
  assert.match(publicRequests.at(-1).body.messages.find(m => m.role === 'tool').content, /defaultPageSize = 17/);

  const { url, token } = await startRunner(t, { ...env, ...selected });
  const model = new HttpModel(url, token), snap = snapshot();
  const ctx = { files: { [path]: source }, diff: { [path]: { oldPath: path, patch: '@@ -2 +2 @@\n+  charge();', lines: new Set([2]) } }, excluded: [], limited: false, sourceDir };
  const result = await generateQuestions(model, id, snap, readPolicy(), ctx, null, [], [], 'full', 5000);
  assert.deepEqual(result.questions, drafts);
  const answer = await model.run('answer', 'What does pay call?', id, 5000);
  assert.equal(answer.answer, 'charge is called.');
  assert.equal(answer.evidence[0].path, path);
  const reveal = renderReveal([{ q: result.questions[0], label: 'Q1' }], snap, 'fixture-1');
  assert.match(reveal, /정답은 B입니다/);
  assert.match(reveal, /D 보기 해설/);
  const chats = requests.filter(r => r.body);
  for (const { url, headers, body } of chats) {
    assert.equal(url, '/api/chat'); assert.equal(headers.authorization, undefined);
    assert.equal(body.model, modelId); assert.equal(body.stream, false);
    if (body.format) assert.equal(body.tools, undefined, 'structured generation uses the source already read');
    else assert.ok(body.tools.some(tool => tool.function.name === 'read_file'));
  }
  assert.match(chats.at(-1).body.messages.find(m => m.role === 'tool').content, /charge\(\)/);

  remote = true;
  await assert.rejects(() => model.run('answer', 'Private first line', id, 5000), error => error.failure?.code === 'configuration');
  assert.equal(requests.filter(r => r.body).length, chats.length, 'a model changed to remote receives no chat request');
});
