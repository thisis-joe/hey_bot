import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnswerSchema } from './contracts.js';
import { ClaudeCode } from './claude.js';
import { ClaudeApi, listClaudeModels, type ClaudeApiCredentials } from './claude-api.js';
import { Codex } from './codex.js';
import { ModelFailure } from './model-failure.js';
import { ResponsesModel, type ResponsesConnection } from './responses.js';
import type { Model } from './review.js';

type ModelConnection = (ResponsesConnection
  | { provider: 'codex'; home: string; binary: string; model: string; baseUrl: string }
  | { provider: 'claude'; home: string; binary: string; model: string }
  | (ClaudeApiCredentials & { model: string })
) & { verifyInitialQuestions: boolean };
type Provider = ModelConnection['provider'];
type ConnectionConfig =
  | { status: 'unconfigured'; provider?: never }
  | { status: 'invalid'; provider?: Provider; field: string }
  | { status: 'configured'; provider: Provider; connection: ModelConnection };

const gmsUrl = 'https://gms.ssafy.io/gmsapi/api.openai.com/v1/responses';
const openaiUrl = 'https://api.openai.com/v1/responses';
const anthropicUrl = 'https://api.anthropic.com/';

function httpEndpoint(endpoint: string, allowHttp = false): URL | undefined {
  if (!URL.canParse(endpoint)) return undefined;
  const url = new URL(endpoint);
  if (url.username || url.password || url.hash) return undefined;
  if (url.protocol === 'https:' || (url.protocol === 'http:' && (allowHttp || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return url;
  return undefined;
}

function validKey(key: string | undefined): key is string {
  return !!key && /^[\x21-\x7E]+$/.test(key);
}

function readClaudeApiCredentials(env: NodeJS.ProcessEnv): ClaudeApiCredentials | { field: string } {
  const key = env.ANTHROPIC_API_KEY;
  if (!validKey(key)) return { field: 'ANTHROPIC_API_KEY' };
  const url = httpEndpoint(env.CLAUDE_API_BASE_URL || anthropicUrl);
  if (!url || url.search) return { field: 'CLAUDE_API_BASE_URL' };
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return { provider: 'claude-api', baseUrl: url.href, key };
}

export function readModelCatalog(env: NodeJS.ProcessEnv) {
  if (env.MODEL_PROVIDER !== 'claude-api') return { field: 'MODEL_PROVIDER' };
  return readClaudeApiCredentials(env);
}

export async function listConnectionModels(connection: ClaudeApiCredentials) {
  return listClaudeModels(connection);
}

export function readModelConnection(env: NodeJS.ProcessEnv): ConnectionConfig {
  const provider = env.MODEL_PROVIDER || (env.GMS_KEY ? 'gms' : undefined);
  if (!provider) return { status: 'unconfigured' };
  if (provider !== 'gms' && provider !== 'openai' && provider !== 'codex' && provider !== 'claude' && provider !== 'claude-api') {
    return { status: 'invalid', field: 'MODEL_PROVIDER' };
  }
  const configured = (connection: ModelConnection): ConnectionConfig => ({ status: 'configured', provider, connection });
  const invalid = (field: string): ConnectionConfig => ({ status: 'invalid', provider, field });
  const verify = env.MODEL_VERIFY_INITIAL_QUESTIONS;
  if (verify && verify !== 'true' && verify !== 'false') return invalid('MODEL_VERIFY_INITIAL_QUESTIONS');
  if (provider === 'codex') return configured({
    provider, home: env.CODEX_HOME ?? '/codex', binary: env.CODEX_BINARY ?? 'codex', model: env.CODEX_MODEL ?? '',
    baseUrl: env.CODEX_BASE_URL ?? '', verifyInitialQuestions: verify === 'true',
  });
  if (provider === 'claude') return configured({
    provider, home: env.CLAUDE_CONFIG_DIR ?? '/claude', binary: env.CLAUDE_BINARY ?? 'claude', model: env.CLAUDE_MODEL ?? '',
    verifyInitialQuestions: verify === 'true',
  });
  if (provider === 'claude-api') {
    const credentials = readClaudeApiCredentials(env), model = env.CLAUDE_MODEL;
    if ('field' in credentials) return invalid(credentials.field);
    if (!model?.trim()) return invalid('CLAUDE_MODEL');
    return configured({ ...credentials, model, verifyInitialQuestions: verify === 'true' });
  }
  const gms = provider === 'gms';
  const key = gms ? env.GMS_KEY : env.OPENAI_API_KEY;
  const model = gms ? env.GMS_MODEL ?? 'gpt-6-luna' : env.OPENAI_MODEL;
  const endpoint = gms ? env.GMS_RESPONSES_URL ?? gmsUrl : env.OPENAI_RESPONSES_URL || openaiUrl;
  if (!validKey(key)) return invalid(gms ? 'GMS_KEY' : 'OPENAI_API_KEY');
  if (!model?.trim()) return invalid(gms ? 'GMS_MODEL' : 'OPENAI_MODEL');
  const url = httpEndpoint(endpoint, gms);
  if (!url) {
    return invalid(gms ? 'GMS_RESPONSES_URL' : 'OPENAI_RESPONSES_URL');
  }
  return configured({ provider, url: url.href, key, model, verifyInitialQuestions: verify ? verify === 'true' : gms && model === 'gpt-6-luna' });
}

export function createModel(connection: ModelConnection, dataRoot: string, check = false): Model {
  switch (connection.provider) {
    case 'codex': return new Codex(dataRoot, connection.home, connection.binary, connection.model, connection.baseUrl);
    case 'claude': return new ClaudeCode(dataRoot, connection.home, connection.binary, connection.model);
    case 'claude-api': return new ClaudeApi(dataRoot, connection, check);
    case 'gms':
    case 'openai': return new ResponsesModel(dataRoot, connection, check);
  }
}

export async function checkModelConnection(connection: ModelConnection): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'hey-model-check-'));
  try {
    const workspace = randomUUID();
    const source = join(root, 'jobs', workspace, 'source');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'sample.ts'), 'export const defaultPageSize = 17;\n');
    const model = createModel(connection, root, true);
    const answer = AnswerSchema.parse(await model.run('answer',
      'Use the snapshot read tool to read sample.ts. Return the value assigned to defaultPageSize as a number written in the answer string. Cite its declaration line as RIGHT evidence. Set premise and unverified to null.',
      workspace, 60000));
    if (answer.answer.trim() !== '17' || answer.unverified !== null ||
        !answer.evidence.some(item => item.path === 'sample.ts' && item.line === 1 && item.side === 'RIGHT')) {
      throw new ModelFailure({ code: 'invalid_output', provider: connection.provider });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
