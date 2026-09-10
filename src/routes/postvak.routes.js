const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../auth/middleware');
const postvak = require('../lib/postvak');
const mappen = require('../lib/gmailmappen');
const {
  SOORTEN, TOEGESTAAN, MAX_BYTES, OPSLAG, bepaalMime, veiligeNaam,
} = require('../lib/documentsoorten');

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
    // Onder welk Gmail-label dit bericht is opgeborgen, als dat is gebeurd.
    gearchiveerd: r.gearchiveerd || null,
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
  else if (stand === 'afgehandeld') where.stand = 'afgehandeld';
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
  const [nieuw, gekoppeld, afgehandeld, genegeerd] = await Promise.all([
    prisma.inkomend.count({ where: { stand: 'nieuw' } }),
    prisma.inkomend.count({ where: { stand: 'gekoppeld' } }),
    prisma.inkomend.count({ where: { stand: 'afgehandeld' } }),
    prisma.inkomend.count({ where: { stand: 'genegeerd' } }),
  ]);

  res.json({
    berichten: rijen.map(voorScherm),
    tellers: { nieuw, gekoppeld, afgehandeld, genegeerd },
    mailbox: postvak.ingesteld() ? postvak.GEBRUIKER : null,
    map: postvak.ingesteld() ? postvak.MAP : null,
    // Waar een bijlage als dossierstuk onder kan worden opgeborgen.
    soorten: SOORTEN,
    // Archiveren in Gmail: staat het aan, en onder welke hoofdmap.
    archiveren: mappen.ingesteld() ? mappen.HOOFDMAP : null,
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

// De mailbox opruimen: alles wat nog onder het verkeerde label hangt goedzetten
// en verzonden post het label van zijn dossier geven.
router.post('/postvak/archiveren', async (req, res) => {
  if (!mappen.ingesteld()) {
    return res.status(503).json({
      error: 'Archiveren in Gmail staat uit. Zet GMAIL_ARCHIVEREN=aan in Coolify.',
    });
  }
  const uit = await mappen.archiveerRonde();
  if (!uit.gelukt) return res.status(502).json({ error: `Archiveren mislukt: ${uit.reden}` });
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

  // Direct naar het label van het dossier, zodat het uit de inbox verdwijnt.
  // Lukt dat nu niet, dan pakt de volgende ronde het op.
  const verplaatst = await mappen.archiveerNu(r.id).catch(() => null);
  await prisma.logEntry.create({
    data: {
      text: `Bericht van ${r.vanNaam || r.van} aan dit dossier gekoppeld`,
      detail: r.onderwerp || null,
      schadeId: s.id, byUserId: req.user.id, byName: req.user.naam,
    },
  }).catch(() => {});

  res.json({ bericht: uit, verplaatst: !!(verplaatst && verplaatst.verplaatst) });
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

/* ─────────── bijlagen ───────────
   Wat binnenkomt staat op dezelfde schijf als de dossierstukken, maar hoort
   nog nergens bij. Je kunt hem bekijken, en met één handeling als dossierstuk
   opbergen — dan maken we een eigen kopie, zodat het opruimen van het postvak
   het dossier niet leeghaalt.                                               */

function bijlageVan(rij, index) {
  const lijst = Array.isArray(rij.bijlagen) ? rij.bijlagen : [];
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= lijst.length) return null;
  return lijst[i];
}

// Bekijken of downloaden.
router.get('/postvak/:id/bijlage/:index', async (req, res) => {
  const rij = await prisma.inkomend.findUnique({ where: { id: req.params.id } });
  if (!rij) return res.status(404).json({ error: 'Bericht niet gevonden' });

  const a = bijlageVan(rij, req.params.index);
  if (!a) return res.status(404).json({ error: 'Bijlage niet gevonden' });
  if (!a.opslagnaam) {
    return res.status(404).json({
      error: a.reden
        ? `Deze bijlage is niet bewaard: ${a.reden}. Hij staat nog wel in de mailbox.`
        : 'Deze bijlage is niet bewaard. Hij staat nog wel in de mailbox.',
    });
  }

  // Nooit buiten de opslagmap kijken, wat er ook in het veld staat.
  const volledig = path.join(OPSLAG, path.basename(a.opslagnaam));
  if (!fs.existsSync(volledig)) {
    return res.status(404).json({ error: 'Het bestand staat niet meer op de server' });
  }

  const mime = bepaalMime(a.mime, a.naam);
  // Alleen wat een browser veilig kan tonen openen we in het scherm zelf.
  const inzien = mime === 'application/pdf' || String(mime).indexOf('image/') === 0;
  res.setHeader('Content-Type', mime || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `${inzien ? 'inline' : 'attachment'}; filename="${encodeURIComponent(a.naam || 'bijlage')}"`
  );
  fs.createReadStream(volledig).pipe(res);
});

/* Als dossierstuk opbergen.
   Body: { schade?: 'FS-2026-0012', soort?: 'polis' }
   Zonder schadenummer gaat hij naar het dossier waar het bericht al aan hangt. */
router.post('/postvak/:id/bijlage/:index/bewaren', async (req, res) => {
  const rij = await prisma.inkomend.findUnique({ where: { id: req.params.id } });
  if (!rij) return res.status(404).json({ error: 'Bericht niet gevonden' });

  const a = bijlageVan(rij, req.params.index);
  if (!a) return res.status(404).json({ error: 'Bijlage niet gevonden' });
  if (!a.opslagnaam) {
    return res.status(400).json({
      error: 'Deze bijlage is niet bewaard en kan dus niet worden opgeborgen. Haal hem uit de mailbox.',
    });
  }

  const nummer = String(req.body?.schade || '').trim();
  const schade = nummer
    ? await prisma.schade.findUnique({ where: { nummer } })
    : (rij.schadeId ? await prisma.schade.findUnique({ where: { id: rij.schadeId } }) : null);
  if (!schade) {
    return res.status(400).json({
      error: nummer ? `Dossier ${nummer} bestaat niet`
                    : 'Koppel het bericht eerst aan een dossier, of kies er hier een.',
    });
  }

  const soort = SOORTEN[req.body?.soort] ? req.body.soort : 'overig';
  const mime = bepaalMime(a.mime, a.naam);
  if (!mime || !TOEGESTAAN[mime]) {
    return res.status(400).json({
      error: 'Dit bestandstype kan niet als dossierstuk worden opgeslagen. Gebruik pdf, jpg, png, docx of xlsx.',
    });
  }

  const bron = path.join(OPSLAG, path.basename(a.opslagnaam));
  if (!fs.existsSync(bron)) {
    return res.status(404).json({ error: 'Het bestand staat niet meer op de server' });
  }
  const grootte = fs.statSync(bron).size;
  if (grootte > MAX_BYTES) return res.status(413).json({ error: 'Het bestand is groter dan 20 MB' });

  // Een eigen kopie onder het dossier. Zo blijft het stuk staan als het
  // postvak later wordt opgeruimd.
  fs.mkdirSync(OPSLAG, { recursive: true });
  const opslagnaam = `${schade.nummer}-${crypto.randomBytes(8).toString('hex')}${TOEGESTAAN[mime]}`;
  fs.copyFileSync(bron, path.join(OPSLAG, opslagnaam));

  const doc = await prisma.document.create({
    data: {
      schadeId: schade.id,
      soort,
      bestandsnaam: veiligeNaam(a.naam || 'bijlage'),
      opslagnaam,
      mime,
      grootte,
      gedeeld: soort === 'foto',
      doorNaam: req.user.naam,
    },
  });

  // Hangt het bericht nog nergens aan, dan is dit meteen de koppeling.
  if (!rij.schadeId) {
    await prisma.inkomend.update({
      where: { id: rij.id },
      data: {
        schadeId: schade.id,
        koppelwijze: `bijlage opgeborgen door ${req.user.naam}`,
        stand: 'gekoppeld',
      },
    });
    await mappen.archiveerNu(rij.id).catch(() => null);
  }

  await prisma.logEntry.create({
    data: {
      text: `Bijlage uit het postvak opgeborgen: ${doc.bestandsnaam} (${SOORTEN[soort]})`,
      detail: `Uit het bericht van ${rij.vanNaam || rij.van}`,
      schadeId: schade.id,
      byUserId: req.user.id,
      byName: req.user.naam,
    },
  }).catch(() => {});

  res.status(201).json({ document: doc, schade: schade.nummer });
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

    // Meteen daarna de mailbox opruimen: nieuwe post naar het juiste label en
    // verzonden brieven het label van hun dossier geven.
    if (mappen.ingesteld()) {
      const arch = await mappen.archiveerRonde().catch((e) => ({ gelukt: false, reden: e.message }));
      if (!arch.gelukt) console.error('gmail archiveren mislukt:', arch.reden);
      else if (arch.verplaatst || arch.gelabeld) {
        console.log(`gmail: ${arch.verplaatst} verplaatst, ${arch.gelabeld} gelabeld`);
      }
    }
  }, RONDE_MINUTEN * 60 * 1000);
  if (klok.unref) klok.unref();
}
