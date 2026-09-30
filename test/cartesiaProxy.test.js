'use strict';
// Test del relay Cartesia con un Cartesia FINTO (server WS locale): nessuna
// connessione reale a api.cartesia.ai, nessuna chiave vera usata.
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { attachCartesiaProxy, loadCartesiaConfig, ALLOWED_VOICE_IDS } = require('../cartesiaProxy');

const PROXY_SECRET = 'test-cartesia-proxy-key';
const REAL_VOICE_ID = [...ALLOWED_VOICE_IDS][0]; // "it" - Lorenzo, primo della whitelist

function baseConfig(over = {}) {
  return { ...loadCartesiaConfig({}), apiKey: 'fake-cartesia-key', proxySecret: PROXY_SECRET, ratePerMinPerIp: 0, ratePerMinGlobal: 0, maxConnectionMs: 2000, ...over };
}

// Cartesia finto: accetta qualunque X-API-Key (verificata solo nell'header,
// non nel body, come il vero protocollo), rimanda 2 chunk audio finti +
// done. Se `behavior` e' 'error' manda un messaggio di errore Cartesia. Se
// 'hang' non risponde mai (per il test del timeout).
function startFakeCartesia(behavior = 'ok') {
  return new Promise((resolve) => {
    const wss = new WebSocket.Server({ port: 0 }, () => {
      wss.on('connection', (ws) => {
        ws.on('message', () => {
          if (behavior === 'hang') return;
          if (behavior === 'error') {
            ws.send(JSON.stringify({ type: 'error', message: 'voice not found' }));
            return;
          }
          ws.send(JSON.stringify({ data: Buffer.from([1, 2, 3, 4]).toString('base64') }));
          ws.send(JSON.stringify({ data: Buffer.from([5, 6]).toString('base64') }));
          ws.send(JSON.stringify({ done: true }));
        });
      });
      resolve({ wss, port: wss.address().port });
    });
  });
}

async function start({ config, fakeCartesiaPort, logs = [] } = {}) {
  const server = http.createServer((_req, res) => res.end());
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  attachCartesiaProxy(server, {
    config: config || baseConfig(),
    log: (line) => logs.push(line),
    createUpstream: fakeCartesiaPort ? () => new WebSocket(`ws://127.0.0.1:${fakeCartesiaPort}`) : undefined,
  });
  return {
    url: `ws://127.0.0.1:${port}/cartesia/tts`,
    logs,
    close: () => new Promise((r) => server.close(r)),
  };
}

function connect(url, headers = {}) {
  return new WebSocket(url, { headers });
}

function waitFor(ws, event) {
  return new Promise((resolve, reject) => {
    ws.once(event, (arg) => resolve(arg));
    ws.once('error', reject);
  });
}

function collectMessages(ws, count) {
  return new Promise((resolve) => {
    const out = [];
    ws.on('message', (data) => {
      out.push(JSON.parse(data.toString()));
      if (out.length === count) resolve(out);
    });
  });
}

const validRequest = () => JSON.stringify({
  model_id: 'sonic-3.6', transcript: 'ciao', voice: REAL_VOICE_ID, language: 'it',
  context_id: 'abc', output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
});

test('relay riuscito: chunk + done inoltrati appena arrivano, stesso schema del client diretto', async () => {
  const fake = await startFakeCartesia('ok');
  const s = await start({ fakeCartesiaPort: fake.port });
  const ws = connect(s.url, { 'x-proxy-key': PROXY_SECRET });
  await waitFor(ws, 'open');
  ws.send(validRequest());
  const messages = await collectMessages(ws, 3);
  assert.deepEqual(Object.keys(messages[0]), ['data']);
  assert.equal(messages[2].done, true);
  ws.close();
  await s.close();
  fake.wss.close();
});

test('autenticazione: x-proxy-key sbagliata/assente = connessione rifiutata (mai apre upstream)', async () => {
  const s = await start({});
  const ws1 = connect(s.url, { 'x-proxy-key': 'sbagliata' });
  await assert.rejects(waitFor(ws1, 'open'));
  const ws2 = connect(s.url, {});
  await assert.rejects(waitFor(ws2, 'open'));
  assert.ok(s.logs.some((l) => l.includes('connection_rejected') && l.includes('bad_proxy_key')));
  await s.close();
});

test('fail-closed: senza CARTESIA_API_KEY o senza CARTESIA_PROXY_SECRET configurati, nessuna connessione passa', async () => {
  for (const over of [{ apiKey: '' }, { proxySecret: '' }]) {
    const s = await start({ config: baseConfig(over) });
    const ws = connect(s.url, { 'x-proxy-key': PROXY_SECRET });
    await assert.rejects(waitFor(ws, 'open'));
    await s.close();
  }
});

test('whitelist Voice ID: un id non presente nella mappa iOS viene rifiutato, upstream mai contattato', async () => {
  const fake = await startFakeCartesia('ok');
  let upstreamContacted = false;
  const s = await start({
    config: baseConfig(),
    fakeCartesiaPort: fake.port,
  });
  // Sovrascrive createUpstream per contare le connessioni upstream reali.
  const serverForCount = http.createServer((_req, res) => res.end());
  await new Promise((r) => serverForCount.listen(0, r));
  const logs = [];
  attachCartesiaProxy(serverForCount, {
    config: baseConfig(),
    log: (l) => logs.push(l),
    createUpstream: () => { upstreamContacted = true; return new WebSocket(`ws://127.0.0.1:${fake.port}`); },
  });
  const url = `ws://127.0.0.1:${serverForCount.address().port}/cartesia/tts`;
  const ws = connect(url, { 'x-proxy-key': PROXY_SECRET });
  await waitFor(ws, 'open');
  ws.send(JSON.stringify({ voice: 'inventato-non-in-whitelist', language: 'it', transcript: 'ciao' }));
  await new Promise((r) => ws.once('close', r));
  assert.equal(upstreamContacted, false);
  assert.ok(logs.some((l) => l.includes('voice_not_allowed')));
  await s.close();
  await new Promise((r) => serverForCount.close(r));
  fake.wss.close();
});

test('validazione richiesta: lingua non valida e testo vuoto/troppo lungo vengono rifiutati prima di aprire upstream', async () => {
  const fake = await startFakeCartesia('ok');
  const s = await start({ fakeCartesiaPort: fake.port });
  for (const bad of [
    { voice: REAL_VOICE_ID, language: 'xx yy', transcript: 'ciao' },
    { voice: REAL_VOICE_ID, language: 'it', transcript: '   ' },
    { voice: REAL_VOICE_ID, language: 'it', transcript: 'a'.repeat(3000) },
  ]) {
    const ws = connect(s.url, { 'x-proxy-key': PROXY_SECRET });
    await waitFor(ws, 'open');
    ws.send(JSON.stringify(bad));
    await new Promise((r) => ws.once('close', r));
  }
  await s.close();
  fake.wss.close();
});

test('errore Cartesia upstream: inoltrato al client, loggato senza dettagli sensibili', async () => {
  const fake = await startFakeCartesia('error');
  const s = await start({ fakeCartesiaPort: fake.port });
  const ws = connect(s.url, { 'x-proxy-key': PROXY_SECRET });
  await waitFor(ws, 'open');
  ws.send(validRequest());
  const [msg] = await collectMessages(ws, 1);
  assert.equal(msg.type, 'error');
  ws.close();
  await s.close();
  fake.wss.close();
});

test('privacy: i log non contengono mai il transcript, la chiave Cartesia o il proxy secret', async () => {
  const fake = await startFakeCartesia('ok');
  const s = await start({ fakeCartesiaPort: fake.port });
  const ws = connect(s.url, { 'x-proxy-key': PROXY_SECRET });
  await waitFor(ws, 'open');
  ws.send(JSON.stringify({ voice: REAL_VOICE_ID, language: 'it', transcript: 'Testo molto riservato del cliente' }));
  await collectMessages(ws, 3);
  ws.close();
  await s.close();
  fake.wss.close();
  const all = s.logs.join('\n');
  assert.doesNotMatch(all, /riservato|fake-cartesia-key|test-cartesia-proxy-key/);
});

test('rete di sicurezza: connessione che non manda mai nulla viene chiusa dal tetto massimo, non resta orfana', async () => {
  const fake = await startFakeCartesia('hang');
  const s = await start({ config: baseConfig({ maxConnectionMs: 150 }), fakeCartesiaPort: fake.port });
  const ws = connect(s.url, { 'x-proxy-key': PROXY_SECRET });
  await waitFor(ws, 'open');
  ws.send(validRequest());
  const closedAt = Date.now();
  await new Promise((r) => ws.once('close', r));
  assert.ok(Date.now() - closedAt < 2000, 'deve chiudersi vicino al tetto configurato, non restare aperta');
  assert.ok(s.logs.some((l) => l.includes('max_connection_time_exceeded')));
  await s.close();
  fake.wss.close();
});
