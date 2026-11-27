import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { initialQuestions, snapshot } from './fixtures.mjs';
import { readPolicy } from '../dist/policy.js';
import { application } from '../dist/application.js';
import { readRepositories } from '../dist/config.js';
import { previewRepositoryTrial, publishRepositoryTrial } from '../dist/repository-trial.js';

test('a disabled trial repository is selectable by an administrator without joining automatic intake', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hey-repository-trial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = join(root, 'repositories.yaml');
  await writeFile(registry, 'version: 1\nrepositories:\n  - platform: github\n    instance: https://api.github.com\n    repository: joe/demo\n    botLogin: hey[bot]\n    webhookSecretEnv: FIXTURE_SECRET\n    webhookAuth: hmac\n    enabled: false\n');
  assert.deepEqual(await readRepositories(registry), []);
  assert.equal((await readRepositories(registry, { includeDisabled: true }))[0].repository, 'joe/demo');

  const events = [];
  const workspaces = { root, async prepare(_platform, snap, id) {
    events.push(['prepare', snap.number, id]);
    const sourceDir = join(root, 'jobs', id, 'source');
    await mkdir(sourceDir, { recursive: true });
    const path = 'src/pay.ts', source = 'function pay() {\n  charge();\n}';
    return { policy: readPolicy(), guidelines: [], context: {
      files: { [path]: source }, diff: { [path]: { oldPath: path, patch: '@@ -2 +2 @@\n+  charge();', lines: new Set([2]),
        positions: { LEFT: {}, RIGHT: { 2: { newLine: 2 } } } } }, excluded: [], limited: false, sourceDir,
    } };
  } };
  const model = { async run(phase, _prompt, id) { events.push([phase, id]); return { questions: initialQuestions() }; } };
  for (const provider of ['github', 'gitlab']) {
    const platform = {
      async permission(user) { events.push(['permissions', user]); return user === 'admin-fixture' ? 'maintain' : 'none'; },
      async snapshot(number) { events.push(['snapshot', provider, number]); return snapshot({ platform: provider, number }); },
      async comment() { assert.fail('Preview must not publish an external comment'); },
    };
    await assert.rejects(() => previewRepositoryTrial({ platform, workspaces, model, number: 17, reviewer: 'unknown' }), /maintain/i);
    const result = await previewRepositoryTrial({ platform, workspaces, model, number: 17, reviewer: 'admin-fixture' });
    assert.equal(result.snapshot.platform, provider);
    assert.equal(result.snapshot.number, 17);
    assert.equal(result.snapshot.headSha, 'b'.repeat(40));
    assert.match(result.questions, /중복 승인/);
    assert.doesNotMatch(result.questions, /정답은 B입니다/);
    assert.match(result.explanations, /정답은 B입니다/);
    assert.match(result.explanations, /D 보기 해설/);
    const comments = [], inlines = [];
    const live = {
      ...platform,
      owned(comment) { return comment.author === 'hey[bot]'; },
      async comments() { return comments; },
      async inlineComments() { return inlines; },
      async inline(_snapshot, item) { inlines.push({ author: 'hey[bot]', body: item.body }); },
      async comment(number, body) {
        assert.equal(number, 17);
        comments.push({ author: 'hey[bot]', body });
        throw new Error('Fixture accepted the comment but lost its response');
      },
    };
    const publish = number => publishRepositoryTrial({ platform: live, reviewer: 'admin-fixture', number, draft: result,
      record: async report => assert.deepEqual(report.questions, initialQuestions()) });
    await assert.rejects(() => publish(18), /revision/);
    assert.equal(comments.length, 0);
    await assert.rejects(() => publish(17), /lost its response/);
    assert.deepEqual(await publish(17), { alreadyPublished: true });
    assert.deepEqual(await publish(17), { alreadyPublished: true });
    assert.equal(comments.length, 1);
    assert.equal(inlines.length, 2);
    assert.match(comments[0].body, /Heybot 시험 출제/);
    assert.doesNotMatch(comments[0].body, /정답은 B입니다|codereviewbot:summary:v1/);
  }
  assert.equal(events.filter(entry => entry[0] === 'initial_questions').length, 2);
});

test('signed trial webhooks admit only learning commands on the selected PR or MR', async t => {
  const admitted = [], secret = 'local-signing-fixture', gitLabKey = Buffer.alloc(24, 7);
  const config = { instance: 'https://example.test', repository: 'joe/demo', webhookSecretEnv: 'FIXTURE_SECRET', botLogin: 'hey[bot]',
    enabled: false, trialNumber: 17 };
  const app = application({
    store: { async enqueue(event) { admitted.push(event); return 'fixture-id'; } },
    async acknowledge() {},
  }, [{ ...config, platform: 'github', webhookAuth: 'hmac' }, { ...config, platform: 'gitlab', webhookAuth: 'signing', webhookSecretEnv: 'GITLAB_FIXTURE' }],
  { FIXTURE_SECRET: secret, GITLAB_FIXTURE: 'whsec_' + gitLabKey.toString('base64') });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.address().port}`;
  for (const platform of ['github', 'gitlab']) {
    const gitHub = platform === 'github';
    const request = async (event, body) => {
      const raw = JSON.stringify(body);
      const timestamp = String(Math.floor(Date.now() / 1000)), delivery = 'fixture-webhook-' + admitted.length;
      const headers = gitHub ? { 'x-github-event': event, 'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex') }
        : { 'x-gitlab-event': event, 'webhook-timestamp': timestamp, 'webhook-id': delivery,
          'webhook-signature': 'v1,' + createHmac('sha256', gitLabKey).update(`${delivery}.${timestamp}.`).update(raw).digest('base64') };
      const response = await fetch(url + '/webhooks/' + platform, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: raw });
      assert.equal(response.status, 202);
      return (await response.json()).admitted;
    };
    const comment = (number, text) => gitHub
      ? { repository: { full_name: 'joe/demo' }, action: 'created', issue: { number, pull_request: {} }, comment: { id: 1, body: text, user: { login: 'fixture-user' } } }
      : { project: { path_with_namespace: 'joe/demo' }, object_kind: 'note', merge_request: { iid: number },
        object_attributes: { id: 1, noteable_type: 'MergeRequest', note: text }, user: { username: 'fixture-user' } };
    const merge = gitHub
      ? { repository: { full_name: 'joe/demo' }, action: 'closed', pull_request: { number: 17, merged: true } }
      : { project: { path_with_namespace: 'joe/demo' }, object_kind: 'merge_request', object_attributes: { iid: 17, action: 'merge' } };
    assert.equal(await request(gitHub ? 'pull_request' : 'Merge Request Hook', merge), 0);
    const event = gitHub ? 'issue_comment' : 'Note Hook';
    assert.equal(await request(event, comment(18, '/hey answer Q1 B')), 0);
    assert.equal(await request(event, comment(17, '/hey tryagain')), 0);
    assert.equal(await request(event, comment(17, '/hey answer Q1 B')), 1);
    assert.equal(await request(event, comment(17, '/hey showanswer')), 1);
  }
  assert.ok(admitted.every(event => event.kind === 'command' && event.target.number === 17));
});
