import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { readLimited, validateManifest, validateShareURL, UploadSession, Quotas, CHUNK_SIZE, MAX_FILE_SIZE } from '../worker/src/index.js';
import { uploadFiles, validateFiles, formatSize } from '../assets/upload.js';
const origin = 'https://alicetel-u.github.io';
const env = { ALLOWED_ORIGINS: origin };
const goodURL = 'https://7.gigafile.nu/1122-abcdef123';
const reply = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
function context() {
  const data = new Map();
  const storage = {
    async get(k) { return structuredClone(data.get(k)); },
    async put(k, value) { data.set(k, structuredClone(value)); },
    async transaction(fn) { return fn(storage); },
    async setAlarm(value) { storage.alarm = value; },
    async deleteAll() { data.clear(); },
  };
  return { storage };
}
async function initSession(files = [{ name: 'test.txt', size: 3 }]) {
  const ctx = context(); const obj = new UploadSession(ctx);
  await obj.fetch(new Request('https://internal/init', { method: 'POST', body: JSON.stringify({ files: files.map(f => ({ ...f, id: 'generated-id', next: 0 })), host: '7.gigafile.nu', lifetime: 7, token: 'secret', origin, ipHash: 'hash', expires: Date.now() + 100000 }) }));
  return { ctx, obj };
}
function chunk(body, index = 0, overrides = {}) {
  return new Request(`https://internal/chunk?file=0&chunk=${index}`, { method: 'POST', headers: { Origin: origin, 'Authorization': 'Bearer secret', 'X-IP-Hash': 'hash', 'Content-Type': 'application/octet-stream', ...overrides }, body });
}
test('disabled backend refuses file bytes and health reports unavailable', async () => {
  const h = await worker.fetch(new Request('https://api/api/health', { headers: { Origin: origin } }), env);
  assert.equal((await h.json()).available, false);
  const r = await worker.fetch(new Request('https://api/api/chunk', { method: 'POST', headers: { Origin: origin }, body: 'x' }), env);
  assert.equal(r.status, 503); assert.equal(r.headers.get('Access-Control-Allow-Origin'), origin);
});
test('approval alone cannot enable an unprotected API', async () => {
  const r = await worker.fetch(new Request('https://api/api/health', { headers: { Origin: origin } }), { ...env, INTEGRATION_APPROVED: 'true' });
  assert.equal((await r.json()).available, false);
});
test('foreign or missing origins are refused; valid preflight supports authorization', async () => {
  for (const bad of ['', 'https://alicetel-u.github.io.evil.test']) {
    const r = await worker.fetch(new Request('https://api/api/health', { headers: { Origin: bad } }), env);
    assert.equal(r.status, 403); assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  }
  const r = await worker.fetch(new Request('https://api/api/chunk', { method: 'OPTIONS', headers: { Origin: origin } }), env);
  assert.equal(r.status, 204); assert.match(r.headers.get('Access-Control-Allow-Headers'), /Authorization/);
});
test('actual stream length is enforced without Content-Length', async () => {
  assert.equal((await readLimited(new Response('abc').body, 3)).length, 3);
  await assert.rejects(readLimited(new Response('abcd').body, 3), e => e.status === 413);
});
test('manifest rejects invalid retention, count, filename, size and total', () => {
  assert.equal(validateManifest({ lifetime: 7, files: [{ name: '空.txt', size: 0 }] }), 0);
  const samples = [null, {}, { lifetime: 1, files: [] }, { lifetime: 7, files: [{ name: 'x', size: -1 }] }, { lifetime: 7, files: [{ name: 'x\n', size: 1 }] }, { lifetime: 7, files: [{ name: 'x', size: MAX_FILE_SIZE + 1 }] }, { lifetime: 7, files: Array(21).fill({ name: 'x', size: 0 }) }, { lifetime: 7, files: Array(2).fill({ name: 'x', size: MAX_FILE_SIZE }) }];
  for (const s of samples) assert.throws(() => validateManifest(s));
});
test('only exact HTTPS upstream share URLs are accepted', () => {
  assert.equal(validateShareURL(goodURL, '7.gigafile.nu'), goodURL);
  for (const url of ['http://7.gigafile.nu/1122-a', 'https://7.gigafile.nu.evil.test/1122-a', 'https://evil@7.gigafile.nu/1122-a', 'https://7.gigafile.nu:444/1122-a', 'https://8.gigafile.nu/1122-a', 'https://7.gigafile.nu/1122-a?q=1', 'javascript:alert(1)']) assert.throws(() => validateShareURL(url, '7.gigafile.nu'));
});
test('session authentication, chunk ordering and exact lengths are enforced', async () => {
  const { obj } = await initSession();
  assert.equal((await obj.fetch(chunk('abc', 0, { Authorization: 'Bearer wrong' }))).status, 403);
  assert.equal((await obj.fetch(chunk('abc', 1))).status, 409);
  assert.equal((await obj.fetch(chunk('ab'))).status, 400);
  assert.equal((await obj.fetch(chunk('abc', 0, { 'Content-Type': 'text/plain' }))).status, 415);
});
test('successful session forwards fixed metadata, strips JWT and avoids replaying upstream', async t => {
  const { obj, ctx } = await initSession(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++; assert.equal(url, 'https://7.gigafile.nu/upload_chunk.php');
    assert.equal(options.body.get('lifetime'), '7'); assert.equal(options.body.get('id'), 'generated-id');
    assert.equal(await options.body.get('file').text(), 'abc');
    return reply({ status: 0, url: goodURL, delkey: 'ab12', jwt: 'must-not-leak' });
  });
  const response = await obj.fetch(chunk('abc')); const value = await response.json();
  assert.deepEqual(value, { complete: true, url: goodURL, deleteKey: 'ab12' });
  assert.deepEqual(await (await obj.fetch(chunk('abc'))).json(), value); assert.equal(calls, 1);
  assert.equal((await ctx.storage.get('session')).files[0].next, 1);
  await obj.alarm(); assert.equal((await obj.fetch(chunk('abc'))).status, 410);
});
test('upstream failure persists uncertain state across actor restart, never automatically resends', async t => {
  const { obj, ctx } = await initSession(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('connection reset'); });
  assert.equal((await obj.fetch(chunk('abc'))).status, 502);
  const restarted = new UploadSession(ctx);
  assert.equal((await restarted.fetch(chunk('abc'))).status, 409); assert.equal(calls, 1);
});
test('invalid upstream JSON/status/URL and oversized responses fail closed', async t => {
  let response;
  t.mock.method(globalThis, 'fetch', async () => response);
  for (const value of [new Response('not-json'), reply({ status: 1 }), reply({ status: 0, url: 'https://evil.test', delkey: 'abcd' }), new Response('x'.repeat(65537))]) {
    const { obj } = await initSession(); response = value;
    assert.ok((await obj.fetch(chunk('abc'))).status >= 400);
  }
});
test('multiple chunks keep one upstream ID and only the final chunk returns a link', async t => {
  const { obj } = await initSession([{ name: 'large.bin', size: CHUNK_SIZE + 1 }]); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    assert.equal(options.body.get('id'), 'generated-id'); assert.equal(options.body.get('chunk'), String(calls));
    return reply(calls++ ? { status: 0, url: goodURL, delkey: 'abcd' } : { status: 0 });
  });
  assert.deepEqual(await (await obj.fetch(chunk(new Uint8Array(CHUNK_SIZE)))).json(), { complete: false });
  assert.equal((await (await obj.fetch(chunk(new Uint8Array(1), 1))).json()).complete, true);
});
test('zero-byte files use one empty chunk', async t => {
  const { obj } = await initSession([{ name: 'empty', size: 0 }]);
  t.mock.method(globalThis, 'fetch', async (_, o) => { assert.equal(o.body.get('file').size, 0); return reply({ status: 0, url: goodURL, delkey: 'abcd' }); });
  assert.equal((await obj.fetch(chunk(new Uint8Array()))).status, 200);
});
test('persistent quota restricts per-IP bytes and global capacity', async () => {
  const ctx = context(); const q = new Quotas(ctx);
  const reserve = (ipHash, bytes, files = 1) => new Request('https://internal/reserve', { method: 'POST', body: JSON.stringify({ ipHash, bytes, files }) });
  assert.equal((await q.fetch(reserve('a', MAX_FILE_SIZE))).status, 200);
  assert.equal((await new Quotas(ctx).fetch(reserve('a', 1))).status, 429);
  for (const ip of ['b', 'c', 'd', 'e']) assert.equal((await q.fetch(reserve(ip, MAX_FILE_SIZE))).status, 200);
  assert.equal((await q.fetch(reserve('f', 1))).status, 429);
  await q.alarm(); assert.equal(await ctx.storage.get('quota'), undefined);
});
test('browser upload engine splits files, reports live progress and preserves earlier results on failure', async () => {
  const files = [new File(['abcde'], 'one.txt'), new File([], 'empty.txt')]; const progress = [], results = [], requests = [];
  await uploadFiles({ api: 'https://api', files, session: { chunkSize: 3, session: 'session', token: 'token' }, signal: new AbortController().signal,
    onProgress: e => progress.push(e.percent), onResult: r => results.push(r),
    send: async (url, token, body, signal, update) => { requests.push([url, body.size]); update(body.size / 2); return url.includes('file=0&chunk=0') ? { complete: false } : { complete: true, url: goodURL, deleteKey: 'abcd' }; },
  });
  assert.deepEqual(requests.map(r => r[1]), [3, 2, 0]); assert.equal(results.length, 2); assert.ok(progress.some(n => n > 0)); assert.ok(Math.max(...progress) < 100);
  const successes = [];
  await assert.rejects(uploadFiles({ api: '', files, session: { chunkSize: 10, session: '', token: '' }, signal: new AbortController().signal, onProgress() {}, onResult: r => successes.push(r), send: async url => { if (url.includes('file=1')) throw Error('offline'); return { complete: true, url: goodURL, deleteKey: 'abcd' }; } }));
  assert.equal(successes.length, 1);
});
test('browser upload stops immediately when aborted, rejects malicious links', async () => {
  const ac = new AbortController(); ac.abort(); let calls = 0;
  const args = { api: '', files: [new File(['a'], 'x')], session: { chunkSize: 2, session: '', token: '' }, signal: ac.signal, onProgress() {}, onResult() {}, send: async () => { calls++; } };
  await assert.rejects(uploadFiles(args)); assert.equal(calls, 0);
  await assert.rejects(uploadFiles({ ...args, signal: new AbortController().signal, send: async () => ({ complete: true, url: 'https://evil.test', deleteKey: 'abcd' }) }));
});
test('browser limits agree with API limits and display binary units', () => {
  const limits = { maxFiles: 20, maxFileSize: MAX_FILE_SIZE, maxTotalSize: MAX_FILE_SIZE };
  assert.equal(validateFiles([{ name: 'x', size: 0 }], limits), '');
  assert.ok(validateFiles([{ name: 'x', size: MAX_FILE_SIZE + 1 }], limits));
  assert.equal(formatSize(1024 ** 3), '1 GiB');
});

test('full browser protocol through Worker sessions and quotas (external services mocked)', async t => {
  const namespace = Class => {
    let next = 0; const instances = new Map();
    return {
      newUniqueId() { return (++next).toString(16).padStart(64, '0'); }, idFromName(name) { return name; }, idFromString(id) { return id; },
      get(id) {
        if (!instances.has(String(id))) instances.set(String(id), new Class(context()));
        return { fetch: (url, init) => instances.get(String(id)).fetch(url instanceof Request ? url : new Request(url, init)) };
      },
    };
  };
  const liveEnv = { ...env, INTEGRATION_APPROVED: 'true', TURNSTILE_SITE_KEY: 'test-site-key', TURNSTILE_SECRET: 'test-secret', IP_HASH_SECRET: 'test-only-secret'.repeat(3), SESSIONS: namespace(UploadSession), QUOTAS: namespace(Quotas) };
  let upstreamCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') return reply({ success: true, hostname: 'alicetel-u.github.io', action: 'upload' });
    if (url === 'https://gigafile.nu/') return new Response('var server = "7.gigafile.nu";');
    assert.equal(url, 'https://7.gigafile.nu/upload_chunk.php'); upstreamCalls++;
    assert.equal(options.body.get('lifetime'), '14');
    return reply({ status: 0, url: goodURL, delkey: 'abcd', jwt: 'private' });
  });
  const headers = { Origin: origin, 'CF-Connecting-IP': '192.0.2.1', 'Content-Type': 'application/json' };
  const response = await worker.fetch(new Request('https://api/api/session', { method: 'POST', headers, body: JSON.stringify({ lifetime: 14, token: 'test-token', files: [{ name: 'one.txt', size: 3 }, { name: 'empty.txt', size: 0 }] }) }), liveEnv);
  assert.equal(response.status, 200); const session = await response.json(); const results = [];
  await uploadFiles({ api: 'https://api', files: [new File(['abc'], 'one.txt'), new File([], 'empty.txt')], session, signal: new AbortController().signal, onProgress() {}, onResult: r => results.push(r),
    send: async (url, token, body) => {
      const r = await worker.fetch(new Request(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + token }, body }), liveEnv);
      assert.equal(r.status, 200); return r.json();
    },
  });
  assert.equal(results.length, 2); assert.equal(upstreamCalls, 2);
  const wrongIP = await worker.fetch(new Request(`https://api/api/chunk?session=${session.session}&file=0&chunk=0`, { method: 'POST', headers: { ...headers, 'CF-Connecting-IP': '192.0.2.2', Authorization: 'Bearer ' + session.token }, body: 'abc' }), liveEnv);
  assert.equal(wrongIP.status, 403); assert.equal(upstreamCalls, 2);
});
