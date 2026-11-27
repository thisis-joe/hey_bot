import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { equal } from './webhooks.js';

const RunnerHealth = z.object({ modelStatus: z.enum(['unconfigured', 'invalid', 'configured']) });
const messages = {
  unconfigured: '모델 미설정',
  invalid: '모델 연결 설정 오류',
  configured: '모델 연결 구성 로드 완료',
  unavailable: 'Runner에 연결할 수 없습니다',
};

async function runnerStatus(url: string): Promise<keyof typeof messages> {
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
    if (response.ok) return RunnerHealth.parse(await response.json()).modelStatus;
    await response.body?.cancel();
  } catch { /* The admin page remains usable while the runner is down or upgrading. */ }
  return 'unavailable';
}

export async function adminSetup(req: IncomingMessage, res: ServerResponse, env: NodeJS.ProcessEnv): Promise<void> {
  const password = env.ADMIN_PASSWORD;
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (!password || password.length < 32 || password === env.INTERNAL_TOKEN || password === env.RUNNER_TOKEN) {
    res.writeHead(404, headers).end();
    return;
  }
  if (!equal(String(req.headers.authorization ?? ''), `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`)) {
    res.writeHead(401, { ...headers, 'www-authenticate': 'Basic realm="Heybot setup", charset="UTF-8"' }).end();
    return;
  }
  const status = await runnerStatus(env.RUNNER_URL ?? 'http://runner:8091');
  res.writeHead(200, {
    ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'referrer-policy': 'no-referrer',
  });
  res.end(`<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Heybot 초기 설정</title>
<style>body{font:1rem/1.6 system-ui,sans-serif;max-width:42rem;margin:10vh auto;padding:0 1.5rem}h1{line-height:1.2}code{overflow-wrap:anywhere}</style>
<main>
<h1>Heybot 초기 설정</h1>
<h2>모델 연결</h2>
<p>${messages[status]}</p>
<p>연결 설정을 준비한 뒤 설치 서버에서 공개 샘플 검사를 실행할 수 있습니다.</p>
<p><code>docker compose run --rm --no-deps runner node dist/runner-server.js --check-model</code></p>
</main>
</html>`);
}
