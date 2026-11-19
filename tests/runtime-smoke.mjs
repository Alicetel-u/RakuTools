import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const cli = new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url);
const { fileURLToPath } = await import('node:url');
const child = spawn(process.execPath, [fileURLToPath(cli), 'dev', '--local', '--config', 'worker/wrangler.toml', '--port', '8799'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' }, stdio: ['pipe', 'pipe', 'pipe'],
});
let log = ''; child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { clearInterval(poll); reject(Error('Worker startup timed out\n' + log)); }, 30000);
    const poll = setInterval(() => { if (log.includes('Ready on')) { clearInterval(poll); clearTimeout(timeout); resolve(); } }, 100);
    child.once('exit', code => { clearInterval(poll); clearTimeout(timeout); reject(Error('Worker exited: ' + code + '\n' + log)); });
  });
  const headers = { Origin: 'https://alicetel-u.github.io' };
  const health = await fetch('http://127.0.0.1:8799/api/health', { headers });
  assert.equal(health.status, 200); assert.equal((await health.json()).available, false);
  const refused = await fetch('http://127.0.0.1:8799/api/chunk', { method: 'POST', headers, body: 'test' });
  assert.equal(refused.status, 503);
  const foreign = await fetch('http://127.0.0.1:8799/api/health', { headers: { Origin: 'https://evil.test' } });
  assert.equal(foreign.status, 403);
  const preflight = await fetch('http://127.0.0.1:8799/api/chunk', { method: 'OPTIONS', headers });
  assert.equal(preflight.status, 204);
  console.log('Actual workerd runtime: startup, health, upload gate, origin, preflight passed.');
} finally { child.stdin.end(); child.kill('SIGTERM'); }
