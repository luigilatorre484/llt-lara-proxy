'use strict';

// LLT Lara proxy.
//
// L'app (iOS/Android) parla solo con questo proxy con l'header `x-proxy-key`; le credenziali
// Lara vere restano qui sul server. Contratto verso l'app INVARIATO:
//   POST /translate  {text, source, target}  ->  200 {translation}
// Novita' (2026-09-26, punto 2 dell'audit):
//   * errori tipizzati: ogni errore ha `code` (QUOTA_EXHAUSTED, AUTH_ERROR, INVALID_REQUEST,
//     RATE_LIMIT, SERVICE_ERROR) oltre a `error` (stringa, gia' presente prima) e lo status HTTP
//     corretto; il corpo e' SEMPRE JSON (mai HTML);
//   * interruttore sulla quota: dopo un QUOTA_EXHAUSTED da Lara non la si richiama per
//     QUOTA_BLOCK_SECONDS (risposta immediata, niente attese ne' martellamento);
//   * tetti locali opzionali (DAILY_CHAR_CAP / MONTHLY_CHAR_CAP) con avvisi al 70% e al 90%;
//   * limite di richieste per IP e globale (la chiave del proxy e' nel bundle dell'app);
//   * validazione degli input, autenticazione a tempo costante, fail-closed senza PROXY_SECRET;
//   * header Server-Timing (tempo di Lara vs totale), log JSON senza testo dell'utente;
//   * GET /usage (solo con ADMIN_SECRET) per leggere il consumo dall'ultimo riavvio;
//   * rimosso GET /diag-lara: era senza autenticazione, consumava quota Lara a ogni chiamata e
//     restituiva dettagli degli errori.

const crypto = require('crypto');
const express = require('express');

function intEnv(env, name, def) {
  const v = parseInt((env[name] || '').trim(), 10);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

function loadConfig(env = process.env) {
  return {
    proxySecret: (env.PROXY_SECRET || '').trim(),
    adminSecret: (env.ADMIN_SECRET || '').trim(),
    ratePerMinPerIp: intEnv(env, 'RATE_LIMIT_PER_MIN', 40),
    ratePerMinGlobal: intEnv(env, 'GLOBAL_RATE_LIMIT_PER_MIN', 600),
    maxTextChars: intEnv(env, 'MAX_TEXT_CHARS', 5000),
    laraTimeoutMs: intEnv(env, 'LARA_TIMEOUT_MS', 8000),
    quotaBlockSeconds: intEnv(env, 'QUOTA_BLOCK_SECONDS', 300),
    dailyCharCap: intEnv(env, 'DAILY_CHAR_CAP', 0),     // 0 = disattivato
    monthlyCharCap: intEnv(env, 'MONTHLY_CHAR_CAP', 0), // 0 = disattivato
  };
}

const HTTP_BY_CODE = {
  QUOTA_EXHAUSTED: 402,
  AUTH_ERROR: 401,
  INVALID_REQUEST: 400,
  RATE_LIMIT: 429,
  SERVICE_ERROR: 502,
};

const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

// Classifica un errore dell'SDK Lara (LaraApiError {statusCode, type, message} / TimeoutError / rete).
// Il testo viene controllato per primo: lo status HTTP reale di Lara per la quota non e' documentato.
function classifyLaraError(err) {
  const msg = String((err && err.message) || '');
  const status = Number(err && (err.statusCode || err.status)) || 0;
  const type = String((err && err.type) || '');
  const name = String((err && err.name) || '');

  if (/quota|exceeded your|limit reached|insufficient (credit|balance|funds)/i.test(msg) || status === 402) {
    return { code: 'QUOTA_EXHAUSTED', httpStatus: 402, detail: 'lara_quota' };
  }
  if (status === 429) {
    return { code: 'RATE_LIMIT', httpStatus: 429, detail: 'lara_rate_limit', retryAfter: 2 };
  }
  if (name === 'TimeoutError' || /timed? ?out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(msg) || err && err.code === 'ETIMEDOUT') {
    return { code: 'SERVICE_ERROR', httpStatus: 504, detail: 'timeout' };
  }
  if (/unsupported language|language .*not supported|invalid (language|locale|target|source)/i.test(msg) ||
      status === 400 || status === 422) {
    return { code: 'INVALID_REQUEST', httpStatus: 400, detail: 'lara_invalid_request' };
  }
  // Credenziali del PROXY verso Lara errate: non e' colpa del client (che non deve vedere un 401,
  // l'app lo leggerebbe come "chiave del proxy non valida"). Errore del servizio, da segnalare.
  if (status === 401 || status === 403 || /Authentication/i.test(type) || /challenge signature|invalid credentials/i.test(msg)) {
    return { code: 'SERVICE_ERROR', httpStatus: 502, detail: 'upstream_auth' };
  }
  return { code: 'SERVICE_ERROR', httpStatus: 502, detail: 'upstream_error' };
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a || '')).digest();
  const hb = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function createApp({ lara, config = loadConfig(), now = Date.now, log } = {}) {
  const write = log || ((o) => console.log(JSON.stringify(o)));
  const app = express();
  app.set('trust proxy', 1); // dietro il proxy di Render: req.ip = client reale
  app.disable('x-powered-by');

  const state = {
    quotaBlockedUntil: 0,
    requests: 0,
    byCode: {},
    day: '', dayChars: 0,
    month: '', monthChars: 0,
    warned: { 70: '', 90: '' },
    rate: new Map(), globalWindow: 0, globalCount: 0,
  };

  const utc = (t) => new Date(t).toISOString();
  function rollUsage(t) {
    const d = utc(t).slice(0, 10), m = utc(t).slice(0, 7);
    if (state.day !== d) { state.day = d; state.dayChars = 0; }
    if (state.month !== m) { state.month = m; state.monthChars = 0; }
  }
  function countResult(code) { state.byCode[code] = (state.byCode[code] || 0) + 1; }
  function warnThresholds(t) {
    const cap = config.monthlyCharCap;
    if (!cap) return;
    for (const pct of [70, 90]) {
      if (state.monthChars >= cap * pct / 100 && state.warned[pct] !== state.month) {
        state.warned[pct] = state.month;
        write({ level: 'warn', event: 'usage_threshold', percent: pct, month: state.month, monthChars: state.monthChars, cap });
      }
    }
  }

  function fail(res, { code, httpStatus, detail, retryAfter }, id, extra = {}) {
    countResult(code);
    if (retryAfter) res.set('Retry-After', String(retryAfter));
    const publicMessage = {
      QUOTA_EXHAUSTED: 'translation quota exhausted',
      AUTH_ERROR: 'unauthorized',
      INVALID_REQUEST: extra.message || 'invalid request',
      RATE_LIMIT: 'too many requests',
      SERVICE_ERROR: 'translation service error',
    }[code];
    res.status(httpStatus || HTTP_BY_CODE[code]).json({ error: publicMessage, code, ...(retryAfter ? { retryAfter } : {}) });
    write({ level: code === 'SERVICE_ERROR' || code === 'QUOTA_EXHAUSTED' ? 'error' : 'info', event: 'request_failed', id, code, httpStatus, detail });
  }

  app.use(express.json({ limit: '16kb' }));

  // --- limite di richieste (prima dell'autenticazione: protegge anche dal tentativo di indovinare la chiave)
  app.use('/translate', (req, res, next) => {
    const t = now();
    const minute = Math.floor(t / 60000);
    if (state.globalWindow !== minute) { state.globalWindow = minute; state.globalCount = 0; state.rate.clear(); }
    state.globalCount += 1;
    const ip = req.ip || 'unknown';
    const c = (state.rate.get(ip) || 0) + 1;
    state.rate.set(ip, c);
    const over = (config.ratePerMinPerIp && c > config.ratePerMinPerIp) ||
                 (config.ratePerMinGlobal && state.globalCount > config.ratePerMinGlobal);
    if (over) {
      const retryAfter = 60 - Math.floor((t % 60000) / 1000);
      return fail(res, { code: 'RATE_LIMIT', httpStatus: 429, detail: 'proxy_rate_limit', retryAfter }, '-');
    }
    next();
  });

  app.post('/translate', async (req, res) => {
    const started = now();
    const id = crypto.randomBytes(4).toString('hex');
    res.set('X-Request-Id', id);

    if (!config.proxySecret) {
      // Fail-closed: senza segreto configurato nessuno passa (prima una chiave vuota poteva passare).
      return fail(res, { code: 'SERVICE_ERROR', httpStatus: 503, detail: 'proxy_secret_not_configured' }, id);
    }
    if (!safeEqual(req.header('x-proxy-key'), config.proxySecret)) {
      return fail(res, { code: 'AUTH_ERROR', httpStatus: 401, detail: 'bad_proxy_key' }, id);
    }

    const { text, source, target } = req.body || {};
    if (typeof text !== 'string' || !text.trim() || typeof target !== 'string' || !target) {
      return fail(res, { code: 'INVALID_REQUEST', httpStatus: 400, detail: 'missing_fields' }, id, { message: 'text e target sono obbligatori' });
    }
    if (text.length > config.maxTextChars) {
      return fail(res, { code: 'INVALID_REQUEST', httpStatus: 400, detail: 'text_too_long' }, id, { message: `text supera ${config.maxTextChars} caratteri` });
    }
    if (!LANG_RE.test(target) || (source != null && source !== '' && !LANG_RE.test(String(source)))) {
      return fail(res, { code: 'INVALID_REQUEST', httpStatus: 400, detail: 'bad_language_code' }, id, { message: 'codice lingua non valido' });
    }

    const t0 = now();
    rollUsage(t0);

    // interruttore quota (Lara ha gia' risposto "quota esaurita": non la si interroga di nuovo per un po')
    if (state.quotaBlockedUntil > t0) {
      const retryAfter = Math.ceil((state.quotaBlockedUntil - t0) / 1000);
      return fail(res, { code: 'QUOTA_EXHAUSTED', httpStatus: 402, detail: 'quota_block_active', retryAfter }, id);
    }
    // tetti locali (protezione della spesa quando il piano e' a consumo)
    if ((config.dailyCharCap && state.dayChars + text.length > config.dailyCharCap) ||
        (config.monthlyCharCap && state.monthChars + text.length > config.monthlyCharCap)) {
      return fail(res, { code: 'QUOTA_EXHAUSTED', httpStatus: 402, detail: 'local_cap' }, id);
    }

    state.requests += 1;
    let timer;
    try {
      const call = lara.translate(text, source || null, target, { timeoutInMillis: config.laraTimeoutMs });
      const timeout = new Promise((_, rej) => {
        timer = setTimeout(() => { const e = new Error('Lara request timed out'); e.name = 'TimeoutError'; rej(e); }, config.laraTimeoutMs + 500);
      });
      const result = await Promise.race([call, timeout]);
      clearTimeout(timer);
      const laraMs = now() - t0;
      const translation = result && result.translation;
      if (typeof translation !== 'string' || !translation.trim()) {
        return fail(res, { code: 'SERVICE_ERROR', httpStatus: 502, detail: 'empty_translation' }, id);
      }
      state.dayChars += text.length; state.monthChars += text.length;
      warnThresholds(t0);
      countResult('OK');
      res.set('Server-Timing', `lara;dur=${laraMs}, total;dur=${now() - started}`);
      write({ level: 'info', event: 'translated', id, chars: text.length, laraMs, target });
      return res.json({ translation });
    } catch (err) {
      clearTimeout(timer);
      const c = classifyLaraError(err);
      if (c.code === 'QUOTA_EXHAUSTED' && config.quotaBlockSeconds) {
        state.quotaBlockedUntil = now() + config.quotaBlockSeconds * 1000;
        c.retryAfter = config.quotaBlockSeconds;
      }
      res.set('Server-Timing', `lara;dur=${now() - t0}, total;dur=${now() - started}`);
      return fail(res, c, id);
    }
  });

  app.get('/', (req, res) => res.json({ status: 'ok' }));
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // Consumo dall'ultimo riavvio (i contatori sono in memoria: si azzerano ai riavvii/deploy).
  app.get('/usage', (req, res) => {
    if (!config.adminSecret) return res.status(404).json({ error: 'not_found', code: 'INVALID_REQUEST' });
    if (!safeEqual(req.header('x-admin-key'), config.adminSecret)) return res.status(401).json({ error: 'unauthorized', code: 'AUTH_ERROR' });
    rollUsage(now());
    res.json({
      since_restart: true, day: state.day, dayChars: state.dayChars, month: state.month, monthChars: state.monthChars,
      requests: state.requests, byCode: state.byCode,
      quotaBlockedUntil: state.quotaBlockedUntil > now() ? utc(state.quotaBlockedUntil) : null,
      caps: { daily: config.dailyCharCap, monthly: config.monthlyCharCap },
    });
  });

  // JSON sempre, mai pagine HTML.
  app.use((req, res) => res.status(404).json({ error: 'not_found', code: 'INVALID_REQUEST' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid json', code: 'INVALID_REQUEST' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large', code: 'INVALID_REQUEST' });
    write({ level: 'error', event: 'unhandled', name: err && err.name });
    res.status(500).json({ error: 'translation service error', code: 'SERVICE_ERROR' });
  });

  app._state = state; // solo per i test
  return app;
}

module.exports = { createApp, classifyLaraError, loadConfig };

if (require.main === module) {
  const { Credentials, Translator } = require('@translated/lara');
  const { attachCartesiaProxy } = require('./cartesiaProxy');
  // Le credenziali Lara stanno SOLO qui sul server. .trim(): un copia-incolla puo' introdurre spazi o
  // ritorni a capo invisibili e la firma dell'SDK e' sensibile al singolo carattere.
  const credentials = new Credentials(
    (process.env.LARA_ACCESS_KEY_ID || '').trim(),
    (process.env.LARA_ACCESS_KEY_SECRET || '').trim()
  );
  const lara = new Translator(credentials);
  const config = loadConfig();
  if (!config.proxySecret) console.error(JSON.stringify({ level: 'error', event: 'PROXY_SECRET non configurato: tutte le richieste verranno rifiutate' }));
  const port = process.env.PORT || 3000;
  // Stesso processo/porta di Lara: il relay Cartesia si aggancia solo
  // all'evento `upgrade` del server HTTP (path /cartesia/tts), nessuna
  // route Express esistente viene toccata.
  const server = createApp({ lara, config }).listen(port, () => console.log(`Lara proxy in ascolto sulla porta ${port}`));
  attachCartesiaProxy(server);
}
