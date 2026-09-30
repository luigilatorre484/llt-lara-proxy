'use strict';

// Relay WebSocket per Cartesia TTS (sintesi vocale streaming).
//
// L'app (iOS) apre una connessione WS a questo proxy, path `/cartesia/tts`,
// con l'header `x-proxy-key` (segreto separato da quello di Lara — vedi
// CARTESIA_PROXY_SECRET, revocabile senza toccare LARA_PROXY_KEY). La vera
// `CARTESIA_API_KEY` resta SOLO su questo server: non viene mai restituita
// al client, non entra mai in un messaggio verso l'app.
//
// Il proxy inoltra ogni messaggio, appena arriva, in entrambe le direzioni:
// nessun buffering dell'audio completo. Il payload verso Cartesia è
// identico a quello che l'app costruiva prima quando parlava direttamente a
// Cartesia (stesso model_id/output_format, stesso schema {data: base64} /
// {done: true} in risposta) — questo relay non reinterpreta il protocollo
// Cartesia, lo attraversa.
//
// Sicurezza (stesso principio già in produzione per /translate in
// server.js): fail-closed senza segreto configurato, confronto a tempo
// costante, rate limit per connessione (non per messaggio: una sintesi
// dura più messaggi ma è una sola connessione), whitelist dei Voice ID
// (nessun ID arbitrario), validazione lingua/testo, nessun log del testo
// dell'utente né delle credenziali.

const crypto = require('crypto');
const WebSocket = require('ws');

const CARTESIA_WS_URL = 'wss://api.cartesia.ai/tts/websocket';
const CARTESIA_API_VERSION = '2026-08-14';
const CARTESIA_MODEL_ID = 'sonic-3.6';
const CARTESIA_SAMPLE_RATE = 24000;

// Stessi Voice ID di `CartesiaSpeechSynthesisEngine.voiceIDByLanguage` lato
// iOS (28 lingue, catalano escluso perché senza voce Cartesia — vedi quel
// file). Duplicata qui deliberatamente invece che condivisa: un bug o un
// valore scaduto lato client non deve mai poter *ampliare* cosa il proxy
// accetta. Se la mappa iOS cambia, questa va aggiornata a mano.
const ALLOWED_VOICE_IDS = new Set([
  'ee16f140-f6dc-490e-a1ed-c1d537ea0086', // it - Lorenzo
  '2578354e-4b18-4d28-832c-5943344b7085', // de - Klara
  'ea7b5eee-39d9-40b0-b241-1910cbca9c62', // pl - Kasia
  'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4', // en - Skylar
  '7c58f4a4-a72c-42fa-a503-41b9408820f3', // fr - Inès
  '3597a26f-80ef-4bd5-8101-9699bc764917', // es - Ximena
  '05ffab9c-d380-4909-8375-cd12f59238c3', // uk - Oleh
  '34acfaee-c556-41ee-a5f6-c687fb20357c', // ro - Andrada
  '002622d8-19d0-4567-a16a-f99c7397c062', // ar - Huda
  'b1d18488-4aaa-47e7-9e4b-483c90a67968', // pt - Matias
  'da743a82-ddf2-4d9b-8eb8-ff67ca0b138e', // nl - Stijn
  '82db1f84-5b96-4364-b04a-4c7ff80e2f8a', // cs - Jan
  'ca590fdc-df56-4d2e-94a4-ef5b423c7ddf', // sk - Peter
  '4c5c7be8-6b3b-4c62-b915-c54d049c198f', // hu - Bence
  'a1a16724-b1f3-4b27-9e47-8a175115e93c', // hr - Ivan
  '50849023-76e9-46c7-af52-9ec39888a165', // el - Despina
  '2835e382-643b-4ac6-8f6c-74df549a7ad0', // fi - Milla
  'fa7bfcdc-603c-4bf1-a600-a371400d2f8c', // tr - Leyla
  '1e4176b1-3db9-44d6-a601-4fe68b041942', // ru - Sergei
  '6eb8965c-e295-47bd-a9e4-3eeebb3abcff', // zh - Jing
  '7ca2afba-a719-4f06-9af2-ea2b8e3cf14c', // ja - Yuto
  '1a602be4-3b57-4bef-a270-dfa5efed0541', // ko - Yeji
  '4459a9a5-69d6-4680-b970-e13dc51845b6', // hi - Siya
  'ebc02c0d-61fd-48f2-a6c9-0d6683b7d466', // he - Ayala
  '04b567df-2923-4b0c-896b-4b7df0a07e1a', // id - Galang
  '8e8f222d-c817-4cc5-822b-8bf76ca7e98d', // vi - Lien
  '4ff0f045-c140-4aa3-9210-529083f86fca', // th - Supannee
  '8281db18-6ac5-47bb-91a8-ce23a1f1d951', // ms - Faiz
]);

const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

function intEnv(env, name, def) {
  const v = parseInt((env[name] || '').trim(), 10);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

function loadCartesiaConfig(env = process.env) {
  return {
    apiKey: (env.CARTESIA_API_KEY || '').trim(),
    proxySecret: (env.CARTESIA_PROXY_SECRET || '').trim(),
    maxTextChars: intEnv(env, 'CARTESIA_MAX_TEXT_CHARS', 2000),
    ratePerMinPerIp: intEnv(env, 'CARTESIA_RATE_LIMIT_PER_MIN', 30),
    ratePerMinGlobal: intEnv(env, 'CARTESIA_GLOBAL_RATE_LIMIT_PER_MIN', 300),
    // Tetto sulla durata dell'intera connessione, non un timeout di
    // inattività: rete di sicurezza indipendente dal watchdog dell'app
    // (12s lato iOS) per non lasciare mai un socket/processo upstream
    // orfano se qualcosa si blocca. Più largo del watchdog iOS apposta:
    // deve intervenire solo se l'app stessa non l'ha già fatto.
    maxConnectionMs: intEnv(env, 'CARTESIA_MAX_CONNECTION_MS', 25000),
  };
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a || '')).digest();
  const hb = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function defaultCreateUpstream(apiKey) {
  const url = `${CARTESIA_WS_URL}?cartesia_version=${CARTESIA_API_VERSION}`;
  return new WebSocket(url, { headers: { 'X-API-Key': apiKey } });
}

/// Collega il relay Cartesia a un http.Server già esistente (lo stesso
/// processo/porta di Express, incluso quello di Lara), sul path
/// `/cartesia/tts`. Si aggancia solo all'evento `upgrade` per quel path:
/// nessuna route HTTP esistente viene toccata o attraversata da questo
/// codice.
function attachCartesiaProxy(server, {
  config = loadCartesiaConfig(),
  now = Date.now,
  log,
  createUpstream = defaultCreateUpstream,
} = {}) {
  const write = log || ((line) => console.log(line));
  function logLine(tag, id, extra) {
    const parts = [`[CARTESIA-PROXY] ${tag}`];
    if (id) parts.push(`id=${id}`);
    if (extra) for (const [k, v] of Object.entries(extra)) parts.push(`${k}=${v}`);
    write(parts.join(' '));
  }

  if (!config.apiKey) write('[CARTESIA-PROXY] boot_error reason=CARTESIA_API_KEY_missing');
  if (!config.proxySecret) write('[CARTESIA-PROXY] boot_error reason=CARTESIA_PROXY_SECRET_missing');

  const state = { rate: new Map(), globalWindow: 0, globalCount: 0 };
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    // Non è per noi: non tocchiamo il socket, lasciamo che altri gestori
    // di `upgrade` (nessuno oggi) o il comportamento di default decidano.
    if (pathname !== '/cartesia/tts') return;

    const id = crypto.randomBytes(4).toString('hex');

    if (!config.apiKey || !config.proxySecret || !safeEqual(req.headers['x-proxy-key'], config.proxySecret)) {
      logLine('connection_rejected', id, { reason: 'bad_proxy_key' });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const t = now();
    const minute = Math.floor(t / 60000);
    if (state.globalWindow !== minute) { state.globalWindow = minute; state.globalCount = 0; state.rate.clear(); }
    state.globalCount += 1;
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    const c = (state.rate.get(ip) || 0) + 1;
    state.rate.set(ip, c);
    const over = (config.ratePerMinPerIp && c > config.ratePerMinPerIp) ||
                 (config.ratePerMinGlobal && state.globalCount > config.ratePerMinGlobal);
    if (over) {
      logLine('connection_rejected', id, { reason: 'rate_limit' });
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      handleConnection(clientWs, id);
    });
  });

  function handleConnection(clientWs, id) {
    const started = now();
    logLine('connection_start', id);

    let upstream = null;
    let firstChunkLogged = false;
    let closed = false;

    const hardTimer = setTimeout(() => {
      logLine('error', id, { reason: 'max_connection_time_exceeded' });
      cleanup();
    }, config.maxConnectionMs);

    function cleanup() {
      if (closed) return;
      closed = true;
      clearTimeout(hardTimer);
      try { clientWs.close(); } catch { /* già chiuso: nulla da fare */ }
      try { upstream && upstream.close(); } catch { /* già chiuso: nulla da fare */ }
    }

    clientWs.on('message', (data, isBinary) => {
      if (upstream) {
        // Il protocollo attuale invia un solo messaggio (la richiesta
        // iniziale) e poi resta in ascolto: qualunque messaggio successivo
        // viene comunque solo inoltrato, mai reinterpretato — l'upstream è
        // già stato validato e aperto.
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        return;
      }

      let requestPayload;
      try {
        requestPayload = JSON.parse(isBinary ? data.toString('utf8') : data.toString());
      } catch {
        logLine('error', id, { reason: 'invalid_json' });
        cleanup();
        return;
      }

      const voice = requestPayload && requestPayload.voice;
      const language = requestPayload && requestPayload.language;
      const transcript = requestPayload && requestPayload.transcript;

      if (typeof voice !== 'string' || !ALLOWED_VOICE_IDS.has(voice)) {
        logLine('error', id, { reason: 'voice_not_allowed' });
        cleanup();
        return;
      }
      if (typeof language !== 'string' || !LANG_RE.test(language)) {
        logLine('error', id, { reason: 'bad_language' });
        cleanup();
        return;
      }
      if (typeof transcript !== 'string' || !transcript.trim() || transcript.length > config.maxTextChars) {
        logLine('error', id, { reason: 'bad_transcript' });
        cleanup();
        return;
      }

      // model_id e output_format fissati qui: il client non può farli
      // variare, indipendentemente da cosa ha effettivamente inviato.
      const upstreamPayload = JSON.stringify({
        model_id: CARTESIA_MODEL_ID,
        transcript,
        voice,
        language,
        context_id: typeof requestPayload.context_id === 'string' ? requestPayload.context_id : id,
        output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: CARTESIA_SAMPLE_RATE },
      });

      upstream = createUpstream(config.apiKey);

      upstream.on('open', () => {
        logLine('connected', id, { durationMS: now() - started });
        upstream.send(upstreamPayload);
        logLine('request_sent', id, { durationMS: now() - started });
      });

      upstream.on('message', (chunk, upstreamIsBinary) => {
        if (!firstChunkLogged) {
          firstChunkLogged = true;
          logLine('first_audio_chunk', id, { durationMS: now() - started });
        }
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(chunk, { binary: upstreamIsBinary });
        }
        // Il parsing qui sotto serve SOLO per loggare la fine dello stream
        // o un errore Cartesia — il messaggio è già stato inoltrato sopra
        // tale e quale, mai alterato in base a questo parsing.
        try {
          const parsed = JSON.parse(upstreamIsBinary ? chunk.toString('utf8') : chunk.toString());
          if (parsed && parsed.done === true) {
            logLine('stream_complete', id, { durationMS: now() - started });
          } else if (parsed && parsed.type === 'error') {
            logLine('error', id, { reason: 'cartesia_upstream_error' });
          }
        } catch {
          // Chunk audio binario/base64, non JSON di controllo: normale.
        }
      });

      upstream.on('error', () => {
        logLine('error', id, { reason: 'upstream_connection_error' });
        cleanup();
      });
      upstream.on('close', () => cleanup());
    });

    clientWs.on('close', () => cleanup());
    clientWs.on('error', () => cleanup());
  }

  return wss;
}

module.exports = { attachCartesiaProxy, loadCartesiaConfig, ALLOWED_VOICE_IDS, safeEqual };
