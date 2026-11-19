// Experimental adapter: keep disabled until integration permission is confirmed.
export const CHUNK_SIZE = 8 * 1024 * 1024;
export const MAX_FILE_SIZE = 10 * 1024 ** 3;
export const MAX_FILES = 20;
const SESSION_MS = 24 * 60 * 60 * 1000;
const unavailable = '現在アップロードは準備中です。外部サービスとの連携条件を確認しています。ファイルは送信されません。';
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers,
} });
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const ready = env => env.INTEGRATION_APPROVED === 'true' && Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET && env.IP_HASH_SECRET?.length >= 32 && env.SESSIONS && env.QUOTAS);

// Check actual bytes, not just the optional Content-Length header.
export async function readLimited(body, limit) {
  if (!body) return new Uint8Array();
  const reader = body.getReader(); const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); fail(413, '送信データが上限を超えています。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
async function boundedJSON(request, limit = 16384) {
  try { return JSON.parse(new TextDecoder().decode(await readLimited(request.body, limit))); }
  catch (e) { if (e instanceof HttpError) throw e; fail(400, '送信内容を読み取れません。'); }
}
export function validateManifest(data) {
  if (![3, 5, 7, 14, 30, 60, 100].includes(data?.lifetime) || !Array.isArray(data.files) || !data.files.length || data.files.length > MAX_FILES) fail(400, '保存期間またはファイル数が無効です。');
  let total = 0;
  for (const file of data.files) {
    if (typeof file.name !== 'string' || !file.name.trim() || file.name.length > 255 || /[\u0000-\u001f\u007f]/.test(file.name) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_SIZE) fail(400, 'ファイル名またはサイズが無効です。1ファイル10 GiBまでです。');
    total += file.size;
  }
  if (total > MAX_FILE_SIZE) fail(413, '1回に送信できる合計サイズは10 GiBまでです。');
  return total;
}
export function validateShareURL(value, host) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.host !== host || u.username || u.password || u.hash || u.search || !/^\/\d{4}-[a-zA-Z0-9]+$/.test(u.pathname)) throw Error();
    return u.href;
  } catch { fail(502, '共有リンクの形式が変わったため送信を停止しました。'); }
}
async function getServer() {
  const r = await fetch('https://gigafile.nu/', { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!r.ok) fail(502, '送信先に接続できません。');
  const html = new TextDecoder().decode(await readLimited(r.body, 1024 * 1024));
  const host = html.match(/var\s+server\s*=\s*["'](\d+\.gigafile\.nu)["']/)?.[1];
  if (!host) fail(502, '送信先の仕様が変わった可能性があります。送信を停止しました。');
  return host;
}
async function identity(ip, env) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.IP_HASH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
async function createSession(request, env, origin, ipHash) {
  if (!(request.headers.get('content-type') || '').startsWith('application/json')) fail(415, '送信形式が無効です。');
  const data = await boundedJSON(request); const total = validateManifest(data);
  if (typeof data.token !== 'string' || !data.token || data.token.length > 2048) fail(403, '安全確認をやり直してください。');
  const verification = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: data.token, remoteip: request.headers.get('CF-Connecting-IP') }), signal: AbortSignal.timeout(15000),
  });
  const v = await boundedJSON(verification);
  if (!verification.ok || !v.success || v.hostname !== new URL(origin).hostname || v.action !== 'upload') fail(403, '安全確認の有効期限が切れました。もう一度お試しください。');
  const quota = env.QUOTAS.get(env.QUOTAS.idFromName('daily'));
  const reservation = await quota.fetch('https://internal/reserve', { method: 'POST', body: JSON.stringify({ ipHash, bytes: total, files: data.files.length }) });
  if (!reservation.ok) return reservation;
  const host = await getServer();
  const id = env.SESSIONS.newUniqueId(); const stub = env.SESSIONS.get(id);
  const token = crypto.randomUUID() + crypto.randomUUID(); const expires = Date.now() + SESSION_MS;
  const response = await stub.fetch('https://internal/init', { method: 'POST', body: JSON.stringify({
    files: data.files.map(file => ({ name: file.name, size: file.size, id: crypto.randomUUID().replaceAll('-', ''), next: 0 })),
    host, lifetime: data.lifetime, token, origin, ipHash, expires,
  }) });
  if (!response.ok) fail(503, '送信の準備ができませんでした。');
  return json({ session: id.toString(), token, chunkSize: CHUNK_SIZE, expires });
}
export default { async fetch(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return json({ error: '許可されていない送信元です。' }, 403);
  const headers = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Max-Age': '600' } });
  try {
    const url = new URL(request.url); let response;
    if (url.pathname === '/api/health' && request.method === 'GET') response = json({
      available: ready(env), message: ready(env) ? '' : unavailable,
      maxFileSize: MAX_FILE_SIZE, maxTotalSize: MAX_FILE_SIZE, maxFiles: MAX_FILES,
      siteKey: ready(env) ? env.TURNSTILE_SITE_KEY : '',
    });
    else {
      if (!ready(env)) fail(503, unavailable);
      const ip = request.headers.get('CF-Connecting-IP'); if (!ip) fail(403, '接続元を確認できません。');
      const ipHash = await identity(ip, env);
      if (url.pathname === '/api/session' && request.method === 'POST') response = await createSession(request, env, origin, ipHash);
      else if (url.pathname === '/api/chunk' && request.method === 'POST') {
        const id = url.searchParams.get('session');
        if (!/^[0-9a-f]{64}$/.test(id || '')) fail(400, '送信セッションが無効です。');
        const stub = env.SESSIONS.get(env.SESSIONS.idFromString(id));
        const forwarded = new Headers(request.headers); forwarded.set('X-IP-Hash', ipHash);
        response = await stub.fetch(new Request('https://internal/chunk?file=' + encodeURIComponent(url.searchParams.get('file') || '') + '&chunk=' + encodeURIComponent(url.searchParams.get('chunk') || ''), { method: 'POST', headers: forwarded, body: request.body, duplex: 'half' }));
      } else fail(404, '見つかりません。');
    }
    const out = new Headers(response.headers); for (const [k, v] of Object.entries(headers)) out.set(k, v);
    return new Response(response.body, { status: response.status, headers: out });
  } catch (e) { return json({ error: e instanceof HttpError ? e.message : '通信を確認できませんでした。時間をおいてお試しください。' }, e instanceof HttpError ? e.status : 502, headers); }
} };

// SQLite-backed Durable Objects store metadata only; no file bytes are persisted.
export class Quotas {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    const data = await request.json(); const day = new Date().toISOString().slice(0, 10);
    const result = await this.ctx.storage.transaction(async tx => {
      let s = await tx.get('quota'); if (s?.day !== day) s = { day, bytes: 0, files: 0, clients: {} };
      const p = s.clients[data.ipHash] || { bytes: 0, files: 0, batches: 0, last: 0 };
      if (s.bytes + data.bytes > 50 * 1024 ** 3 || s.files + data.files > 200 || p.bytes + data.bytes > MAX_FILE_SIZE || p.files + data.files > 40 || p.batches >= 10 || Date.now() - p.last < 10000) return false;
      p.bytes += data.bytes; p.files += data.files; p.batches++; p.last = Date.now();
      s.bytes += data.bytes; s.files += data.files; s.clients[data.ipHash] = p;
      await tx.put('quota', s); return true;
    });
    await this.ctx.storage.setAlarm(Date.now() + 48 * 60 * 60 * 1000);
    return result ? json({ ok: true }) : json({ error: '本日の送信上限、または短時間の利用上限に達しました。時間をおいてお試しください。' }, 429);
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}
export class UploadSession {
  constructor(ctx) { this.ctx = ctx; this.busy = false; }
  async fetch(request) {
    if (this.busy) return json({ error: '送信処理中です。' }, 409);
    this.busy = true;
    try {
      const url = new URL(request.url);
      if (url.pathname === '/init') {
        if (await this.ctx.storage.get('session')) fail(409, '送信セッションが既にあります。');
        const s = await request.json(); await this.ctx.storage.put('session', s); await this.ctx.storage.setAlarm(s.expires);
        return json({ ok: true });
      }
      const s = await this.ctx.storage.get('session');
      if (!s || Date.now() > s.expires) fail(410, '送信の有効期限が切れました。ファイルを選び直してください。');
      if (request.headers.get('Authorization') !== 'Bearer ' + s.token || request.headers.get('Origin') !== s.origin || request.headers.get('X-IP-Hash') !== s.ipHash) fail(403, '送信を確認できません。ページを再読み込みしてください。');
      const fileIndex = url.searchParams.get('file'); const chunk = url.searchParams.get('chunk');
      if (!/^\d+$/.test(fileIndex || '') || !/^\d+$/.test(chunk || '')) fail(400, '送信番号が無効です。');
      const f = s.files[Number(fileIndex)]; const index = Number(chunk);
      if (!f || !Number.isSafeInteger(index)) fail(400, '送信番号が無効です。');
      if (index === f.next - 1 && f.last) return json(f.last);
      if (f.uncertain) fail(409, '前回の送信結果を確認できません。自動再送を停止しました。ファイルを選び直してください。');
      if (index !== f.next || index >= Math.max(1, Math.ceil(f.size / CHUNK_SIZE))) fail(409, '送信順序が無効です。');
      if (!(request.headers.get('Content-Type') || '').startsWith('application/octet-stream')) fail(415, '送信形式が無効です。');
      const bytes = await readLimited(request.body, CHUNK_SIZE);
      const expected = Math.min(CHUNK_SIZE, Math.max(0, f.size - index * CHUNK_SIZE));
      if (bytes.length !== expected) fail(400, 'ファイルサイズが一致しません。');
      // Persist uncertainty before network I/O: a restart must never resend blindly.
      f.uncertain = true; await this.ctx.storage.put('session', s);
      const form = new FormData();
      for (const [k, v] of Object.entries({ id: f.id, name: f.name, chunk: index, chunks: Math.max(1, Math.ceil(f.size / CHUNK_SIZE)), lifetime: s.lifetime })) form.set(k, String(v));
      form.set('file', new Blob([bytes]), f.name);
      const upstream = await fetch('https://' + s.host + '/upload_chunk.php', { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(120000) });
      if (!upstream.ok) fail(502, '送信先がエラーを返しました。送信結果を確認できないため自動再送は行いません。');
      const data = await boundedJSON(upstream, 65536);
      if (data.status !== 0) fail(502, '送信先でファイルを受け付けられませんでした。');
      const final = index === Math.max(1, Math.ceil(f.size / CHUNK_SIZE)) - 1;
      const result = { complete: final };
      if (final) {
        result.url = validateShareURL(data.url, s.host);
        if (!/^[a-zA-Z0-9]{4}$/.test(data.delkey || '')) fail(502, '削除キーを確認できませんでした。');
        result.deleteKey = data.delkey;
      }
      f.next++; f.uncertain = false; f.last = result;
      await this.ctx.storage.put('session', s);
      return json(result);
    } catch (e) { return json({ error: e instanceof HttpError ? e.message : '送信結果を確認できません。自動再送を停止しました。' }, e instanceof HttpError ? e.status : 502); }
    finally { this.busy = false; }
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}
