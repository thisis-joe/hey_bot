import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { readBody, send } from './application.js';
import { modelApiJson } from './model-api.js';
import { checkModelConnection, listConnectionModels, readModelCatalog, readModelConnection } from './model-connection.js';
import { FailureSchema, failureInfo } from './model-failure.js';
import { CheckedModel, ManagedProvider, modelSetupAuthorization } from './model-settings.js';
import { equal } from './webhooks.js';

const Catalog = z.object({ data: z.array(z.object({ id: z.string().min(1).max(200) })) });
export const ModelSetupInput = z.strictObject({
  intent: z.enum(['catalog', 'save']), provider: ManagedProvider, key: z.string().max(1024), model: z.string().max(200),
  verify: z.enum(['', 'true', 'false']),
}).refine(input => input.provider === 'ollama' || input.key.length > 0);
const Result = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('models'), models: z.array(z.string().min(1).max(200)) }),
  z.strictObject({ status: z.literal('checked'), model: CheckedModel }),
  z.strictObject({ status: z.enum(['invalid', 'manual']) }),
  z.strictObject({ status: z.literal('failed'), failure: FailureSchema }),
]);

export async function requestModelSetup(env: NodeJS.ProcessEnv, input: z.infer<typeof ModelSetupInput>) {
  const authorization = modelSetupAuthorization(env);
  if (!authorization) throw new Error('Model settings are unavailable');
  const url = (env.RUNNER_URL ?? 'http://runner:8091').replace(/\/$/, '') + '/model-setup';
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(65000),
    headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  return Result.parse(await response.json());
}

export async function handleModelSetup(req: IncomingMessage, res: ServerResponse, env: NodeJS.ProcessEnv): Promise<void> {
  const authorization = modelSetupAuthorization(env);
  if (!authorization || !equal(String(req.headers.authorization ?? ''), authorization)) {
    send(res, 401, { error: 'Unauthorized' }); return;
  }
  try {
    const input = ModelSetupInput.safeParse(JSON.parse((await readBody(req, 10000)).toString('utf8')));
    if (!input.success) { send(res, 400, { status: 'invalid' }); return; }
    const { intent, provider, key, model, verify } = input.data;
    const candidateEnv = {
      ...env, MODEL_PROVIDER: provider, MODEL_VERIFY_INITIAL_QUESTIONS: verify,
      OPENAI_API_KEY: provider === 'openai' ? key : undefined, OPENAI_MODEL: intent === 'catalog' ? 'catalog' : model,
      GMS_KEY: provider === 'gms' ? key : undefined, GMS_MODEL: model,
      ANTHROPIC_API_KEY: provider === 'claude-api' ? key : undefined, CLAUDE_MODEL: model, OLLAMA_MODEL: model,
    };
    if (intent === 'catalog' && (provider === 'claude-api' || provider === 'ollama')) {
      const catalog = readModelCatalog(candidateEnv);
      if ('field' in catalog) { send(res, 400, { status: 'invalid' }); return; }
      const models = await listConnectionModels(catalog);
      send(res, 200, { status: 'models', models: models.map(entry => entry.id).filter(id => id.length <= 200) });
      return;
    }
    if (intent === 'catalog' && provider === 'gms') { send(res, 400, { status: 'manual' }); return; }
    const selected = readModelConnection(candidateEnv);
    if (selected.status !== 'configured' || selected.connection.provider === 'codex' || selected.connection.provider === 'claude') {
      send(res, 400, { status: 'invalid' }); return;
    }
    const connection = selected.connection;
    const url = new URL('baseUrl' in connection ? connection.baseUrl : connection.url);
    if (url.search) { send(res, 400, { status: 'invalid' }); return; }
    if (intent === 'catalog') {
      if (url.pathname !== '/v1/responses') { send(res, 400, { status: 'manual' }); return; }
      const models = Catalog.parse(await modelApiJson(new URL('/v1/models', url), {
        headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000),
      }, provider));
      send(res, 200, { status: 'models', models: models.data.map(entry => entry.id) });
      return;
    }
    await checkModelConnection(connection);
    send(res, 200, { status: 'checked', model: { provider, url: url.href, model, verifyInitialQuestions: connection.verifyInitialQuestions } });
  } catch (error) {
    send(res, 422, { status: 'failed', failure: failureInfo(error) });
  }
}
