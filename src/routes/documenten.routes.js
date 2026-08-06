const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const prisma = require('../db');
const { requireAuth, requireDirectie } = require('../auth/middleware');

const router = express.Router();
router.use(requireAuth);

// Map buiten de container-image, gekoppeld aan een schijf in Coolify.
const OPSLAG = process.env.UPLOAD_DIR || '/data/uploads';

const SOORTEN = {
  schaderapport: 'Schaderapport',
  offerte: 'Offerte herstel',
  factuur_onder: 'Onderaannemersfactuur',
  polis: 'Polisblad',
  foto: "Foto's",
  uitkeringsbericht: 'Uitkeringsbericht',
  overig: 'Overig',
};

const TOEGESTAAN = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/heic': '.heic',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/msword': '.doc',
  'application/vnd.ms-excel': '.xls',
};

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB per bestand

function zorgVoorMap() {
  fs.mkdirSync(OPSLAG, { recursive: true });
}

function veiligeNaam(naam) {
  return String(naam || 'bestand')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

async function log(user, text) {
  await prisma.logEntry.create({ data: { text, byUserId: user.id, byName: user.naam } });
}

/* ── lijst per dossier ── */
router.get('/schades/:nummer/documenten', async (req, res) => {
  const schade = await prisma.schade.findUnique({ where: { nummer: req.params.nummer } });
  if (!schade) return res.status(404).json({ error: 'Dossier niet gevonden' });
  const documenten = await prisma.document.findMany({
    where: { schadeId: schade.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ documenten, soorten: SOORTEN });
});

/* ── uploaden ── */
// Body: { bestandsnaam, mime, data (base64), soort, bedrag? }
router.post('/schades/:nummer/documenten', async (req, res) => {
  const b = req.body || {};
  const schade = await prisma.schade.findUnique({ where: { nummer: req.params.nummer } });
  if (!schade) return res.status(404).json({ error: 'Dossier niet gevonden' });

  const soort = SOORTEN[b.soort] ? b.soort : 'overig';
  const mime = String(b.mime || '');
  if (!TOEGESTAAN[mime]) {
    return res.status(400).json({
      error: 'Dit bestandstype kan niet worden opgeslagen. Gebruik pdf, jpg, png, docx of xlsx.',
    });
  }
  if (!b.data) return res.status(400).json({ error: 'Geen bestand ontvangen' });

  let buffer;
  try {
    buffer = Buffer.from(String(b.data).split(',').pop(), 'base64');
  } catch (e) {
    return res.status(400).json({ error: 'Het bestand kon niet worden gelezen' });
  }
  if (!buffer.length) return res.status(400).json({ error: 'Het bestand is leeg' });
  if (buffer.length > MAX_BYTES) {
    return res.status(413).json({ error: 'Het bestand is groter dan 20 MB' });
  }

  zorgVoorMap();
  const ext = TOEGESTAAN[mime];
  const opslagnaam = `${schade.nummer}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(OPSLAG, opslagnaam), buffer);

  const doc = await prisma.document.create({
    data: {
      schadeId: schade.id,
      soort,
      bestandsnaam: veiligeNaam(b.bestandsnaam),
      opslagnaam,
      mime,
      grootte: buffer.length,
      bedrag: b.bedrag != null ? Math.round(Number(b.bedrag) || 0) : null,
      bedragBevestigd: false,
      doorNaam: req.user.naam,
    },
  });

  await log(req.user, `Document toegevoegd bij ${schade.nummer}: ${doc.bestandsnaam} (${SOORTEN[soort]})`);
  res.status(201).json({ document: doc });
});

/* ── downloaden ── */
router.get('/documenten/:id/bestand', async (req, res) => {
  const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
  if (!doc) return res.status(404).json({ error: 'Document niet gevonden' });
  const volledig = path.join(OPSLAG, doc.opslagnaam);
  if (!fs.existsSync(volledig)) {
    return res.status(404).json({ error: 'Het bestand staat niet meer op de server' });
  }
  res.setHeader('Content-Type', doc.mime);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.bestandsnaam)}"`);
  fs.createReadStream(volledig).pipe(res);
});

/* ── bedrag bevestigen of corrigeren ── */
router.patch('/documenten/:id', async (req, res) => {
  const b = req.body || {};
  const data = {};
  if (b.soort !== undefined) {
    if (!SOORTEN[b.soort]) return res.status(400).json({ error: 'Onbekende soort' });
    data.soort = b.soort;
  }
  if (b.bedrag !== undefined) {
    data.bedrag = b.bedrag === null || b.bedrag === '' ? null : Math.round(Number(b.bedrag) || 0);
    data.bedragBevestigd = true;
  }
  if (b.bedragBevestigd !== undefined) data.bedragBevestigd = !!b.bedragBevestigd;

  const doc = await prisma.document.update({ where: { id: req.params.id }, data });
  res.json({ document: doc });
});

/* ── verwijderen ── */
router.delete('/documenten/:id', requireDirectie, async (req, res) => {
  const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
  if (!doc) return res.status(404).json({ error: 'Document niet gevonden' });
  try {
    fs.unlinkSync(path.join(OPSLAG, doc.opslagnaam));
  } catch (e) { /* bestand al weg — geen probleem */ }
  await prisma.document.delete({ where: { id: doc.id } });
  await log(req.user, `Document verwijderd: ${doc.bestandsnaam}`);
  res.json({ verwijderd: true });
});

/* ── controle of de opslag werkt ── */
router.get('/opslag/status', requireDirectie, (req, res) => {
  try {
    zorgVoorMap();
    const test = path.join(OPSLAG, '.schrijftest');
    fs.writeFileSync(test, 'ok');
    fs.unlinkSync(test);
    const aantal = fs.readdirSync(OPSLAG).length;
    res.json({ ok: true, map: OPSLAG, bestanden: aantal });
  } catch (e) {
    res.status(500).json({ ok: false, map: OPSLAG, error: e.message });
  }
});

module.exports = { router, SOORTEN, OPSLAG };
