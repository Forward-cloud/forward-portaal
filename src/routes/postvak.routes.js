const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../auth/middleware');
const postvak = require('../lib/postvak');

const router = express.Router();
router.use(requireAuth);

/* ─────────── het postvak ───────────
   Wat hier binnenkomt is al gefilterd en waar mogelijk aan een dossier
   gekoppeld; zie src/lib/postvak.js. Deze routes gaan alleen over tonen en
   afhandelen.                                                              */

function voorScherm(r) {
  return {
    id: r.id,
    van: r.van,
    vanNaam: r.vanNaam || r.van,
    onderwerp: r.onderwerp,
    // In de lijst genoeg om te herkennen; de rest bij het openen.
    aanhef: (r.tekst || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    ontvangenAt: r.ontvangenAt,
    stand: r.stand,
    wegreden: r.wegreden,
    koppelwijze: r.koppelwijze,
    bijlagen: Array.isArray(r.bijlagen) ? r.bijlagen : [],
    schade: r.schade ? { nr: r.schade.nummer, owner: r.schade.owner, adres: r.schade.adres } : null,
  };
}

/* ?stand=nieuw|gekoppeld|genegeerd|alles   ?schade=FS-2026-0012 */
router.get('/postvak', async (req, res) => {
  const stand = String(req.query.stand || 'open');
  const where = {};

  if (stand === 'nieuw') where.stand = 'nieuw';
  else if (stand === 'gekoppeld') where.stand = 'gekoppeld';
  else if (stand === 'genegeerd') where.stand = 'genegeerd';
  else if (stand === 'open') where.stand = { in: ['nieuw', 'gekoppeld'] };
  // 'alles' laat het filter leeg

  if (req.query.schade) {
    const s = await prisma.schade.findUnique({
      where: { nummer: String(req.query.schade) }, select: { id: true },
    });
    where.schadeId = s ? s.id : '-';
  }

  const rijen = await prisma.inkomend.findMany({
    where,
    orderBy: { ontvangenAt: 'desc' },
    take: Math.min(Number(req.query.aantal) || 100, 300),
    include: { schade: { select: { nummer: true, owner: true, adres: true } } },
  });

  // De tellers voor de tabbladen en het bolletje in het menu.
  const [nieuw, gekoppeld, genegeerd] = await Promise.all([
    prisma.inkomend.count({ where: { stand: 'nieuw' } }),
    prisma.inkomend.count({ where: { stand: 'gekoppeld' } }),
    prisma.inkomend.count({ where: { stand: 'genegeerd' } }),
  ]);

  res.json({
    berichten: rijen.map(voorScherm),
    tellers: { nieuw, gekoppeld, genegeerd },
    mailbox: postvak.ingesteld() ? postvak.GEBRUIKER : null,
  });
});

// Eén bericht met de volledige tekst.
router.get('/postvak/:id', async (req, res) => {
  const r = await prisma.inkomend.findUnique({
    where: { id: req.params.id },
    include: { schade: { select: { nummer: true, owner: true, adres: true } } },
  });
  if (!r) return res.status(404).json({ error: 'Bericht niet gevonden' });
  res.json({ bericht: { ...voorScherm(r), tekst: r.tekst, aan: r.aan, refs: r.refs } });
});

// Nu ophalen in plaats van wachten op de volgende ronde.
router.post('/postvak/ophalen', async (req, res) => {
  if (!postvak.ingesteld()) {
    return res.status(503).json({
      error: 'Er is nog geen mailbox gekoppeld. Zet MAIL_GEBRUIKER en MAIL_WACHTWOORD in Coolify.',
    });
  }
  const uit = await postvak.haalOp({ dagen: Number(req.query.dagen) || undefined });
  if (!uit.gelukt) return res.status(502).json({ error: `Ophalen mislukt: ${uit.reden}` });
  res.json(uit);
});

// Zelf aan een dossier hangen, of juist loskoppelen.
router.post('/postvak/:id/koppel', async (req, res) => {
  const r = await prisma.inkomend.findUnique({ where: { id: req.params.id } });
  if (!r) return res.status(404).json({ error: 'Bericht niet gevonden' });

  const nummer = String(req.body?.schade || '').trim();
  if (!nummer) {
    const uit = await prisma.inkomend.update({
      where: { id: r.id },
      data: { schadeId: null, koppelwijze: null, stand: 'nieuw' },
    });
    return res.json({ bericht: uit });
  }

  const s = await prisma.schade.findUnique({ where: { nummer }, select: { id: true, nummer: true } });
  if (!s) return res.status(404).json({ error: `Dossier ${nummer} bestaat niet` });

  const uit = await prisma.inkomend.update({
    where: { id: r.id },
    data: { schadeId: s.id, koppelwijze: `handmatig door ${req.user.naam}`, stand: 'gekoppeld' },
  });
  await prisma.logEntry.create({
    data: {
      text: `Bericht van ${r.vanNaam || r.van} aan dit dossier gekoppeld`,
      detail: r.onderwerp || null,
      schadeId: s.id, byUserId: req.user.id, byName: req.user.naam,
    },
  }).catch(() => {});

  res.json({ bericht: uit });
});

/* Afhandelen of juist terugzetten. 'genegeerd' is voor post die er wel is maar
   waar niets mee hoeft; die blijft vindbaar onder het derde tabblad. */
router.post('/postvak/:id/stand', async (req, res) => {
  const stand = String(req.body?.stand || '');
  if (!['nieuw', 'gekoppeld', 'afgehandeld', 'genegeerd'].includes(stand)) {
    return res.status(400).json({ error: 'Onbekende stand' });
  }
  const r = await prisma.inkomend.findUnique({ where: { id: req.params.id } });
  if (!r) return res.status(404).json({ error: 'Bericht niet gevonden' });

  const uit = await prisma.inkomend.update({
    where: { id: r.id },
    data: {
      stand,
      // Zet je iets zelf terug in het postvak, dan vervalt de reden waarom het
      // was weggefilterd \u2014 anders blijft er 'reclame' bij staan.
      wegreden: stand === 'genegeerd' ? (r.wegreden || `handmatig door ${req.user.naam}`) : null,
    },
  });
  res.json({ bericht: uit });
});

module.exports = router;

/* ─────────── periodiek ophalen ───────────
   Elke tien minuten, zodat je niet zelf op een knop hoeft te drukken. Bij een
   fout gebeurt er niets bijzonders: de volgende ronde probeert het opnieuw. */
const RONDE_MINUTEN = Number(process.env.POSTVAK_MINUTEN || 10);

if (process.env.NODE_ENV !== 'test' && postvak.ingesteld()) {
  const klok = setInterval(async () => {
    const uit = await postvak.haalOp();
    if (!uit.gelukt) console.error('postvak ophalen mislukt:', uit.reden);
    else if (uit.nieuw) console.log(`postvak: ${uit.nieuw} nieuw, ${uit.genegeerd} weggefilterd`);
  }, RONDE_MINUTEN * 60 * 1000);
  if (klok.unref) klok.unref();
}
