import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

test('bootstrap preserves existing n8n credentials and workflows across reruns', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hey-install-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'n8n'));
  await writeFile(join(root, '.env'), 'INTERNAL_TOKEN=fixture-internal-token\n');
  await writeFile(join(root, 'n8n/workflows.json'), JSON.stringify([
    { id: 'crbDispatch', name: 'Fixture dispatch' }, { id: 'crbRecovery', name: 'Fixture recovery' },
  ]));
  const docker = join(root, 'docker'), statePath = join(root, 'state.json');
  const initial = { credential: true, workflows: { crbDispatch: true, crbRecovery: false }, published: [], imports: [], restarts: 0 };
  await writeFile(statePath, JSON.stringify(initial));
  await writeFile(docker, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2), file = process.env.FIXTURE_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
if (args.includes('psql')) {
  process.stdout.write(JSON.stringify({ credential: state.credential, workflows: state.workflows }));
} else if (args.includes('import:credentials') || args.includes('import:workflow')) {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  state.imports.push(args.find(a => a.startsWith('import:')));
  if (args.includes('import:workflow')) for (const workflow of input) state.workflows[workflow.id] = false;
} else if (args.includes('publish:workflow')) {
  const id = args.find(a => a.startsWith('--id=')).slice(5);
  if (process.env.FAIL_ON === id) process.exit(5);
  state.published.push(id); state.workflows[id] = true;
} else if (args.includes('restart')) {
  state.restarts++;
} else {
  fs.readFileSync(0);
}
fs.writeFileSync(file, JSON.stringify(state));
`, { mode: 0o755 });
  const call = (file, args = [], env = {}) => promisify(execFile)(process.execPath, [file, ...args], {
    cwd: root, env: { PATH: `${root}:${process.env.PATH}`, FIXTURE_STATE: statePath, ...env },
  });
  const bootstrapFile = new URL('../scripts/bootstrap-n8n.mjs', import.meta.url);
  const bootstrap = (args, env) => call(bootstrapFile.pathname, args, env);
  const state = async () => JSON.parse(await readFile(statePath, 'utf8'));
  await bootstrap();
  assert.deepEqual(await state(), initial, 'reinstall preserves operator-deactivated workflows');

  await writeFile(statePath, JSON.stringify({ ...initial, workflows: { crbRecovery: false } }));
  await assert.rejects(bootstrap([], { FAIL_ON: 'crbDispatch' }));
  assert.deepEqual((await state()).workflows, { crbRecovery: false, crbDispatch: false });
  await bootstrap();
  const resumed = await state();
  assert.deepEqual(resumed, { ...initial, workflows: { crbDispatch: true, crbRecovery: false },
    published: ['crbDispatch'], imports: ['import:workflow'], restarts: 1 });
  await bootstrap();
  assert.deepEqual(await state(), resumed);

  await mkdir(join(root, 'scripts'));
  await copyFile(bootstrapFile, join(root, 'scripts/bootstrap-n8n.mjs'));
  await writeFile(join(root, 'scripts/setup.mjs'), '');
  await call(new URL('../scripts/install.mjs', import.meta.url).pathname, ['--upgrade']);
  assert.deepEqual(await state(), { ...resumed, workflows: { crbDispatch: true, crbRecovery: true },
    published: ['crbDispatch', 'crbDispatch', 'crbRecovery'], imports: ['import:workflow', 'import:workflow'], restarts: 2 });
});
