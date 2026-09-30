'use strict';

// Diagnostica TEMPORANEA (2026-09-30): endpoint WebSocket minimo, isolato
// da Cartesia e da Lara, per verificare se un upgrade WebSocket qualunque
// riesce ad arrivare a questo servizio Render prima di sospettare
// autenticazione/routing di `cartesiaProxy.js`. Nessuna autenticazione,
// nessuna env var, nessun dato sensibile, nessuna dipendenza da Cartesia/
// Lara. Da rimuovere non appena la diagnosi è conclusa.

const WebSocket = require('ws');

function attachWsTest(server, { log } = {}) {
  const write = log || ((line) => console.log(line));
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return;
    }
    // Non è per noi: non tocchiamo il socket, lascia decidere ad altri
    // gestori `upgrade` (es. quello di `cartesiaProxy.js`).
    if (pathname !== '/ws-test') return;

    write('[WS-TEST] upgrade_received');
    // Diagnostica aggiuntiva (2026-09-30): i log Render si sono dimostrati
    // inaffidabili per questa indagine (Live Tail non ha mostrato righe che
    // sappiamo per certo essere state scritte — vedi `/cartesia/tts`).
    // Invece di fidarci dei log, restituiamo l'ESITO al client stesso, nel
    // payload del messaggio WS: mai il valore dell'header, solo se è
    // presente e la sua lunghezza — sufficiente per scoprire dall'esterno,
    // senza dipendere da Render, se un header custom sopravvive fino a
    // Node attraverso Cloudflare/Render durante un upgrade WebSocket.
    const headerValue = req.headers['x-proxy-key'];
    const present = typeof headerValue === 'string' && headerValue.length > 0;
    const length = present ? headerValue.length : 0;
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      write('[WS-TEST] connected');
      clientWs.send(`ok proxyHeaderPresent=${present} length=${length}`);
      clientWs.close(1000, 'ws-test done');
    });
  });

  return wss;
}

module.exports = { attachWsTest };
