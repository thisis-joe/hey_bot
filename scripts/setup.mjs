import { mkdir, readFile, writeFile, copyFile, chmod, rename, rm } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';

await mkdir('.local/secrets', { recursive: true, mode: 0o700 }); await chmod('.local', 0o700); await chmod('.local/secrets', 0o700);
await mkdir('config', { recursive: true });
let original = ''; try { original = await readFile('.env', 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
let updated = original;
const env = parseEnv(original), additions = [];
for (const name of ['POSTGRES_PASSWORD','BOT_DB_PASSWORD','N8N_DB_PASSWORD','INTERNAL_TOKEN','RUNNER_TOKEN','ADMIN_PASSWORD','MODEL_SETTINGS_KEY','N8N_ENCRYPTION_KEY','GITHUB_WEBHOOK_SECRET']) if (!env[name]) {
  const value = randomBytes(32).toString('hex');
  // Replace a blank placeholder, preserve every existing nonempty value and comment.
  const regex = new RegExp(`^${name}=[ \\t]*$`, 'm');
  if (regex.test(updated)) updated = updated.replace(regex, `${name}=${value}`); else additions.push(`${name}=${value}`);
}
for (const [key, value] of Object.entries({ CONTROLLER_PORT:'18092', N8N_PORT:'5688' })) if (!env[key]) additions.push(`${key}=${value}`);
if (additions.length) updated = [updated.trimEnd(), additions.join('\n')].filter(Boolean).join('\n') + '\n';
if (updated !== original) {
  const pending = `.env.${randomUUID()}.tmp`;
  try {
    await writeFile(pending, updated, { flag: 'wx', mode: 0o600 });
    await rename(pending, '.env');
  } finally { await rm(pending, { force: true }); }
}
await chmod('.env', 0o600);
try { await copyFile('config/repositories.example.yaml', 'config/repositories.yaml', 1); } catch (e) { if (e.code !== 'EEXIST') throw e; }
try { await writeFile('.local/secrets/github-app.pem', '', { flag: 'wx', mode: 0o444 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
console.log('Private local configuration prepared. Existing values preserved. No services or remote webhooks activated.');
