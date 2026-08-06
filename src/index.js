const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { PORT, CORS_ORIGIN, NODE_ENV } = require('./env');

const app = express();

app.use(
  cors({
    origin: CORS_ORIGIN.split(',').map((s) => s.trim()),
    credentials: true,
  })
);
// Ruim genoeg voor een document van 20 MB, dat als tekst ~27 MB wordt.
app.use(express.json({ limit: '32mb' }));
app.use(cookieParser());

app.get('/api/health', (req, res) => res.json({ ok: true, env: NODE_ENV, time: new Date().toISOString() }));

app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/users', require('./routes/users.routes'));
app.use('/api/schades', require('./routes/schades.routes'));
app.use('/api/relaties', require('./routes/relaties.routes'));
app.use('/api', require('./routes/documenten.routes').router);
app.use('/api/portal', require('./routes/portal.routes'));

// Frontend serveren
app.use(express.static(path.join(__dirname, '..', 'public')));

// Foutafhandeling
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Het bestand is te groot. Maximaal 20 MB per document.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Er ging iets mis op de server' });
});

app.listen(PORT, () => {
  console.log(`Forward-backend luistert op http://localhost:${PORT} (${NODE_ENV})`);
});

module.exports = app;
