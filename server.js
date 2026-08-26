const express = require('express');
const { Credentials, Translator } = require('@translated/lara');

const app = express();
app.use(express.json());

// Le credenziali stanno SOLO qui sul server, mai nell'app iOS.
// .trim() è deliberato: un copia-incolla da un altro sito (dashboard Lara,
// terminale, note) può introdurre spazi o ritorni a capo invisibili a fine
// stringa. La firma crittografica dell'SDK Lara è sensibile al singolo
// carattere: un valore sporco produce "Invalid challenge signature" invece
// di un errore di autenticazione più leggibile.
const credentials = new Credentials(
  (process.env.LARA_ACCESS_KEY_ID || '').trim(),
  (process.env.LARA_ACCESS_KEY_SECRET || '').trim()
);
const lara = new Translator(credentials);

// Chiave semplice per evitare che chiunque usi il tuo proxy gratuitamente
const PROXY_SECRET = (process.env.PROXY_SECRET || '').trim();

app.post('/translate', async (req, res) => {
  if (req.header('x-proxy-key') !== PROXY_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { text, source, target } = req.body;
  if (!text || !target) {
    return res.status(400).json({ error: 'text e target sono obbligatori' });
  }

  try {
    const result = await lara.translate(text, source || null, target);
    res.json({ translation: result.translation });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'translation_failed' });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok' });
});

// DIAG-TEMP — da rimuovere dopo la diagnosi. Chiama Lara direttamente,
// bypassando la route /translate, per isolare se "Invalid challenge
// signature" viene dal nostro codice o dall'SDK/account Lara stesso.
// Nessuna credenziale nella risposta: solo esito e messaggio d'errore.
app.get('/diag-lara', async (req, res) => {
  try {
    const result = await lara.translate('ciao', 'it-IT', 'ro-RO');
    res.json({ ok: true, translation: result.translation });
  } catch (err) {
    res.json({
      ok: false,
      message: err.message || String(err),
      name: err.name || null,
      // Alcuni errori dell'SDK Lara portano dettagli extra (status, body
      // della risposta interna): li includiamo se presenti, altrimenti null.
      status: err.status || err.statusCode || null,
      details: err.details || err.response?.data || null
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Lara proxy in ascolto sulla porta ${port}`));
