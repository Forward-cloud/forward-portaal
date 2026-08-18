const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();
router.use(requireAuth);

// Een werkgang op een adres. Meerdere per adres mag: sloopwerk maandag,
// stucwerk woensdag, schilderwerk vrijdag.

async function log(user, text, schadeId, detail) {
  await prisma.logEntry.create({
    data: {
      text,
      detail: detail || null,
      schadeId: schadeId || null,
      byUserId: user.id,
      byName: user.naam,
    },
  });
}

// De vakgebieden zoals ze ook bij de opdrachtbonnen worden gebruikt.
const VAKKEN = {
  droging: 'Drogen en meten', loodgieter: 'Loodgieterswerk', dak: 'Dakwerk',
  stuc: 'Stucwerk', tegel: 'Tegelwerk', schilder: 'Schilderwerk', vloer: 'Vloeren',
  timmer: 'Timmerwerk', elektra: 'Elektra', schoonmaak: 'Schoonmaak', overig: 'Overig',
};

const datum = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

const dagNL = (d) =>
  d ? new Date(d).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' }) : '';

// '08.00' plus vier uur wordt '12.00'. Nooit later dan 19.00, want dan werkt
// er niemand meer.
function tot(start, uren) {
  const u = parseInt(String(start || '8'), 10) + Math.min(Number(uren) || 1, 11);
  return `${String(Math.min(u, 19)).padStart(2, '0')}.00`;
}

function schoon(b) {
  const d = {};
  if (b.datum !== undefined) d.datum = datum(b.datum);
  if (b.starttijd !== undefined) d.starttijd = b.starttijd ? String(b.starttijd).trim() : null;
  if (b.uren !== undefined) d.uren = Math.max(1, Math.min(Number(b.uren) || 8, 80));
  if (b.omschrijving !== undefined) d.omschrijving = String(b.omschrijving || '').trim();
  if (b.vak !== undefined) d.vak = VAKKEN[b.vak] ? b.vak : null;
  if (b.locatieId !== undefined) d.locatieId = b.locatieId || null;
  return d;
}

async function dossier(nummer) {
  return prisma.schade.findUnique({
    where: { nummer },
    select: { id: true, nummer: true, step: true, haltes: true },
  });
}

/* ─────────── lijst ─────────── */
router.get('/schades/:nummer/uitvoeringen', async (req, res) => {
  const s = await dossier(req.params.nummer);
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });

  const uitvoeringen = await prisma.uitvoering.findMany({
    where: { schadeId: s.id },
    orderBy: [{ datum: 'asc' }],
    include: { locatie: { select: { id: true, adres: true, aanduiding: true } } },
  });
  res.json({ uitvoeringen, vakken: Object.entries(VAKKEN).map(([k, v]) => ({ key: k, label: v })) });
});

/* ─────────── toevoegen ─────────── */
router.post('/schades/:nummer/uitvoeringen', async (req, res) => {
  const s = await dossier(req.params.nummer);
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });

  const d = schoon(req.body || {});
  if (!d.datum) return res.status(400).json({ error: 'Kies een datum voor de uitvoering.' });
  if (!d.omschrijving) return res.status(400).json({ error: 'Beschrijf wat er die dag gebeurt.' });

  const uitvoering = await prisma.uitvoering.create({
    data: {
      schadeId: s.id,
      locatieId: d.locatieId || null,
      datum: d.datum,
      starttijd: d.starttijd || '08.00',
      uren: d.uren || 8,
      vak: d.vak || null,
      omschrijving: d.omschrijving,
      doorNaam: req.user.naam,
    },
    include: { locatie: { select: { id: true, adres: true } } },
  });

  const waar = uitvoering.locatie ? ` \u2014 ${uitvoering.locatie.adres}` : '';
  await log(
    req.user,
    `Uitvoering ingepland${waar}`,
    s.id,
    `${dagNL(uitvoering.datum)} \u00b7 ${uitvoering.starttijd}\u2013${tot(uitvoering.starttijd, uitvoering.uren)} \u00b7 ${uitvoering.omschrijving}`
  );

  // Zodra er een werkgang staat, hoort het dossier op halte 7 te staan.
  const haltes = Array.isArray(s.haltes) ? s.haltes : [];
  if (haltes.includes(7) && s.step < 7) {
    await prisma.schade.update({ where: { id: s.id }, data: { step: 7 } });
  }

  res.json({ uitvoering });
});

/* ─────────── wijzigen ─────────── */
router.patch('/uitvoeringen/:id', async (req, res) => {
  const bestaat = await prisma.uitvoering.findUnique({
    where: { id: req.params.id },
    include: { schade: { select: { id: true } } },
  });
  if (!bestaat) return res.status(404).json({ error: 'Uitvoering niet gevonden' });

  const uitvoering = await prisma.uitvoering.update({
    where: { id: req.params.id },
    data: schoon(req.body || {}),
  });

  await log(req.user, 'Uitvoering gewijzigd', bestaat.schade.id,
    `${dagNL(uitvoering.datum)} \u00b7 ${uitvoering.omschrijving}`);

  res.json({ uitvoering });
});

/* ─────────── afronden ─────────── */
router.post('/uitvoeringen/:id/afronden', async (req, res) => {
  const bestaat = await prisma.uitvoering.findUnique({
    where: { id: req.params.id },
    include: { schade: { select: { id: true } }, locatie: { select: { adres: true } } },
  });
  if (!bestaat) return res.status(404).json({ error: 'Uitvoering niet gevonden' });

  const uitvoering = await prisma.uitvoering.update({
    where: { id: req.params.id },
    data: { afgerond: true, afgerondAt: new Date() },
  });

  const waar = bestaat.locatie ? ` \u2014 ${bestaat.locatie.adres}` : '';
  await log(req.user, `Uitvoering afgerond${waar}`, bestaat.schade.id, bestaat.omschrijving);

  res.json({ uitvoering });
});

/* ─────────── verwijderen ─────────── */
router.delete('/uitvoeringen/:id', async (req, res) => {
  const bestaat = await prisma.uitvoering.findUnique({
    where: { id: req.params.id },
    include: { schade: { select: { id: true } } },
  });
  if (!bestaat) return res.status(404).json({ error: 'Uitvoering niet gevonden' });

  await prisma.uitvoering.delete({ where: { id: req.params.id } });
  await log(req.user, 'Uitvoering verwijderd', bestaat.schade.id,
    `${dagNL(bestaat.datum)} \u00b7 ${bestaat.omschrijving}`);

  res.json({ ok: true });
});

module.exports = router;
