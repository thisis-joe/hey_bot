import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';

export async function startRunner(t, env) {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const token = 'initial-questions-runner-test-token';
  const child = spawn(process.execPath, [new URL('../dist/runner-server.js', import.meta.url).pathname], {
    env: { PATH: process.env.PATH, PORT: String(port), RUNNER_TOKEN: token, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Runner did not become ready')), 5000);
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('"ready":true')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Runner exited before readiness (${code})`)); });
  });
  return { url: `http://127.0.0.1:${port}`, token };
}
