import { createServer } from 'node:http';
import { z } from 'zod';
import { phaseSchemas } from './codex.js';
import { checkModelConnection, createModel, readModelConnection } from './model-connection.js';
import { readBody, send } from './application.js';
import { equal } from './webhooks.js';
import { failureInfo, ModelFailure } from './model-failure.js';
import { INITIAL_QUESTION_CHECK_HEADER } from './review.js';

const config = readModelConnection(process.env);
const { provider } = config;
if (process.argv[2] === '--check-model') {
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
  const model = config.status === 'configured' ? createModel(config.connection, process.env.DATA_ROOT ?? '/data') : undefined;
  const Input = z.strictObject({ phase: z.enum(Object.keys(phaseSchemas) as (keyof typeof phaseSchemas)[]), prompt: z.string().min(1).max(500000), workspaceId: z.string().uuid(), timeoutMs: z.int().min(1).max(600000) });
  let busy = false;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') { send(res, 200, { ok: true, busy, modelStatus: config.status }); return; }
    if (!equal(String(req.headers.authorization ?? ''), `Bearer ${token}`)) { send(res, 401, { error: 'Unauthorized' }); return; }
    if (req.method !== 'POST' || req.url !== '/run') { send(res, 404, { error: 'Not found' }); return; }
    if (busy) { send(res, 409, { error: 'Runner busy' }); return; }
    // Set before awaiting request data: concurrent callers cannot both acquire the runner.
    busy = true;
    try {
      const input = Input.parse(JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8')));
      if (!model || config.status !== 'configured') throw new ModelFailure({ code: config.status === 'invalid' ? 'configuration' : 'unconfigured', provider });
      const output = await model.run(input.phase, input.prompt, input.workspaceId, input.timeoutMs);
      if (input.phase === 'initial_questions' && config.connection.verifyInitialQuestions) {
        res.setHeader(INITIAL_QUESTION_CHECK_HEADER, 'blind');
      }
      send(res, 200, output);
    }
    catch (error) {
      // Messages are our own; parser errors are classified because theirs can quote model output.
      const reason = error instanceof z.ZodError ? 'structured output did not match the schema' : error instanceof SyntaxError ? 'invalid JSON output' : error instanceof Error ? error.message : 'unknown';
      console.error(JSON.stringify({ service: 'runner', provider, error: reason.slice(0, 200) }));
      send(res, 422, { error: 'model_failure', failure: failureInfo(error, provider) });
    }
    finally { busy = false; }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  server.listen(Number(process.env.PORT ?? 8091), '0.0.0.0', () => console.log(JSON.stringify({
    service: 'runner', ready: true, provider, modelStatus: config.status, ...(config.status === 'invalid' ? { field: config.field } : {}),
  })));
}
