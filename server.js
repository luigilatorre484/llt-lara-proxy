const express = require('express');
const { Credentials, Translator } = require('@translated/lara');

const app = express();
app.use(express.json());

// Le credenziali stanno SOLO qui sul server, mai nell'app iOS
const credentials = new Credentials(
  process.env.LARA_ACCESS_KEY_ID,
  process.env.LARA_ACCESS_KEY_SECRET
);
const lara = new Translator(credentials);

// Chiave semplice per evitare che chiunque usi il tuo proxy gratuitamente
const PROXY_SECRET = process.env.PROXY_SECRET;

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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Lara proxy in ascolto sulla porta ${port}`));
