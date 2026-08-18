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
app.use(express.json({ limit: '32mb' }));
app.use(cookieParser());

app.get('/api/health', (req, res) => res.json({ ok: true, env: NODE_ENV, time: new Date().toISOString() }));

app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/users', require('./routes/users.routes'));
app.use('/api/schades', require('./routes/schades.routes'));
app.use('/api/relaties', require('./routes/relaties.routes'));
app.use('/api', require('./routes/documenten.routes').router);
app.use('/api', require('./routes/verzenden.routes'));
app.use('/api', require('./routes/locaties.routes'));
app.use('/api', require('./routes/afspraken.routes'));
app.use('/api', require('./routes/opdrachtbonnen.routes'));
app.use('/api', require('./routes/uitvoeringen.routes'));
app.use('/api', require('./routes/actiepunten.routes'));
app.use('/api', require('./routes/facturen.routes'));
app.use('/api', require('./routes/machtigingen.routes'));
app.use('/api', require('./routes/offerte.routes'));

// De klant opent de offerte en kiest een afspraakmoment zonder in te loggen.
app.use('/', require('./routes/offerte.routes'));
app.use('/', require('./routes/afspraken.routes'));
// De klant tekent de machtiging zonder in te loggen.
app.use('/', require('./routes/machtigingen.routes'));

app.use('/api/portal', require('./routes/portal.routes'));

app.use(express.static(path.join(__dirname, '..', 'public')));

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
