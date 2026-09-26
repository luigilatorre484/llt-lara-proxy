'use strict';
// Test del proxy con un Lara FINTO: nessuna richiesta reale a Lara, nessuna credenziale.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, classifyLaraError, loadConfig } = require('../server');

const KEY = 'test-proxy-key';
const baseConfig = (over = {}) => ({ ...loadConfig({}), proxySecret: KEY, ratePerMinPerIp: 0, ratePerMinGlobal: 0, laraTimeoutMs: 200, quotaBlockSeconds: 300, ...over });

function laraError(statusCode, type, message, name = 'LaraApiError') {
  const e = new Error(message); e.name = name; e.statusCode = statusCode; e.type = type; return e;
}

async function start({ lara, config, clock } = {}) {
  const logs = [];
  const t = clock || { v: Date.UTC(2026, 8, 26, 12, 0, 0) };
  const app = createApp({ lara, config: config || baseConfig(), now: () => t.v, log: (o) => logs.push(o) });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}, raw) => fetch(`${base}/translate`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-key': KEY, ...headers }, body: raw !== undefined ? raw : JSON.stringify(body) });
  return { base, post, logs, clock: t, app, close: () => new Promise((r) => server.close(r)) };
}
const okLara = () => { const l = { calls: 0, translate: async (text) => { l.calls += 1; return { translation: `[${text}]` }; } }; return l; };
const failLara = (err) => { const l = { calls: 0, translate: async () => { l.calls += 1; throw err; } }; return l; };
const body = { text: 'Buongiorno a tutti', source: 'it-IT', target: 'de-DE' };

test('successo: 200 {translation}, Server-Timing, contratto invariato', async () => {
  const s = await start({ lara: okLara() });
  const r = await s.post(body); const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.translation, '[Buongiorno a tutti]');
  assert.match(r.headers.get('server-timing'), /lara;dur=\d+, total;dur=\d+/);
  assert.equal(Object.keys(j).join(), 'translation');
  await s.close();
});

test('autenticazione: chiave sbagliata/assente = 401 AUTH_ERROR; senza PROXY_SECRET = fail-closed 503', async () => {
  const s = await start({ lara: okLara() });
  let r = await s.post(body, { 'x-proxy-key': 'wrong' }); assert.equal(r.status, 401); assert.equal((await r.json()).code, 'AUTH_ERROR');
  r = await s.post(body, { 'x-proxy-key': '' }); assert.equal(r.status, 401);
  await s.close();
  const s2 = await start({ lara: okLara(), config: baseConfig({ proxySecret: '' }) });
  r = await s2.post(body, { 'x-proxy-key': '' }); assert.equal(r.status, 503); assert.equal((await r.json()).code, 'SERVICE_ERROR');
  await s2.close();
});

test('richieste non valide: sempre JSON con code INVALID_REQUEST', async () => {
  const lara = okLara(); const s = await start({ lara });
  for (const b of [{ target: 'de-DE' }, { text: '   ', target: 'de-DE' }, { text: 'ciao' }, { text: 'ciao', target: 'xx yy' }, { text: 123, target: 'de-DE' },
                   { text: 'a'.repeat(6000), target: 'de-DE' }]) {
    const r = await s.post(b); const j = await r.json();
    assert.equal(r.status, 400, JSON.stringify(b).slice(0, 40)); assert.equal(j.code, 'INVALID_REQUEST');
  }
  const r = await s.post(null, {}, '{not json'); assert.equal(r.status, 400);
  assert.match(r.headers.get('content-type'), /json/); assert.equal((await r.json()).code, 'INVALID_REQUEST');
  assert.equal(lara.calls, 0);
  await s.close();
});

test('QUOTA_EXHAUSTED: 402 tipizzato, poi interruttore senza richiamare Lara, poi riprova allo scadere', async () => {
  // due forme: 500 come osservato dal vivo, e 429 con testo di quota
  for (const err of [laraError(500, 'UnknownError', 'You have exceeded your "api_translation_chars" quota'), laraError(429, 'TooManyRequests', 'Quota exceeded')]) {
    const lara = failLara(err); const s = await start({ lara });
    let r = await s.post(body); let j = await r.json();
    assert.equal(r.status, 402); assert.equal(j.code, 'QUOTA_EXHAUSTED'); assert.equal(j.retryAfter, 300);
    assert.equal(r.headers.get('retry-after'), '300'); assert.doesNotMatch(JSON.stringify(j), /api_translation_chars/);
    assert.equal(lara.calls, 1);
    s.clock.v += 60_000;
    r = await s.post(body); j = await r.json();
    assert.equal(r.status, 402); assert.equal(lara.calls, 1, 'Lara non richiamata durante il blocco'); assert.equal(j.retryAfter, 240);
    s.clock.v += 250_000;
    r = await s.post(body); assert.equal(lara.calls, 2, 'dopo il blocco si riprova');
    await s.close();
  }
});

test('RATE_LIMIT 429 da Lara, lingua non supportata = 400, auth verso Lara = 502 (mai 401 al client), timeout = 504, altro = 502', async () => {
  const cases = [
    [laraError(429, 'TooManyRequests', 'slow down'), 429, 'RATE_LIMIT'],
    [laraError(500, 'UnknownError', 'Unsupported language: xx-XX'), 400, 'INVALID_REQUEST'],
    [laraError(401, 'AuthenticationError', 'Invalid challenge signature'), 502, 'SERVICE_ERROR'],
    [laraError(503, 'Unavailable', 'upstream down'), 502, 'SERVICE_ERROR'],
    [new Error('boom'), 502, 'SERVICE_ERROR'],
  ];
  for (const [err, http, code] of cases) {
    const s = await start({ lara: failLara(err) });
    const r = await s.post(body); const j = await r.json();
    assert.equal(r.status, http, err.message); assert.equal(j.code, code);
    if (code === 'RATE_LIMIT') assert.ok(r.headers.get('retry-after'));
    await s.close();
  }
  const hang = { translate: () => new Promise(() => {}) };
  const s = await start({ lara: hang, config: baseConfig({ laraTimeoutMs: 50 }) });
  const r = await s.post(body); assert.equal(r.status, 504); assert.equal((await r.json()).code, 'SERVICE_ERROR');
  await s.close();
});

test('limite per IP e globale: 429 RATE_LIMIT con Retry-After, si azzera al minuto successivo', async () => {
  const s = await start({ lara: okLara(), config: baseConfig({ ratePerMinPerIp: 3 }) });
  for (let i = 0; i < 3; i++) assert.equal((await s.post(body)).status, 200);
  const r = await s.post(body); assert.equal(r.status, 429); assert.equal((await r.json()).code, 'RATE_LIMIT'); assert.ok(r.headers.get('retry-after'));
  s.clock.v += 61_000; assert.equal((await s.post(body)).status, 200);
  await s.close();
});

test('tetto mensile locale: 402 senza chiamare Lara, avvisi al 70% e 90%, azzeramento a nuovo mese', async () => {
  const lara = okLara(); const text = 'x'.repeat(10); // 10 caratteri per richiesta
  const s = await start({ lara, config: baseConfig({ monthlyCharCap: 100 }) });
  for (let i = 0; i < 7; i++) assert.equal((await s.post({ ...body, text })).status, 200);   // 70
  assert.ok(s.logs.some((l) => l.event === 'usage_threshold' && l.percent === 70));
  for (let i = 0; i < 2; i++) assert.equal((await s.post({ ...body, text })).status, 200);   // 90
  assert.ok(s.logs.some((l) => l.event === 'usage_threshold' && l.percent === 90));
  assert.equal((await s.post({ ...body, text })).status, 200);                               // 100
  const r = await s.post({ ...body, text }); const j = await r.json();
  assert.equal(r.status, 402); assert.equal(j.code, 'QUOTA_EXHAUSTED'); assert.equal(lara.calls, 10);
  s.clock.v = Date.UTC(2026, 9, 1, 0, 1, 0);
  assert.equal((await s.post({ ...body, text })).status, 200);
  await s.close();
});

test('/usage: nascosto senza ADMIN_SECRET, protetto con; /diag-lara rimosso; percorsi ignoti = JSON 404', async () => {
  const lara = okLara();
  let s = await start({ lara });
  assert.equal((await fetch(`${s.base}/usage`)).status, 404);
  assert.equal((await fetch(`${s.base}/diag-lara`)).status, 404);
  const r404 = await fetch(`${s.base}/qualcosa`); assert.equal(r404.status, 404); assert.match(r404.headers.get('content-type'), /json/);
  assert.equal(lara.calls, 0, '/diag-lara non deve piu\' consumare Lara');
  assert.deepEqual(await (await fetch(`${s.base}/`)).json(), { status: 'ok' });
  await s.close();
  s = await start({ lara, config: baseConfig({ adminSecret: 'adm' }) });
  await s.post(body);
  assert.equal((await fetch(`${s.base}/usage`, { headers: { 'x-admin-key': 'no' } })).status, 401);
  const u = await (await fetch(`${s.base}/usage`, { headers: { 'x-admin-key': 'adm' } })).json();
  assert.equal(u.monthChars, body.text.length); assert.equal(u.byCode.OK, 1); assert.doesNotMatch(JSON.stringify(u), /Buongiorno/);
  await s.close();
});

test('privacy: i log non contengono mai il testo dell\'utente ne\' la chiave', async () => {
  const s = await start({ lara: failLara(laraError(500, 'X', 'You have exceeded your "api_translation_chars" quota')) });
  await s.post({ ...body, text: 'Testo riservato del cliente' }); await s.post(body, { 'x-proxy-key': 'sbagliata-segreta' });
  const all = JSON.stringify(s.logs);
  assert.doesNotMatch(all, /riservato|Buongiorno|sbagliata-segreta|test-proxy-key/);
  await s.close();
});

test('classifyLaraError: tabella', () => {
  const c = (e) => classifyLaraError(e).code;
  assert.equal(c(laraError(402, 'Payment', 'x')), 'QUOTA_EXHAUSTED');
  assert.equal(c(laraError(403, 'Forbidden', 'quota reached')), 'QUOTA_EXHAUSTED');
  assert.equal(c(laraError(429, 'Rate', 'slow')), 'RATE_LIMIT');
  assert.equal(c(laraError(422, 'Invalid', 'bad target')), 'INVALID_REQUEST');
  assert.equal(c(laraError(0, '', 'ETIMEDOUT')), 'SERVICE_ERROR');
  assert.equal(c(null), 'SERVICE_ERROR');
});
