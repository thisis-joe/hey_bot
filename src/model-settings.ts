import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { readModelConnection, type ConnectionConfig } from './model-connection.js';

export const ManagedProvider = z.enum(['openai', 'gms', 'claude-api', 'ollama']);
const Stored = z.strictObject({
  version: z.uuid(),
  connection: z.strictObject({
    provider: ManagedProvider, url: z.string(), model: z.string(), verifyInitialQuestions: z.boolean(),
    key: z.string(), nonce: z.string(), tag: z.string(),
  }).nullable(),
});
type Stored = z.infer<typeof Stored>;
type Selected = (Extract<ConnectionConfig, { status: 'configured' }>['connection']) & { provider: z.infer<typeof ManagedProvider> };

function encryptionKey(env: NodeJS.ProcessEnv): Buffer {
  const raw = env.MODEL_SETTINGS_KEY ?? '';
  if (!/^[\da-f]{64}$/i.test(raw)) throw new Error('Invalid model settings encryption key');
  return Buffer.from(raw, 'hex');
}

export function canManageModels(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.MODEL_SETTINGS_PATH && /^[\da-f]{64}$/i.test(env.MODEL_SETTINGS_KEY ?? ''));
}

async function readStored(env: NodeJS.ProcessEnv): Promise<Stored | undefined> {
  if (!env.MODEL_SETTINGS_PATH) return undefined;
  try { return Stored.parse(JSON.parse(await readFile(env.MODEL_SETTINGS_PATH, 'utf8'))); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function currentModelConfiguration(env: NodeJS.ProcessEnv): Promise<{ version?: string; config: ConnectionConfig }> {
  try {
    const stored = await readStored(env);
    if (!stored) return { config: readModelConnection(env) };
    const { version, connection } = stored;
    if (!connection) return { version, config: { status: 'unconfigured' } };
    const { provider, url, model, verifyInitialQuestions, key, nonce, tag } = connection;
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(env), Buffer.from(nonce, 'base64url'));
    decipher.setAAD(Buffer.from(JSON.stringify([version, provider, url, model, verifyInitialQuestions])));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const secret = Buffer.concat([decipher.update(Buffer.from(key, 'base64url')), decipher.final()]).toString('utf8');
    const common = { model, verifyInitialQuestions };
    const selected: Selected = provider === 'ollama' ? { ...common, provider, baseUrl: url }
      : provider === 'claude-api' ? { ...common, provider, baseUrl: url, key: secret }
      : { ...common, provider, url, key: secret };
    return { version, config: { status: 'configured', provider, connection: selected } };
  } catch {
    return { config: { status: 'invalid', field: 'MODEL_SETTINGS_PATH' } };
  }
}

export async function writeModelSettings(env: NodeJS.ProcessEnv, selected: Selected | null): Promise<void> {
  const path = env.MODEL_SETTINGS_PATH;
  if (!path) throw new Error('Model settings location is required');
  const version = randomUUID();
  let connection: Stored['connection'] = null;
  if (selected) {
    const { provider, model, verifyInitialQuestions } = selected;
    const url = 'baseUrl' in selected ? selected.baseUrl : selected.url;
    const key = 'key' in selected ? selected.key : '';
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(env), nonce);
    cipher.setAAD(Buffer.from(JSON.stringify([version, provider, url, model, verifyInitialQuestions])));
    const secret = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
    connection = { provider, url, model, verifyInitialQuestions, key: secret.toString('base64url'), nonce: nonce.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
  }
  const pending = `${path}.${version}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const file = await open(pending, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ version, connection })); await file.sync(); }
    finally { await file.close(); }
    await rename(pending, path);
  } finally { await rm(pending, { force: true }); }
}
