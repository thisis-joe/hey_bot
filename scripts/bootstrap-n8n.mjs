import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
const readState = async () => JSON.parse(await docker(['exec', '-T', 'postgres', 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1',
  '-U', 'postgres', '-d', 'n8n', '-c', stateQuery], { capture: true }));
const importData = (kind, data) => docker(['exec', '-T', 'n8n', 'n8n', `import:${kind}`, '--input=/dev/stdin'], { input: JSON.stringify(data) });

async function readPending() {
  let raw;
  try { raw = await readFile(pending, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  // Older installs left an empty marker for a pending restart.
  if (!raw) return { upgrade: false, workflows: [] };
  const state = JSON.parse(raw);
  if (typeof state?.upgrade !== 'boolean' || !Array.isArray(state.workflows) || state.workflows.some(id => !managed.includes(id))) {
    throw new Error('The pending n8n installation state is invalid');
  }
  return state;
}

async function savePending(state) {
  const temporary = `${pending}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    await rename(temporary, pending);
  } finally { await rm(temporary, { force: true }); }
}

await mkdir('.local', { recursive: true, mode: 0o700 });
await mkdir(lock, { mode: 0o700 });
try {
  const data = await readState();
  const prior = await readPending();
  const missing = managed.filter(id => !Object.hasOwn(data.workflows, id));
  const upgrading = upgrade || Boolean(prior?.upgrade);
  const importing = upgrading ? managed : missing;
  const tracked = managed.filter(id => upgrading || missing.includes(id) || prior?.workflows.includes(id));
  const publishing = tracked.filter(id => upgrading || !data.workflows[id]);
  if (data.credential && !importing.length && !publishing.length && !prior) {
    console.log('Managed n8n workflows and credentials are already present.');
  } else {
    await savePending({ upgrade: upgrading, workflows: tracked });
    if (!data.credential) {
      await importData('credentials', [{ id: 'crbInternalAuth', name: 'hey Internal', type: 'httpHeaderAuth',
        data: { name: 'Authorization', value: `Bearer ${token}` } }]);
    }
    if (importing.length) {
      const workflows = JSON.parse(await readFile('n8n/workflows.json', 'utf8'));
      const selected = importing.map(id => workflows.find(workflow => workflow.id === id));
      if (selected.some(workflow => !workflow)) throw new Error('Managed workflows are missing from this installation');
      await importData('workflow', selected);
    }
    for (const id of publishing) await exec('n8n', 'publish:workflow', `--id=${id}`);
    const installed = await readState();
    if (!installed.credential || tracked.some(id => !installed.workflows[id])) {
      throw new Error('Managed n8n workflow or credential setup is incomplete');
    }
    await docker(['restart', 'n8n']);
    await rm(pending);
    console.log('Managed n8n workflows are ready. Existing credentials were retained.');
  }
} finally {
  await rm(lock, { recursive: true });
}
