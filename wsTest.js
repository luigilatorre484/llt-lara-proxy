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
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      write('[WS-TEST] connected');
      clientWs.send('ok');
      clientWs.close(1000, 'ws-test done');
    });
  });

  return wss;
}

module.exports = { attachWsTest };
