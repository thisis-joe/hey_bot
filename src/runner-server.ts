import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { phaseSchemas } from './codex.js';
import { checkModelConnection, createModel, listConnectionModels, readModelCatalog, readModelConnection } from './model-connection.js';
import { readBody, send } from './application.js';
import { equal } from './webhooks.js';
import { failureInfo, ModelFailure } from './model-failure.js';
import { currentModelConfiguration } from './model-settings.js';
import { checkFreeModel } from './openrouter-free.js';
import { INITIAL_QUESTION_CHECK_HEADER, MODEL_VERSION_HEADER } from './review.js';

const config = readModelConnection(process.env);
const { provider } = config;
const option = process.argv[2];
if (option === '--check-free-model') {
  try {
    console.log(JSON.stringify({ ok: true, ...(await checkFreeModel(process.env)) }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, failure: failureInfo(error, 'openrouter-free') }));
    process.exitCode = 1;
  }
} else if (option === '--list-models') {
  const catalog = readModelCatalog(process.env);
  try {
    if ('field' in catalog) throw new ModelFailure({ code: 'configuration', provider });
    const models = await listConnectionModels(catalog);
    console.log(JSON.stringify({ ok: true, provider: catalog.provider, models }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, failure: failureInfo(error, provider), ...('field' in catalog ? { field: catalog.field } : {}) }));
    process.exitCode = 1;
  }
} else if (option === '--check-model') {
  try {
    if (config.status !== 'configured') throw new ModelFailure({ code: config.status === 'invalid' ? 'configuration' : 'unconfigured', provider });
    await checkModelConnection(config.connection);
    console.log(JSON.stringify({ ok: true, provider, model: config.connection.model }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, failure: failureInfo(error, provider), ...(config.status === 'invalid' ? { field: config.field } : {}) }));
    process.exitCode = 1;
  }
} else {
  startRunner();
}

function startRunner(): void {
  const token = process.env.RUNNER_TOKEN;
  if (!token || token.length < 32) throw new Error('RUNNER_TOKEN must contain at least 32 characters');
  const dataRoot = process.env.DATA_ROOT ?? '/data';
  const environmentVersion = randomUUID();
  const Input = z.strictObject({ phase: z.enum(Object.keys(phaseSchemas) as (keyof typeof phaseSchemas)[]), prompt: z.string().min(1).max(500000), workspaceId: z.string().uuid(), timeoutMs: z.int().min(1).max(600000) });
  let busy = false;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      const { config } = await currentModelConfiguration(process.env);
      send(res, 200, { ok: true, busy, modelStatus: config.status,
        ...(config.status === 'configured' ? { provider: config.provider, model: config.connection.model } : {}),
      }); return;
    }
    if (!equal(String(req.headers.authorization ?? ''), `Bearer ${token}`)) { send(res, 401, { error: 'Unauthorized' }); return; }
    if (req.method !== 'POST' || req.url !== '/run') { send(res, 404, { error: 'Not found' }); return; }
    if (busy) { send(res, 409, { error: 'Runner busy' }); return; }
    // Set before awaiting request data: concurrent callers cannot both acquire the runner.
    busy = true;
    let activeProvider = provider;
    try {
      const input = Input.parse(JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8')));
      const { version, config } = await currentModelConfiguration(process.env);
      activeProvider = config.provider;
      if (config.status !== 'configured') throw new ModelFailure({ code: config.status === 'invalid' ? 'configuration' : 'unconfigured', provider: activeProvider });
      const selectedVersion = version ?? environmentVersion;
      const expectedVersion = req.headers[MODEL_VERSION_HEADER];
      if (expectedVersion !== undefined && expectedVersion !== selectedVersion) {
        throw new ModelFailure({ code: 'configuration', provider: activeProvider });
      }
      const model = createModel(config.connection, dataRoot, false, process.env.MODEL_SETTINGS_PATH ? async () => {
        const next = await currentModelConfiguration(process.env);
        if (next.config.status !== 'configured' || next.version !== version) {
          throw new ModelFailure({ code: 'configuration', provider: activeProvider });
        }
      } : undefined);
      const output = await model.run(input.phase, input.prompt, input.workspaceId, input.timeoutMs);
      res.setHeader(MODEL_VERSION_HEADER, selectedVersion);
      if (input.phase === 'initial_questions' && config.connection.verifyInitialQuestions) {
        res.setHeader(INITIAL_QUESTION_CHECK_HEADER, 'blind');
      }
      send(res, 200, output);
    }
    catch (error) {
      const failure = failureInfo(error, activeProvider);
      console.error(JSON.stringify({ service: 'runner', failure }));
      send(res, 422, { error: 'model_failure', failure });
    }
    finally { busy = false; }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  server.listen(Number(process.env.PORT ?? 8091), '0.0.0.0', async () => {
    const { config } = await currentModelConfiguration(process.env);
    console.log(JSON.stringify({ service: 'runner', ready: true, provider: config.provider,
      modelStatus: config.status, ...(config.status === 'invalid' ? { field: config.field } : {}),
    }));
  });
}
