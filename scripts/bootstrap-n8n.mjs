import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const managed = ['crbDispatch', 'crbRecovery'];
const upgrade = process.argv[2] === '--upgrade';
if (process.argv.length > (upgrade ? 3 : 2)) throw new Error('Usage: node scripts/bootstrap-n8n.mjs [--upgrade]');
const env = parseEnv(await readFile('.env', 'utf8'));
const token = process.env.INTERNAL_TOKEN || env.INTERNAL_TOKEN;
if (!token) throw new Error('Run setup first');
const stateQuery = `SELECT json_build_object(
  'credential', EXISTS (SELECT 1 FROM credentials_entity WHERE id='crbInternalAuth'),
  'workflows', COALESCE((SELECT json_object_agg(id, "activeVersionId" IS NOT NULL)
    FROM workflow_entity WHERE id IN ('crbDispatch','crbRecovery')), '{}')
);`;
const lock = '.local/n8n-bootstrap.lock', pending = '.local/n8n-bootstrap-pending';
const stageId = randomUUID();
const files = { credentials: `/tmp/hey-${stageId}-credentials.json`, workflow: `/tmp/hey-${stageId}-workflows.json` };
const staged = [];

function docker(args, { input, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['compose', ...args], { stdio: ['pipe', capture ? 'pipe' : 'inherit', 'inherit'], shell: false });
    let output = '';
    p.stdout?.setEncoding('utf8').on('data', chunk => { output += chunk; });
    p.stdin.on('error', () => {});
    p.stdin.end(input);
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(output) : reject(new Error(`n8n bootstrap command failed (${args[0]}, exit ${code})`)));
  });
}
const exec = (...args) => docker(['exec', '-T', 'n8n', ...args]);
async function stage(kind, data) {
  const path = files[kind];
  staged.push(path);
  await docker(['exec', '-T', 'n8n', 'node', '-e',
    'process.stdin.pipe(require("node:fs").createWriteStream(process.argv[1], { mode: 0o600, flags: "wx" }))', path], { input: JSON.stringify(data) });
  await exec('n8n', `import:${kind}`, `--input=${path}`);
}

await mkdir('.local', { recursive: true, mode: 0o700 });
await mkdir(lock, { mode: 0o700 });
try {
  const data = JSON.parse(await docker(['exec', '-T', 'postgres', 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', 'n8n', '-c', stateQuery], { capture: true }));
  const missing = managed.filter(id => !Object.hasOwn(data.workflows, id));
  const importing = upgrade ? managed : missing;
  const publishing = managed.filter(id => upgrade || !data.workflows[id]);
  let pendingRestart = false;
  try { await readFile(pending); pendingRestart = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (data.credential && !importing.length && !publishing.length && !pendingRestart) {
    console.log('Managed n8n workflows and credentials are already present.');
  } else {
    await writeFile(pending, '', { mode: 0o600 });
    try {
      if (!data.credential) {
        await stage('credentials', [{ id: 'crbInternalAuth', name: 'hey Internal', type: 'httpHeaderAuth',
          data: { name: 'Authorization', value: `Bearer ${token}` } }]);
      }
      if (importing.length) {
        const workflows = JSON.parse(await readFile('n8n/workflows.json', 'utf8'));
        const selected = importing.map(id => workflows.find(workflow => workflow.id === id));
        if (selected.some(workflow => !workflow)) throw new Error('Managed workflows are missing from this installation');
        await stage('workflow', selected);
      }
      for (const id of publishing) await exec('n8n', 'publish:workflow', `--id=${id}`);
    } finally {
      if (staged.length) {
        await exec('node', '-e', 'for (const path of process.argv.slice(1)) require("node:fs").rmSync(path, { force: true })', ...staged);
      }
    }
    await docker(['restart', 'n8n']);
    await rm(pending);
    console.log('Managed n8n workflows are ready. Existing credentials were retained.');
  }
} finally {
  await rm(lock, { recursive: true });
}
