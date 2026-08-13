const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();
router.use(requireAuth);

const STATUS = ['open', 'ingepland', 'uitvoering', 'opgeleverd'];
const SOORTEN = ['eigenaar', 'huurder', 'leeg', 'gemeenschappelijk'];

async function log(user, text, schadeId) {
  await prisma.logEntry.create({
    data: { text, schadeId: schadeId || null, byUserId: user.id, byName: user.naam },
  });
}

const datum = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

function schoon(b) {
  const d = {};
  ['adres', 'postcode', 'plaats', 'aanduiding', 'bewoner', 'telefoon', 'email', 'tijdvak', 'notitie']
    .forEach((k) => { if (b[k] !== undefined) d[k] = b[k] ? String(b[k]).trim() : null; });
  if (b.bewonerSoort !== undefined) {
    d.bewonerSoort = SOORTEN.includes(b.bewonerSoort) ? b.bewonerSoort : null;
  }
  if (b.ingepland !== undefined) d.ingepland = datum(b.ingepland);
  if (b.volgorde !== undefined) d.volgorde = Number(b.volgorde) || 0;
  return d;
}

/* ─────────── lijst ─────────── */
router.get('/schades/:nummer/locaties', async (req, res) => {
  const s = await prisma.schade.findUnique({ where: { nummer: req.params.nummer }, select: { id: true } });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });
  const locaties = await prisma.locatie.findMany({
    where: { schadeId: s.id },
    orderBy: [{ hoofd: 'desc' }, { volgorde: 'asc' }],
  });
  res.json({ locaties, statussen: STATUS, soorten: SOORTEN });
});

/* ─────────── toevoegen ─────────── */
router.post('/schades/:nummer/locaties', async (req, res) => {
  const b = req.body || {};
  const s = await prisma.schade.findUnique({
    where: { nummer: req.params.nummer },
    include: { locaties: true },
  });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });
  if (!b.adres || !String(b.adres).trim()) return res.status(400).json({ error: 'Vul een adres in' });

  const loc = await prisma.locatie.create({
    data: {
      ...schoon(b),
      adres: String(b.adres).trim(),
      schadeId: s.id,
      hoofd: s.locaties.length === 0,
      volgorde: s.locaties.length,
    },
  });

  await log(req.user, `Adres toegevoegd: ${loc.adres}`, s.id);
  res.status(201).json({ locatie: loc });
});

/* ─────────── bijwerken ─────────── */
router.patch('/locaties/:id', async (req, res) => {
  const b = req.body || {};
  const data = schoon(b);

  if (b.status !== undefined) {
    if (!STATUS.includes(b.status)) return res.status(400).json({ error: 'Onbekende status' });
    data.status = b.status;
    if (b.status === 'opgeleverd') data.opgeleverdAt = new Date();
    if (b.status === 'open') { data.opgeleverdAt = null; data.ingepland = null; }
  }

  const loc = await prisma.locatie.update({ where: { id: req.params.id }, data });

  // Het dossier volgt de locaties: klaar als alles klaar is.
  if (b.status !== undefined) {
    const alle = await prisma.locatie.findMany({ where: { schadeId: loc.schadeId } });
    const schade = await prisma.schade.findUnique({ where: { id: loc.schadeId } });
    const haltes = Array.isArray(schade.haltes) ? schade.haltes.map(Number) : [];

    let doel = null;
    if (alle.every((l) => l.status === 'opgeleverd') && haltes.includes(9)) doel = 9;
    else if (alle.some((l) => l.status === 'uitvoering') && haltes.includes(8)) doel = 8;
    else if (alle.some((l) => l.status === 'ingepland') && haltes.includes(7)) doel = 7;

    if (doel && schade.step < doel) {
      await prisma.schade.update({ where: { id: schade.id }, data: { step: doel } });
    }
    await log(req.user, `${loc.adres}: ${b.status}`, loc.schadeId);
  }

  res.json({ locatie: loc });
});

/* ─────────── hoofdadres aanwijzen ─────────── */
router.post('/locaties/:id/hoofd', async (req, res) => {
  const loc = await prisma.locatie.findUnique({ where: { id: req.params.id } });
  if (!loc) return res.status(404).json({ error: 'Niet gevonden' });
  await prisma.locatie.updateMany({ where: { schadeId: loc.schadeId }, data: { hoofd: false } });
  const bij = await prisma.locatie.update({ where: { id: loc.id }, data: { hoofd: true } });

  // Het dossier toont het hoofdadres in de titel.
  await prisma.schade.update({
    where: { id: loc.schadeId },
    data: { adres: bij.adres, postcode: bij.postcode, plaats: bij.plaats },
  });
  res.json({ locatie: bij });
});

/* ─────────── verwijderen ─────────── */
router.delete('/locaties/:id', async (req, res) => {
  const loc = await prisma.locatie.findUnique({ where: { id: req.params.id } });
  if (!loc) return res.status(404).json({ error: 'Niet gevonden' });
  const aantal = await prisma.locatie.count({ where: { schadeId: loc.schadeId } });
  if (aantal <= 1) return res.status(400).json({ error: 'Een dossier heeft minstens één adres nodig' });
  if (loc.hoofd) return res.status(400).json({ error: 'Wijs eerst een ander adres aan als hoofdadres' });
  await prisma.locatie.delete({ where: { id: loc.id } });
  await log(req.user, `Adres verwijderd: ${loc.adres}`, loc.schadeId);
  res.json({ verwijderd: true });
});

module.exports = router;
