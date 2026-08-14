const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../auth/middleware');
const { ACTIEPUNTEN } = require('../lib/haltes');

const router = express.Router();
router.use(requireAuth);

// Wat er nu open staat op een dossier. Blijft staan als de halte verspringt,
// want een machtiging of een herinnering hoort niet bij één halte.

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

async function dossier(nummer) {
  return prisma.schade.findUnique({ where: { nummer }, select: { id: true } });
}

/* ─────────── lijst ─────────── */
router.get('/schades/:nummer/actiepunten', async (req, res) => {
  const s = await dossier(req.params.nummer);
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });

  const alles = String(req.query.alles || '') === 'ja';
  const actiepunten = await prisma.actiepunt.findMany({
    where: { schadeId: s.id, ...(alles ? {} : { open: true }) },
    orderBy: [{ open: 'desc' }, { createdAt: 'asc' }],
  });
  res.json({ actiepunten, soorten: Object.keys(ACTIEPUNTEN) });
});

/* ─────────── openen ───────────
   Eén open punt per soort. Bestaat hij al, dan werken we de tekst bij in
   plaats van er een tweede naast te zetten. */
router.post('/schades/:nummer/actiepunten', async (req, res) => {
  const s = await dossier(req.params.nummer);
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });

  const soort = String(req.body?.soort || '').trim();
  const tekst = String(req.body?.tekst || '').trim();
  if (!ACTIEPUNTEN[soort]) return res.status(400).json({ error: 'Onbekend soort actiepunt.' });
  if (!tekst) return res.status(400).json({ error: 'Schrijf op wat er moet gebeuren.' });

  const klant = req.body?.klant === undefined ? ACTIEPUNTEN[soort].klant : !!req.body.klant;

  const bestaat = await prisma.actiepunt.findFirst({
    where: { schadeId: s.id, soort, open: true },
  });

  const actiepunt = bestaat
    ? await prisma.actiepunt.update({ where: { id: bestaat.id }, data: { tekst, klant } })
    : await prisma.actiepunt.create({
        data: { schadeId: s.id, soort, tekst, klant, doorNaam: req.user.naam },
      });

  if (!bestaat) await log(req.user, `Actiepunt: ${tekst}`, s.id);

  res.json({ actiepunt, nieuw: !bestaat });
});

/* ─────────── afronden ─────────── */
router.post('/actiepunten/:id/afronden', async (req, res) => {
  const bestaat = await prisma.actiepunt.findUnique({
    where: { id: req.params.id },
    include: { schade: { select: { id: true } } },
  });
  if (!bestaat) return res.status(404).json({ error: 'Actiepunt niet gevonden' });
  if (!bestaat.open) return res.json({ actiepunt: bestaat });

  const actiepunt = await prisma.actiepunt.update({
    where: { id: req.params.id },
    data: { open: false, afgerondAt: new Date() },
  });

  await log(req.user, `${bestaat.tekst} \u2014 afgerond`, bestaat.schade.id);

  res.json({ actiepunt });
});

/* ─────────── heropenen ───────────
   Voor als iets te vroeg is afgevinkt. */
router.post('/actiepunten/:id/heropenen', async (req, res) => {
  const bestaat = await prisma.actiepunt.findUnique({
    where: { id: req.params.id },
    include: { schade: { select: { id: true } } },
  });
  if (!bestaat) return res.status(404).json({ error: 'Actiepunt niet gevonden' });

  const actiepunt = await prisma.actiepunt.update({
    where: { id: req.params.id },
    data: { open: true, afgerondAt: null },
  });

  await log(req.user, `${bestaat.tekst} \u2014 weer geopend`, bestaat.schade.id);

  res.json({ actiepunt });
});

/* ─────────── verwijderen ─────────── */
router.delete('/actiepunten/:id', async (req, res) => {
  const bestaat = await prisma.actiepunt.findUnique({
    where: { id: req.params.id },
    include: { schade: { select: { id: true } } },
  });
  if (!bestaat) return res.status(404).json({ error: 'Actiepunt niet gevonden' });

  await prisma.actiepunt.delete({ where: { id: req.params.id } });
  await log(req.user, `Actiepunt verwijderd: ${bestaat.tekst}`, bestaat.schade.id);

  res.json({ ok: true });
});

module.exports = router;
