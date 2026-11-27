import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { equal } from './webhooks.js';
import { readBody } from './application.js';
import { ModelSetupInput, requestModelSetup } from './model-setup.js';
import { failureInfo } from './model-failure.js';
import { ManagedProvider, canManageModels, currentModelConfiguration, managedConnection, writeModelSettings } from './model-settings.js';

const RunnerHealth = z.object({
  modelStatus: z.enum(['unconfigured', 'invalid', 'configured']),
  provider: z.string().max(100).optional(), model: z.string().max(200).optional(),
});
const messages = {
  unconfigured: '모델 미설정',
  invalid: '모델 연결 설정 오류',
  configured: '모델 연결 구성 로드 완료',
  unavailable: 'Runner에 연결할 수 없습니다',
};
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const htmlHeaders = {
  ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'referrer-policy': 'no-referrer',
};
const cookieName = 'hey_admin';
const sessionSeconds = 1800;
const html = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const sign = (password: string, purpose: string, value: string) => createHmac('sha256', password).update(`${purpose}:${value}`).digest('base64url');
const providerLabels: Record<z.infer<typeof ManagedProvider>, string> = { openai: 'OpenAI', gms: 'GMS', 'claude-api': 'Claude Messages', ollama: 'Ollama' };

function session(req: IncomingMessage, password: string): string | undefined {
  const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  const match = cookie?.match(/^(\d{10}\.[\w-]{22})\.([\w-]{43})$/);
  if (!match || !match[1] || !match[2] || Number(match[1].split('.')[0]) <= Date.now() / 1000) return undefined;
  return equal(match[2], sign(password, 'session', match[1])) ? match[1] : undefined;
}

async function runnerStatus(url: string): Promise<{ modelStatus: keyof typeof messages; provider?: string; model?: string }> {
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
    if (response.ok) return RunnerHealth.parse(await response.json());
    await response.body?.cancel();
  } catch { /* The admin page remains usable while the runner is down or upgrading. */ }
  return { modelStatus: 'unavailable' };
}

async function page(res: ServerResponse, env: NodeJS.ProcessEnv, csrf: string, code = 200, feedback = '', catalog: string[] = [], current?: { provider: string; model: string }): Promise<void> {
  const { modelStatus, provider: runnerProvider, model: runnerModel } = await runnerStatus(env.RUNNER_URL ?? 'http://runner:8091');
  const { config, version } = await currentModelConfiguration(env);
  const active = config.status === 'configured' ? config.connection
    : runnerProvider ? { provider: runnerProvider, model: runnerModel ?? '' } : undefined;
  const provider = current?.provider ?? active?.provider;
  const modelId = current?.model ?? active?.model ?? '';
  const gmsUrl = env.GMS_RESPONSES_URL || 'https://gms.ssafy.io/gmsapi/api.openai.com/v1/responses';
  const openaiUrl = env.OPENAI_RESPONSES_URL || 'https://api.openai.com/v1/responses';
  const claudeUrl = env.CLAUDE_API_BASE_URL || 'https://api.anthropic.com/';
  const ollamaUrl = env.OLLAMA_URL || 'http://127.0.0.1:11434';
  const visibleEndpoint = (value: string) => { try { const url = new URL(value); return url.origin + url.pathname; } catch { return '설정 오류'; } };
  const activeEndpoint = config.status === 'configured' && version
    ? 'baseUrl' in config.connection ? config.connection.baseUrl : 'url' in config.connection ? config.connection.url : undefined
    : undefined;
  const modelForm = canManageModels(env) ? `
<form method="post" action="/admin">
  <input type="hidden" name="csrf" value="${csrf}">
  <label for="provider">공급자</label>
  <select id="provider" name="provider">
    ${Object.entries(providerLabels).map(([id, title]) => `<option value="${id}"${provider === id ? ' selected' : ''}>${title}</option>`).join('')}
  </select>
  <label for="model">모델 ID</label>
  <input id="model" name="model" maxlength="200" value="${html(modelId)}" list="model-catalog">
  <datalist id="model-catalog">${catalog.map(model => `<option value="${html(model)}"></option>`).join('')}</datalist>
  <label for="key">API 키 (Ollama는 생략)</label>
  <input id="key" name="key" type="password" maxlength="1024" autocomplete="off">
  <label for="verify">최초 질문 독립 풀이</label>
  <select id="verify" name="verify"><option value="">공급자 기본값</option><option value="true">사용</option><option value="false">해제</option></select>
  <p>OpenAI <code>${html(visibleEndpoint(openaiUrl))}</code><br>GMS <code>${html(visibleEndpoint(gmsUrl))}</code><br>Claude Messages <code>${html(visibleEndpoint(claudeUrl))}</code><br>Ollama <code>${html(visibleEndpoint(ollamaUrl))}</code></p>
  <p>검사에는 공개 샘플을 사용합니다. API 요청에는 공급자의 과금 정책이 적용됩니다. 적용 범위는 이 설치에 연결된 저장소입니다.</p>
  <button name="intent" value="catalog">모델 목록 조회</button>
  <button name="intent" value="save">샘플 검사 후 적용</button>
</form>
<form method="post" action="/admin">
  <input type="hidden" name="csrf" value="${csrf}">
  <button name="intent" value="clear">모델 연결 해제</button>
</form>` : '<p>설치 서버에서 <code>docker compose run --rm --no-deps runner node dist/runner-server.js --check-model</code>로 샘플을 확인할 수 있습니다.</p>';
  res.writeHead(code, htmlHeaders);
  res.end(`<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Heybot 초기 설정</title>
<style>body{font:1rem/1.6 system-ui,sans-serif;color:#17242b;background:#f4f8f7;max-width:42rem;margin:3rem auto;padding:0 1.5rem}h1{line-height:1.2}code{overflow-wrap:anywhere}form{margin:1rem 0;padding:1.25rem;border:1px solid #b5c8c4;border-radius:.6rem;background:white}label{display:block;margin-top:.65rem}input,select,button{font:inherit;padding:.35rem .65rem;margin:.2rem .35rem .2rem 0}input:not([type=hidden]){width:min(100%,26rem);box-sizing:border-box}button{cursor:pointer}</style>
<main>
<h1>Heybot 초기 설정</h1>
<h2>모델 연결</h2>
<p>${messages[modelStatus]}</p>
${active ? `<p>현재 모델 <strong>${html(active.provider)} ${html(active.model)}</strong></p>` : ''}
${activeEndpoint ? `<p>현재 연결 주소 <code>${html(visibleEndpoint(activeEndpoint))}</code></p>` : ''}
${feedback ? `<p role="status">${html(feedback)}</p>` : ''}
${modelForm}
</main>
</html>`);
}

export function createAdminSetup(env: NodeJS.ProcessEnv) {
  let changing = false;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const password = env.ADMIN_PASSWORD;
    if (!password || password.length < 32 || password === env.INTERNAL_TOKEN || password === env.RUNNER_TOKEN) {
      res.writeHead(404, headers).end(); return;
    }
    let sessionId = session(req, password);
    const challenge = () => res.writeHead(401, { ...headers, 'www-authenticate': 'Basic realm="Heybot setup", charset="UTF-8"' }).end();
    if (!sessionId) {
      if (req.method !== 'GET' || !equal(String(req.headers.authorization ?? ''), `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`)) {
        challenge(); return;
      }
      sessionId = `${Math.floor(Date.now() / 1000) + sessionSeconds}.${randomBytes(16).toString('base64url')}`;
      res.setHeader('set-cookie', `${cookieName}=${sessionId}.${sign(password, 'session', sessionId)}; Path=/admin; Max-Age=${sessionSeconds}; HttpOnly; SameSite=Strict`);
    }
    const csrf = sign(password, 'csrf', sessionId);
    if (req.method === 'GET') { await page(res, env, csrf); return; }
    if (!canManageModels(env) || !req.headers.host ||
        !['http', 'https'].some(protocol => req.headers.origin === `${protocol}://${req.headers.host}`)) {
      res.writeHead(403, headers).end(); return;
    }
    if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
      res.writeHead(415, headers).end(); return;
    }
    const form = new URLSearchParams((await readBody(req, 4096)).toString('utf8'));
    if (!equal(form.get('csrf') ?? '', csrf)) { res.writeHead(403, headers).end(); return; }
    if (changing) { res.writeHead(409, headers).end(); return; }
    const intent = form.get('intent');
    changing = true;
    try {
      if (intent === 'clear') {
        await writeModelSettings(env, null);
      } else {
        const input = ModelSetupInput.safeParse({
          intent, provider: form.get('provider'), key: form.get('key') ?? '',
          model: (form.get('model') ?? '').trim(), verify: form.get('verify') ?? '',
        });
        if (!input.success) {
          await page(res, env, csrf, 400, '공급자, API 키와 모델 ID를 확인하세요.'); return;
        }
        const { provider, model, key } = input.data;
        const result = await requestModelSetup(env, input.data);
        if (result.status === 'models') {
          const feedback = provider === 'ollama' ? '설치된 모델 ID를 선택하세요.' : '모델 목록을 불러왔습니다. ID를 고르고 API 키를 다시 입력하세요.';
          await page(res, env, csrf, 200, feedback, result.models, { provider, model });
          return;
        }
        if (result.status === 'manual') {
          await page(res, env, csrf, 400, '이 연결의 모델 ID는 직접 입력하세요.'); return;
        }
        if (result.status === 'failed') {
          await page(res, env, csrf, 422, `모델 연결 작업에 실패했습니다 (${result.failure.code}).`); return;
        }
        if (result.status !== 'checked' || intent !== 'save' || result.model.provider !== provider || result.model.model !== model) {
          await page(res, env, csrf, 400, '공급자, API 키와 모델 ID를 확인하세요.'); return;
        }
        await writeModelSettings(env, managedConnection(result.model, key));
      }
      res.writeHead(303, { ...headers, location: '/admin' }).end();
    } catch (error) {
      const { code } = failureInfo(error);
      await page(res, env, csrf, 422, `모델 연결 작업에 실패했습니다 (${code}).`);
    } finally {
      changing = false;
    }
  };
}
