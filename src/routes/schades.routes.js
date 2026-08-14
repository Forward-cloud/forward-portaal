const express = require('express');
const prisma = require('../db');
const { requireAuth, isDirectie } = require('../auth/middleware');
const { schadeForUser } = require('../lib/serialize');
const {
  VERSIE, PRESETS, BRON_STATUS, ACTIEPUNTEN,
  haltesVoorPreset, normaliseerHaltes, leidAfUitKaart, bronBlokkeert, positie,
  isEigenRisico, standen, termijnOver, dagenOpen,
} = require('../lib/haltes');

const router = express.Router();
router.use(requireAuth);

async function log(user, text, opties) {
  const o = opties || {};
  await prisma.logEntry.create({
    data: {
      text,
      detail: o.detail || null,
      soort: o.soort || 'actie',
      intern: o.intern === undefined ? false : !!o.intern,
      schadeId: o.schadeId || null,
      byUserId: user.id,
      byName: user.naam,
    },
  });
}

const PREFIX = 'FS';

// Volgend vrij nummer voor een jaar, afgeleid uit het hoogste bestaande nummer.
async function volgendNummer(jaar) {
  const start = `${PREFIX}-${jaar}-`;
  const laatste = await prisma.schade.findFirst({
    where: { nummer: { startsWith: start } },
    orderBy: { nummer: 'desc' },
    select: { nummer: true },
  });
  let n = 0;
  if (laatste) {
    const staart = laatste.nummer.slice(start.length);
    n = parseInt(staart, 10) || 0;
  }
  return `${start}${String(n + 1).padStart(4, '0')}`;
}

// Zoekt een relatie op naam of maakt hem aan. Lege of nietszeggende waarden geven null.
async function relatieId(naam, soort, email) {
  const n = String(naam == null ? '' : naam).trim();
  if (!n || ['-', 'nee', 'geen', 'nvt', 'n.v.t.'].includes(n.toLowerCase())) return null;
  const bestaand = await prisma.relatie.findFirst({
    where: { naam: { equals: n, mode: 'insensitive' }, soort },
  });
  if (bestaand) return bestaand.id;
  const nieuw = await prisma.relatie.create({
    data: { naam: n, soort, email: email ? String(email).trim() : null },
  });
  return nieuw.id;
}

const datum = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

/* ─────────── lijst ─────────── */
// ?archief=nee|ja|alles   ?q=zoekterm
router.get('/', async (req, res) => {
  const archief = String(req.query.archief || 'nee').toLowerCase();
  const q = String(req.query.q || '').trim();

  const where = {};
  if (archief === 'nee') where.archived = false;
  else if (archief === 'ja') where.archived = true;

  if (q) {
    where.OR = [
      { nummer: { contains: q, mode: 'insensitive' } },
      { owner: { contains: q, mode: 'insensitive' } },
      { adres: { contains: q, mode: 'insensitive' } },
      { plaats: { contains: q, mode: 'insensitive' } },
      { opdrachtnummer: { contains: q, mode: 'insensitive' } },
      { verzSchadenummer: { contains: q, mode: 'insensitive' } },
    ];
    delete where.archived; // zoeken doorzoekt altijd alles, ook archief
  }

  const schades = await prisma.schade.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      offertes: { orderBy: { verstuurdAt: 'desc' } },
      locaties: { orderBy: [{ hoofd: 'desc' }, { volgorde: 'asc' }] },
      opdrachtbonnen: { select: { soort: true, bedrag: true, status: true, reactieVoor: true } },
      actiepunten: { where: { open: true } },
      verzekeraar: true,
      tussenpersoonRel: true,
      behandelaar: { select: { id: true, naam: true, role: true } },
    },
  });
  res.json({ schades: schades.map((s) => schadeForUser(s, req.user)) });
});

router.get('/presets', (req, res) => {
  res.json({
    presets: Object.entries(PRESETS).map(([key, p]) => ({ key, label: p.label, haltes: p.haltes })),
  });
});

router.get('/:nummer', async (req, res) => {
  const s = await prisma.schade.findUnique({
    where: { nummer: req.params.nummer },
    include: {
      locaties: { orderBy: [{ hoofd: 'desc' }, { volgorde: 'asc' }] },
      uitvoeringen: { orderBy: { datum: 'asc' } },
      actiepunten: { orderBy: [{ open: 'desc' }, { createdAt: 'asc' }] },
      facturen: { orderBy: { createdAt: 'desc' } },
      offertes: { orderBy: { verstuurdAt: 'desc' } },
      verzekeraar: true,
      tussenpersoonRel: true,
      behandelaar: { select: { id: true, naam: true, role: true } },
    },
  });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });
  res.json({ schade: schadeForUser(s, req.user) });
});

/* ─────────── logboek van een dossier ─────────── */
router.get('/:nummer/logboek', async (req, res) => {
  const s = await prisma.schade.findUnique({ where: { nummer: req.params.nummer }, select: { id: true } });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });
  const regels = await prisma.logEntry.findMany({
    where: { schadeId: s.id },
    orderBy: { createdAt: 'desc' },
    take: 300,
  });
  res.json({ regels });
});

/* ─────────── besluit na afwijzing ─────────── */
router.post('/:nummer/na-afwijzing', async (req, res) => {
  const b = req.body || {};
  const keuze = b.keuze === 'herstel' ? 'herstel' : 'gesloten';
  const s = await prisma.schade.findUnique({ where: { nummer: req.params.nummer } });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });

  const data = { naAfwijzing: keuze };

  if (keuze === 'herstel') {
    const betaler = b.betaler === 'vve' ? 'vve' : 'eigenaar';
    data.betalerNaAfwijzing = betaler;
    data.preset = 'er_offerte';
    data.haltes = haltesVoorPreset('er_offerte');
    data.status = 'open';
    if (s.step > 3) data.step = 3;
    await log(req.user, `Herstel gaat door op kosten van ${betaler === 'vve' ? 'de VvE' : 'de eigenaar'}`, {
      schadeId: s.id, soort: 'besluit',
    });
  } else {
    data.archived = true;
    data.archivedAt = new Date();
    await log(req.user, 'Dossier gesloten na afwijzing', { schadeId: s.id, soort: 'besluit' });
  }

  const bij = await prisma.schade.update({ where: { id: s.id }, data });
  res.json({ schade: schadeForUser(bij, req.user) });
});

/* ─────────── aanmaken ─────────── */
router.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.owner) return res.status(400).json({ error: 'Eigenaar is verplicht' });

  const jaar = new Date().getFullYear();
  const preset = PRESETS[b.preset] ? b.preset : 'volledig';

  for (let poging = 0; poging < 5; poging++) {
    const nummer = await volgendNummer(jaar);
    try {
      const s = await prisma.schade.create({
        data: {
          nummer,
          owner: String(b.owner).trim(),
          email: b.email || null,
          adres: b.adres || null,
          plaats: b.plaats || null,
          ins: b.ins || null,
          amount: Number(b.amount) || 0,
          preset,
          haltes: haltesVoorPreset(preset),
          traject: b.traject || 'volledig',
          opdrachtnummer: b.opdrachtnummer || null,
          opdrachtgever: b.opdrachtgever || null,
        },
      });
      // Het opgegeven adres wordt meteen het hoofdadres; extra adressen kun je erbij zetten.
      const extra = Array.isArray(b.locaties) ? b.locaties : [];
      const alle = [{ adres: b.adres, postcode: b.postcode, plaats: b.plaats, bewoner: b.owner,
                      telefoon: b.telefoon, email: b.email, bewonerSoort: b.bewonerSoort }].concat(extra);
      let i = 0;
      for (const l of alle) {
        if (!l || !l.adres || !String(l.adres).trim()) continue;
        await prisma.locatie.create({
          data: {
            schadeId: s.id,
            adres: String(l.adres).trim(),
            postcode: l.postcode || null,
            plaats: l.plaats || null,
            aanduiding: l.aanduiding || null,
            bewoner: l.bewoner || null,
            bewonerSoort: l.bewonerSoort || null,
            telefoon: l.telefoon || null,
            email: l.email || null,
            hoofd: i === 0,
            volgorde: i,
          },
        });
        i++;
      }

      await log(req.user, `Melding ontvangen`, { schadeId: s.id, soort: 'start' });
      if (b.notitie && String(b.notitie).trim()) {
        await log(req.user, 'Melding genoteerd', { schadeId: s.id, detail: String(b.notitie).trim() });
      }
      return res.status(201).json({ schade: schadeForUser(s, req.user) });
    } catch (e) {
      if (e.code === 'P2002') continue; // nummer net vergeven, opnieuw
      throw e;
    }
  }
  res.status(500).json({ error: 'Kon geen vrij schadenummer bepalen' });
});

/* ─────────── bijwerken ─────────── */
router.patch('/:nummer', async (req, res) => {
  const b = req.body || {};
  const data = {};

  ['owner', 'email', 'adres', 'plaats', 'ins', 'status', 'traject',
   'opdrachtnummer', 'opdrachtgever', 'verzSchadenummer', 'verzEmail',
   'tussenpersoon', 'polisnummer', 'oorzaak', 'beheerderEmail', 'polisvorm',
   'telefoon', 'postcode', 'beheerderTel', 'bewonerSoort', 'contactpersoon',
   'afwijzingReden', 'naAfwijzing', 'betalerNaAfwijzing', 'weigerReden'].forEach((k) => {
    if (b[k] !== undefined) data[k] = b[k] || null;
  });

  ['verzekeraarId', 'tussenpersoonId'].forEach((k) => {
    if (b[k] !== undefined) data[k] = b[k] || null;
  });

  if (b.amount !== undefined) data.amount = Number(b.amount) || 0;
  if (b.step !== undefined) data.step = Number(b.step) || 1;

  if (b.bronDoorReden !== undefined) data.bronDoorReden = b.bronDoorReden || null;
  if (b.behandelaarId !== undefined) data.behandelaarId = b.behandelaarId || null;
  if (b.herinnerDagen !== undefined) {
    data.herinnerDagen = Math.max(1, Math.min(Number(b.herinnerDagen) || 7, 60));
  }
  if (b.gefactureerd !== undefined) data.gefactureerd = !!b.gefactureerd;
  if (b.uitvoeringAt !== undefined) data.uitvoeringAt = datum(b.uitvoeringAt);
  if (b.opnameAt !== undefined) data.opnameAt = datum(b.opnameAt);
  if (b.schadedatum !== undefined) data.schadedatum = datum(b.schadedatum);
  if (b.verzIngediendAt !== undefined) data.verzIngediendAt = datum(b.verzIngediendAt);

  if (b.preset !== undefined) {
    if (!PRESETS[b.preset]) return res.status(400).json({ error: 'Onbekende voorkeuze' });
    data.preset = b.preset;
    data.haltes = haltesVoorPreset(b.preset);
  }
  if (b.haltes !== undefined) data.haltes = normaliseerHaltes(b.haltes);

  // Verzekeraarstatus — afwijzing sluit het dossier
  if (b.verzStatus !== undefined) {
    const geldig = ['geen', 'ingediend', 'informatie', 'akkoord', 'afgewezen'];
    if (!geldig.includes(b.verzStatus)) return res.status(400).json({ error: 'Onbekende verzekeraarstatus' });
    data.verzStatus = b.verzStatus;
    // Indienen zet de indieningsdatum automatisch, tenzij die wordt meegegeven.
    if (b.verzStatus === 'ingediend' && b.verzIngediendAt === undefined) {
      const nu = await prisma.schade.findUnique({
        where: { nummer: req.params.nummer },
        select: { verzIngediendAt: true },
      });
      if (!nu || !nu.verzIngediendAt) {
        data.verzIngediendAt = new Date();
        data.ingediendAt = new Date();
      }
    }
    if (b.verzStatus === 'afgewezen') {
      data.status = 'afgewezen';
      data.afwijzingAt = new Date();
      data.afwijzingReden = b.afwijzingReden || null;
      // Nog niet archiveren: eerst bepalen of er toch hersteld wordt.
    }
    if (b.verzStatus === 'akkoord') {
      const nu2 = await prisma.schade.findUnique({ where: { nummer: req.params.nummer } });
      const act = normaliseerHaltes(nu2.haltes);
      if (act.includes(6) && nu2.step < 6) data.step = 6;
    }
  }

  // Financiële velden — ALLEEN directie
  if (b.fin !== undefined) {
    if (!isDirectie(req.user)) return res.status(403).json({ error: 'Alleen directie mag omzet/marge aanpassen' });
    const f = b.fin || {};
    if (f.expertiseOmzet !== undefined) data.finExpertiseOmzet = Number(f.expertiseOmzet) || 0;
    if (f.herstelOmzet !== undefined) data.finHerstelOmzet = Number(f.herstelOmzet) || 0;
    if (f.herstelInkoop !== undefined) data.finHerstelInkoop = Number(f.herstelInkoop) || 0;
    if (f.herstelUitbesteed !== undefined) data.finHerstelUitbesteed = Number(f.herstelUitbesteed) || 0;
  }

  // Verandert de route? Zak dan terug naar de dichtstbijzijnde halte die nog bestaat.
  if (data.haltes !== undefined) {
    const huidig = await prisma.schade.findUnique({ where: { nummer: req.params.nummer } });
    if (!huidig) return res.status(404).json({ error: 'Dossier niet gevonden' });
    const doel = data.step !== undefined ? data.step : huidig.step;
    if (!data.haltes.includes(Number(doel))) {
      const lager = data.haltes.filter((h) => h < Number(doel));
      data.step = lager.length ? lager[lager.length - 1] : data.haltes[0];
    }
  }

  // Marge altijd door de server laten rekenen: omzet minus inkoop minus uitbesteed.
  if (data.amount !== undefined || data.finHerstelInkoop !== undefined ||
      data.finHerstelUitbesteed !== undefined || data.finHerstelOmzet !== undefined) {
    const nu = await prisma.schade.findUnique({ where: { nummer: req.params.nummer } });
    if (!nu) return res.status(404).json({ error: 'Dossier niet gevonden' });
    const omzet = data.finHerstelOmzet !== undefined ? data.finHerstelOmzet
      : (nu.finHerstelOmzet || (data.amount !== undefined ? data.amount : nu.amount));
    const inkoop = data.finHerstelInkoop !== undefined ? data.finHerstelInkoop : nu.finHerstelInkoop;
    const uitbesteed = data.finHerstelUitbesteed !== undefined ? data.finHerstelUitbesteed : nu.finHerstelUitbesteed;
    data.profit = Math.round(omzet - inkoop - uitbesteed);
  }

  if (data.step !== undefined) {
    const huidig = await prisma.schade.findUnique({ where: { nummer: req.params.nummer } });
    if (!huidig) return res.status(404).json({ error: 'Dossier niet gevonden' });
    const blok = bronBlokkeert(
      { ...huidig, ...data, bronDoorReden: data.bronDoorReden !== undefined ? data.bronDoorReden : huidig.bronDoorReden },
      data.step
    );
    if (blok) return res.status(409).json({ error: blok, bronWaarschuwing: true });
  }

  // Laatste halte bereikt? Dan is het dossier klaar en gaat het naar het archief.
  if (data.step !== undefined) {
    const nu = await prisma.schade.findUnique({ where: { nummer: req.params.nummer } });
    const actief = normaliseerHaltes(data.haltes !== undefined ? data.haltes : nu.haltes);
    const laatste = actief[actief.length - 1];
    if (Number(data.step) >= laatste && !nu.archived) {
      data.status = 'done';
      // Archiveren doe je bewust met de knop; zo blijft het dossier nog even in beeld.
    }
  }

  const s = await prisma.schade.update({ where: { nummer: req.params.nummer }, data });
  res.json({ schade: schadeForUser(s, req.user) });
});

/* ─────────── bronherstel ─────────── */
router.post('/:nummer/bron', async (req, res) => {
  const { status, opmerking } = req.body || {};
  if (!BRON_STATUS[status]) return res.status(400).json({ error: 'Onbekende bronstatus' });
  if (status === 'onvoldoende' && !(opmerking && String(opmerking).trim())) {
    return res.status(400).json({ error: 'Beschrijf wat er niet goed is aan het bronherstel' });
  }
  const data = {
    bronStatus: status,
    bronBeoordeeld: true,
    bronOpmerking: opmerking ? String(opmerking).trim() : null,
    bronHersteldAt: status === 'hersteld' ? new Date() : null,
  };
  // Is de bron in orde, dan vervalt een lopend aanbod om hem zelf op te lossen.
  if (status === 'hersteld' || status === 'nvt') data.bronAanbod = null;
  if (status !== 'onvoldoende') data.bronDoorReden = null;

  const s = await prisma.schade.update({ where: { nummer: req.params.nummer }, data });
  await log(req.user, `Bron ${BRON_STATUS[status].toLowerCase()}: ${s.nummer}` + (data.bronOpmerking ? ` — ${data.bronOpmerking}` : ''));
  res.json({ schade: schadeForUser(s, req.user) });
});

/* ─────────── opdracht aannemen of weigeren ───────────
   Bij aannemen kies je meteen de route, want daar hangt aan of er een
   machtiging nodig is. */
router.post('/:nummer/aannemen', async (req, res) => {
  const preset = String(req.body?.preset || '').trim();
  if (!PRESETS[preset]) return res.status(400).json({ error: 'Kies een route voor dit dossier.' });

  const s = await prisma.schade.update({
    where: { nummer: req.params.nummer },
    data: {
      preset,
      haltes: haltesVoorPreset(preset),
      status: 'prog',
      aangenomenAt: new Date(),
    },
    include: { locaties: true, actiepunten: true, verzekeraar: true },
  }).catch(() => null);
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });

  // Alleen de volledige route loopt via de verzekeraar, en daar is een
  // getekende machtiging voor nodig.
  if (preset === 'volledig') {
    const open = await prisma.actiepunt.findFirst({
      where: { schadeId: s.id, soort: 'machtiging', open: true },
    });
    if (!open) {
      await prisma.actiepunt.create({
        data: {
          schadeId: s.id,
          soort: 'machtiging',
          tekst: `Machtiging aanvragen bij ${s.opdrachtgever || s.owner}`,
          klant: true,
          doorNaam: req.user.naam,
        },
      });
    }
  }

  await log(req.user, `Opdracht aangenomen: ${s.nummer}`, { schadeId: s.id, detail: PRESETS[preset].label });
  res.json({ schade: schadeForUser(s, req.user) });
});

router.post('/:nummer/weigeren', async (req, res) => {
  const reden = String(req.body?.reden || '').trim();
  if (!reden) return res.status(400).json({ error: 'Geef een reden op. Die gaat naar de opdrachtgever.' });

  const s = await prisma.schade.update({
    where: { nummer: req.params.nummer },
    data: { weigerReden: reden, archived: true, archivedAt: new Date(), status: 'done' },
  }).catch(() => null);
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });

  await log(req.user, `Opdracht geweigerd: ${s.nummer}`, { schadeId: s.id, detail: reden });
  res.json({ schade: schadeForUser(s, req.user) });
});

/* ─────────── ons aanbod om de bron zelf op te lossen ─────────── */
router.post('/:nummer/bronaanbod', async (req, res) => {
  const vorm = String(req.body?.vorm || '').trim(); // prijs | mandaat | geen
  if (!['prijs', 'mandaat', 'geen'].includes(vorm)) {
    return res.status(400).json({ error: 'Kies of we een prijsopgave doen of op mandaat werken.' });
  }
  const wat = String(req.body?.wat || '').trim();

  const s = await prisma.schade.update({
    where: { nummer: req.params.nummer },
    data: { bronAanbod: vorm === 'geen' ? null : vorm },
  }).catch(() => null);
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });

  const naar = s.opdrachtgever || s.owner;
  const bestaat = await prisma.actiepunt.findFirst({
    where: { schadeId: s.id, soort: 'bron', open: true },
  });
  const tekst = `Wacht op antwoord over het bronherstel \u2014 ${naar}`;
  if (bestaat) {
    await prisma.actiepunt.update({ where: { id: bestaat.id }, data: { tekst } });
  } else {
    await prisma.actiepunt.create({
      data: { schadeId: s.id, soort: 'bron', tekst, klant: true, doorNaam: req.user.naam },
    });
  }

  const erbij = vorm === 'prijs' ? ' \u00b7 met aanbod, prijsopgave vooraf'
    : vorm === 'mandaat' ? ' \u00b7 met aanbod tegen mandaat' : '';
  await log(req.user, `Bronherstel aangevraagd bij ${naar}`, { schadeId: s.id, detail: wat + erbij });

  res.json({ schade: schadeForUser(s, req.user) });
});

/* ─────────── herinnering aan de verzekeraar of de klant ───────────
   Het nummer telt vanzelf op en de teller begint opnieuw. */
router.post('/:nummer/herinnering', async (req, res) => {
  const nu = await prisma.schade.findUnique({
    where: { nummer: req.params.nummer },
    include: { verzekeraar: true },
  });
  if (!nu) return res.status(404).json({ error: 'Dossier niet gevonden' });
  if (nu.verzStatus !== 'ingediend') {
    return res.status(400).json({ error: 'Er staat op dit moment niets open bij de andere partij.' });
  }

  const aantal = (nu.herinnerAantal || 0) + 1;
  const naar = isEigenRisico(nu.preset)
    ? nu.owner
    : (nu.verzekeraar ? nu.verzekeraar.naam : 'de verzekeraar');

  const s = await prisma.schade.update({
    where: { nummer: req.params.nummer },
    data: { herinnerAantal: aantal, herinnerLaatstAt: new Date() },
    include: { locaties: true, verzekeraar: true },
  });

  // Na de derde blijft aandringen zinloos; dan is het tijd om te bellen.
  if (aantal >= 3) {
    const bestaat = await prisma.actiepunt.findFirst({
      where: { schadeId: s.id, soort: 'bellen', open: true },
    });
    if (!bestaat) {
      await prisma.actiepunt.create({
        data: { schadeId: s.id, soort: 'bellen', tekst: `Bellen met ${naar}`, klant: false, doorNaam: req.user.naam },
      });
    }
  }

  await log(req.user, `${aantal}e herinnering verstuurd aan ${naar}`, {
    schadeId: s.id,
    detail: `Verzoek om binnen ${s.herinnerDagen} dagen te reageren.`,
  });

  res.json({ schade: schadeForUser(s, req.user), aantal });
});

/* ─────────── wat de verzekeraar of de klant terugstuurt ─────────── */
router.post('/:nummer/uitkomst', async (req, res) => {
  const soort = String(req.body?.soort || '').trim(); // informatie | akkoord | afgewezen
  const tekst = String(req.body?.tekst || '').trim();
  if (!['informatie', 'akkoord', 'afgewezen'].includes(soort)) {
    return res.status(400).json({ error: 'Onbekende uitkomst' });
  }

  const nu = await prisma.schade.findUnique({
    where: { nummer: req.params.nummer },
    include: { verzekeraar: true },
  });
  if (!nu) return res.status(404).json({ error: 'Dossier niet gevonden' });

  const eigen = isEigenRisico(nu.preset);
  const wie = eigen ? nu.owner : (nu.verzekeraar ? nu.verzekeraar.naam : 'de verzekeraar');
  const data = {};

  if (soort === 'informatie') {
    if (!tekst) return res.status(400).json({ error: 'Leg vast wat er gevraagd is.' });
    // De teller staat stil tot wij hebben aangeleverd.
    data.verzStatus = 'informatie';
  }
  if (soort === 'akkoord') {
    data.verzStatus = 'akkoord';
    data.step = 6;
  }
  if (soort === 'afgewezen') {
    if (!tekst) return res.status(400).json({ error: 'Leg de reden van de afwijzing vast.' });
    data.verzStatus = 'afgewezen';
    data.afwijzingReden = tekst;
    data.afwijzingAt = new Date();
    data.naAfwijzing = null;
  }

  const s = await prisma.schade.update({
    where: { nummer: req.params.nummer },
    data,
    include: { locaties: true, verzekeraar: true, actiepunten: true },
  });

  if (soort === 'informatie') {
    const bestaat = await prisma.actiepunt.findFirst({
      where: { schadeId: s.id, soort: 'info', open: true },
    });
    const punt = `Aanleveren aan ${wie} \u2014 ${tekst}`;
    if (bestaat) await prisma.actiepunt.update({ where: { id: bestaat.id }, data: { tekst: punt } });
    else await prisma.actiepunt.create({
      data: { schadeId: s.id, soort: 'info', tekst: punt, klant: true, doorNaam: req.user.naam },
    });
    await log(req.user, `${wie} vraagt aanvullende informatie`, { schadeId: s.id, detail: tekst });
  }

  if (soort === 'akkoord') {
    await prisma.actiepunt.updateMany({
      where: { schadeId: s.id, soort: 'info', open: true },
      data: { open: false, afgerondAt: new Date() },
    });
    await log(req.user, eigen ? 'Klant akkoord met de offerte' : `${wie} akkoord`, { schadeId: s.id });
  }

  if (soort === 'afgewezen') {
    if (!eigen) {
      await prisma.actiepunt.create({
        data: {
          schadeId: s.id, soort: 'klant',
          tekst: 'Klant informeren over de afwijzing',
          klant: false, doorNaam: req.user.naam,
        },
      });
    }
    await log(req.user, eigen ? 'Klant wijst de offerte af' : 'Claim afgewezen', {
      schadeId: s.id, detail: tekst,
    });
  }

  res.json({ schade: schadeForUser(s, req.user) });
});

/* ─────────── informatie aangeleverd ───────────
   Daarmee loopt de teller weer, vanaf vandaag. */
router.post('/:nummer/aangeleverd', async (req, res) => {
  const wat = String(req.body?.wat || '').trim();
  const nu = await prisma.schade.findUnique({
    where: { nummer: req.params.nummer },
    include: { verzekeraar: true },
  });
  if (!nu) return res.status(404).json({ error: 'Dossier niet gevonden' });

  const wie = isEigenRisico(nu.preset)
    ? nu.owner
    : (nu.verzekeraar ? nu.verzekeraar.naam : 'de verzekeraar');

  const s = await prisma.schade.update({
    where: { nummer: req.params.nummer },
    data: {
      infoVerstuurdAt: new Date(),
      verzStatus: nu.verzStatus === 'informatie' ? 'ingediend' : nu.verzStatus,
    },
    include: { locaties: true, verzekeraar: true },
  });

  await prisma.actiepunt.updateMany({
    where: { schadeId: s.id, soort: 'info', open: true },
    data: { open: false, afgerondAt: new Date() },
  });

  await log(req.user, `Aanvullende informatie naar ${wie} gestuurd`, { schadeId: s.id, detail: wat });
  res.json({ schade: schadeForUser(s, req.user) });
});

/* ─────────── behandelaar wisselen ───────────
   Deze naam komt onder de brieven en op de opdrachtbonnen. */
router.post('/:nummer/behandelaar', async (req, res) => {
  const id = String(req.body?.behandelaarId || '').trim();
  const medewerker = id
    ? await prisma.user.findUnique({ where: { id }, select: { id: true, naam: true, active: true } })
    : null;
  if (id && (!medewerker || !medewerker.active)) {
    return res.status(400).json({ error: 'Die medewerker bestaat niet of is niet actief.' });
  }

  const nu = await prisma.schade.findUnique({
    where: { nummer: req.params.nummer },
    include: { behandelaar: { select: { naam: true } } },
  });
  if (!nu) return res.status(404).json({ error: 'Dossier niet gevonden' });

  const s = await prisma.schade.update({
    where: { nummer: req.params.nummer },
    data: { behandelaarId: medewerker ? medewerker.id : null },
    include: { locaties: true, verzekeraar: true, behandelaar: { select: { id: true, naam: true, role: true } } },
  });

  await log(req.user, medewerker ? `Dossier overgedragen aan ${medewerker.naam}` : 'Behandelaar losgemaakt', {
    schadeId: s.id,
    detail: nu.behandelaar ? `was ${nu.behandelaar.naam}` : '',
  });

  res.json({ schade: schadeForUser(s, req.user) });
});

/* ─────────── wachtstand ─────────── */
router.post('/:nummer/bronopties', async (req, res) => {
  const b = req.body || {};
  const data = {};
  if (b.bronFactuur !== undefined) data.bronFactuur = !!b.bronFactuur;
  if (b.bronDoorOns !== undefined) data.bronDoorOns = !!b.bronDoorOns;
  const s = await prisma.schade.update({ where: { nummer: req.params.nummer }, data });
  res.json({ schade: schadeForUser(s, req.user) });
});

router.post('/:nummer/wacht', async (req, res) => {
  const { reden, tot } = req.body || {};
  if (!reden || !String(reden).trim()) {
    return res.status(400).json({ error: 'Geef een reden op, zodat je collega weet waarom dit stilligt' });
  }
  const s = await prisma.schade.update({
    where: { nummer: req.params.nummer },
    data: { wachtReden: String(reden).trim(), wachtTot: datum(tot) },
  });
  await log(req.user, `In de wacht: ${s.nummer} — ${s.wachtReden}`);
  res.json({ schade: schadeForUser(s, req.user) });
});

router.delete('/:nummer/wacht', async (req, res) => {
  const s = await prisma.schade.update({
    where: { nummer: req.params.nummer },
    data: { wachtReden: null, wachtTot: null },
  });
  await log(req.user, `Weer opgepakt: ${s.nummer}`);
  res.json({ schade: schadeForUser(s, req.user) });
});

/* ─────────── archief ─────────── */
router.post('/:nummer/archief', async (req, res) => {
  const s = await prisma.schade.update({
    where: { nummer: req.params.nummer },
    data: { archived: true, archivedAt: new Date() },
  });
  await log(req.user, `Gearchiveerd: ${s.nummer}`);
  res.json({ schade: schadeForUser(s, req.user) });
});

router.delete('/:nummer/archief', async (req, res) => {
  const s = await prisma.schade.update({
    where: { nummer: req.params.nummer },
    data: { archived: false, archivedAt: null },
  });
  await log(req.user, `Uit archief gehaald: ${s.nummer}`);
  res.json({ schade: schadeForUser(s, req.user) });
});

/* ─────────── documentzichtbaarheid ─────────── */
router.patch('/:nummer/documents', async (req, res) => {
  const { document, visible } = req.body || {};
  if (!document) return res.status(400).json({ error: 'document vereist' });
  const s = await prisma.schade.findUnique({ where: { nummer: req.params.nummer } });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });
  const dv = { ...(s.docVisible || {}) };
  dv[document] = !!visible;
  const updated = await prisma.schade.update({ where: { nummer: req.params.nummer }, data: { docVisible: dv } });
  res.json({ schade: schadeForUser(updated, req.user) });
});

/* ─────────── import vanuit de schadekaart ─────────── */
// Body: { rijen: [...], drooploop: true|false }
// Bestaat er al een dossier met hetzelfde opdrachtnummer, dan wordt het bijgewerkt.
router.post('/import', async (req, res) => {
  if (!isDirectie(req.user)) return res.status(403).json({ error: 'Alleen directie mag importeren' });

  const rijen = Array.isArray(req.body && req.body.rijen) ? req.body.rijen : [];
  if (!rijen.length) return res.status(400).json({ error: 'Geen regels ontvangen' });
  const droogloop = !!(req.body && req.body.droogloop);

  // Oudste eerst, zodat de nummering chronologisch loopt.
  const gesorteerd = rijen.slice().sort((a, b) => {
    const da = datum(a.ingediendAt), db = datum(b.ingediendAt);
    if (da && db) return da - db;
    if (da) return -1;
    if (db) return 1;
    return 0;
  });

  const resultaat = { versie: VERSIE, nieuw: 0, bijgewerkt: 0, overgeslagen: 0, regels: [] };

  for (const r of gesorteerd) {
    const owner = String(r.owner || '').trim();
    const adres = String(r.adres || '').trim();
    if (!owner && !adres) {
      resultaat.overgeslagen++;
      resultaat.regels.push({ adres, status: 'overgeslagen', reden: 'geen opdrachtgever of adres' });
      continue;
    }

    const afgeleid = leidAfUitKaart(r);
    const ing = datum(r.ingediendAt);
    const jaar = ing ? ing.getFullYear() : new Date().getFullYear();

    const velden = {
      owner: owner || adres,
      adres: adres || null,
      plaats: r.plaats || null,
      ins: r.ins || null,
      amount: Math.round(Number(r.amount) || 0),
      opdrachtnummer: r.opdrachtnummer ? String(r.opdrachtnummer).trim() : null,
      opdrachtgever: r.opdrachtgever || null,
      verzEmail: r.verzEmail || null,
      tussenpersoon: r.tussenpersoon || null,
      verzSchadenummer: r.verzSchadenummer ? String(r.verzSchadenummer).trim() : null,
      verzIngediendAt: ing,
      ingediendAt: ing,
      uitvoeringAt: datum(r.uitvoeringAt),
      gefactureerd: afgeleid.step >= 9,
      preset: afgeleid.preset,
      haltes: afgeleid.haltes,
      step: afgeleid.step,
      verzStatus: afgeleid.verzStatus,
      bronStatus: afgeleid.bronStatus,
      traject: afgeleid.preset === 'expertise' ? 'expertise' : 'volledig',
    };

    // Verzekeraar en tussenpersoon koppelen aan de adreslijst (aanmaken als ze nog niet bestaan)
    if (!droogloop) {
      velden.verzekeraarId = await relatieId(r.ins, 'VERZEKERAAR');
      velden.tussenpersoonId = await relatieId(r.tussenpersoon, 'TUSSENPERSOON', r.verzEmail);
    }

    const bestaand = velden.opdrachtnummer
      ? await prisma.schade.findFirst({ where: { opdrachtnummer: velden.opdrachtnummer } })
      : null;

    if (bestaand) {
      if (!droogloop) await prisma.schade.update({ where: { id: bestaand.id }, data: velden });
      resultaat.bijgewerkt++;
      resultaat.regels.push({ nummer: bestaand.nummer, adres, status: 'bijgewerkt', halte: afgeleid.step, preset: afgeleid.preset, positie: afgeleid.haltes.indexOf(afgeleid.step) + 1, totaal: afgeleid.haltes.length });
      continue;
    }

    const nummer = droogloop ? `${PREFIX}-${jaar}-????` : await volgendNummer(jaar);
    if (!droogloop) {
      await prisma.schade.create({ data: { nummer, ...velden } });
    }
    resultaat.nieuw++;
    resultaat.regels.push({ nummer, adres, status: 'nieuw', halte: afgeleid.step, preset: afgeleid.preset, positie: afgeleid.haltes.indexOf(afgeleid.step) + 1, totaal: afgeleid.haltes.length });
  }

  if (!droogloop) {
    await log(req.user, `Import schadekaart: ${resultaat.nieuw} nieuw, ${resultaat.bijgewerkt} bijgewerkt`);
  }
  res.json(resultaat);
});

module.exports = router;
