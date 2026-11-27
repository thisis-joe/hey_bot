import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';

function run(command, args, { capture = false, optional = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', capture ? 'pipe' : 'inherit', optional ? 'ignore' : 'inherit'] });
    let result = '';
    child.stdout?.setEncoding('utf8').on('data', chunk => { result += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0 || optional) resolve(result.trim());
      else reject(new Error(`${command} ${args[0]} failed (exit ${code})`));
    });
  });
}

async function imageId(ref) {
  return run('docker', ['image', 'inspect', '--format', '{{.Id}}', ref], { capture: true, optional: true });
}

async function loadRelease() {
  let text;
  try { text = await readFile('release.json', 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const { images, archiveSha256 } = JSON.parse(text);
  if (!Array.isArray(images) || images.length !== 2 || images.some(item => !/^hey-(controller|runner):[0-9][a-z0-9.-]*$/.test(item.ref) || !/^sha256:[a-f0-9]{64}$/.test(item.id))) {
    throw new Error('Release image manifest is invalid');
  }
  const matches = async () => (await Promise.all(images.map(async ({ ref, id }) => await imageId(ref) === id))).every(Boolean);
  if (!(await matches())) {
    const hash = createHash('sha256');
    for await (const part of createReadStream('images.tar')) hash.update(part);
    if (hash.digest('hex') !== archiveSha256) throw new Error('Release image archive checksum does not match');
    await run('docker', ['image', 'load', '--input', 'images.tar']);
    if (!(await matches())) throw new Error('Loaded image IDs do not match this release');
  }
  return true;
}

const lock = '.local/install.lock';
await mkdir('.local', { recursive: true, mode: 0o700 });
await mkdir(lock, { mode: 0o700 });
try {
  await run(process.execPath, ['scripts/setup.mjs']);
  const release = await loadRelease();
  await run('docker', ['compose', 'up', '-d', '--wait', '--wait-timeout', '240', release ? '--no-build' : '--build']);
  await run(process.execPath, ['scripts/bootstrap-n8n.mjs']);
  await run('docker', ['compose', 'up', '-d', '--wait', '--wait-timeout', '180', '--no-build']);
  console.log('Heybot is running. Open /admin from the installation host or an SSH tunnel.');
} finally {
  await rm(lock, { recursive: true });
}
