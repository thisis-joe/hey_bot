import { z } from 'zod';
import { ModelFailure, type FailureInfo } from './model-failure.js';

export function providerFailure(error: unknown, signal: AbortSignal, provider: FailureInfo['provider']): ModelFailure {
  if (error instanceof ModelFailure) return error;
  return new ModelFailure({ provider, code: signal.aborted ? 'timeout'
    : error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid_output' : 'unavailable' });
}

export async function modelApiJson(url: string | URL, init: RequestInit, provider: FailureInfo['provider']): Promise<unknown> {
  const response = await fetch(url, { ...init, redirect: 'error' });
  const apiStatus = response.status;
  if (!response.ok) {
    await response.body?.cancel();
    if (apiStatus < 400 || apiStatus > 599) throw new ModelFailure({ provider, code: 'unavailable' });
    const code = apiStatus === 429 ? 'rate_limit' : [401, 403].includes(apiStatus) ? 'authentication'
      : apiStatus === 404 && provider !== 'gms' ? 'configuration' : apiStatus >= 500 ? 'unavailable' : 'unknown';
    const wait = response.headers.get('retry-after');
    const retry = code === 'rate_limit' && wait ? (/^\d+$/.test(wait) ? Date.now() + Number(wait) * 1000 : Date.parse(wait)) : NaN;
    const retryAt = new Date(retry);
    throw new ModelFailure({ provider, apiStatus, code, ...(Number.isFinite(retryAt.getTime()) ? { retryAt: retryAt.toISOString() } : {}) });
  }
  if (!response.body) throw new ModelFailure({ provider, code: 'invalid_output' });
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new ModelFailure({ provider, code: 'invalid_output' });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
