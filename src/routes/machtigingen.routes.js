const crypto = require('crypto');
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../auth/middleware');
const { BEDRIJF, PORTAAL } = require('../lib/brieven');

const router = express.Router();

// De machtiging waarmee de klant ons toestemming geeft namens hem op te treden,
// en tegelijk de opdrachtbevestiging voor de opname en het rapport. Hij krijgt
// een link, leest wat hij tekent, en zet er zijn handtekening onder. Wat er
// getekend is bewaren we woordelijk -- niet alleen een vinkje, maar de tekst
// zoals die op dat moment op zijn scherm stond.

// Wat een opname en rapportage kosten als de verzekeraar ze niet vergoedt.
// Bedragen exclusief btw; aan te passen in Coolify zonder de code te wijzigen.
const TARIEF = {
  opname: Number(process.env.TARIEF_OPNAME || 130),
  uur: Number(process.env.TARIEF_UUR || 90),
};

const eur = (n) => '\u20ac ' + Number(n).toLocaleString('nl-NL', { minimumFractionDigits: 2 });

const escH = (v) =>
  String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const langeDatum = (d) =>
  new Date(d).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });

async function log(user, text, schadeId, detail) {
  await prisma.logEntry.create({
    data: {
      text,
      detail: detail || null,
      schadeId: schadeId || null,
      byUserId: user ? user.id : null,
      byName: user ? user.naam : 'Klantportaal',
    },
  });
}

/* ══════ wat er in het stuk staat ══════ */

// De gegevens die een verzekeraar nodig heeft om ons als gemachtigde te
// erkennen. Zonder polisnummer en schadedatum komt een dossier niet in
// behandeling.
function gegevensBlok(s) {
  const r = [];
  r.push(['Opdrachtgever', s.opdrachtgever || s.owner]);
  if (s.opdrachtgever && s.owner !== s.opdrachtgever) r.push(['Eigenaar', s.owner]);
  r.push(['Schadelocatie', [s.adres, s.postcode, s.plaats].filter(Boolean).join(', ')]);
  if (s.schadedatum) r.push(['Schadedatum', langeDatum(s.schadedatum)]);
  r.push(['Schadenummer Forward', s.nummer]);
  if (s.verzekeraar && s.verzekeraar.naam) r.push(['Verzekeraar', s.verzekeraar.naam]);
  if (s.polisnummer) r.push(['Polisnummer', s.polisnummer]);
  if (s.verzSchadenummer) r.push(['Schadenummer verzekeraar', s.verzSchadenummer]);
  if (s.tussenpersoon) r.push(['Tussenpersoon', s.tussenpersoon]);
  if (s.opdrachtnummer) r.push(['Opdrachtnummer', s.opdrachtnummer]);
  if (s.oorzaak) r.push(['Oorzaak', s.oorzaak]);
  r.push(['Tarief schade-opname', `${eur(TARIEF.opname)} excl. btw`]);
  r.push(['Tarief rapportage', `${eur(TARIEF.uur)} per uur excl. btw`]);
  return r;
}

// De artikelen. In gewone taal, maar compleet: de klant moet weten waar hij
// aan toe is, en wij moeten betaald krijgen voor werk dat is gedaan.
function artikelen(zakelijk, wie) {
  const lijst = [
    ['I', 'Wat u ons opdraagt',
      `U geeft ${BEDRIJF.naam} opdracht om de schade op te nemen, een schaderapport en een ` +
      'herstelbegroting op te stellen, en het dossier bij uw verzekeraar in te dienen. ' +
      'U machtigt ons om daarover met de verzekeraar, de tussenpersoon en de expert te overleggen ' +
      'en stukken op te vragen en te ontvangen. Dit formulier is tegelijk uw opdrachtbevestiging.' +
      (zakelijk
        ? ` Opdrachtgever is ${wie} als rechtspersoon. De opstalverzekering loopt op naam van de ` +
          'vereniging; individuele appartementseigenaars zijn geen partij bij deze opdracht en ' +
          'kunnen daaraan geen rechten of verplichtingen ontlenen.'
        : '')],

    ['II', 'Herstel pas na uw akkoord',
      'Wij beginnen niet zomaar aan het herstel. Dat gebeurt pas als u akkoord bent en de ' +
      'verzekeraar heeft goedgekeurd. U krijgt daarvoor een aparte offerte.'],

    ['III', 'Wat de opname en het rapport kosten',
      `De opname op locatie kost ${eur(TARIEF.opname)} en het opstellen van het rapport en de ` +
      `begroting ${eur(TARIEF.uur)} per uur, beide exclusief btw. Dit zijn kosten om de schade ` +
      'vast te stellen. Wij dienen ze in bij uw verzekeraar.'],

    ['IV', 'Deze kosten horen bij de verzekeraar',
      'Kosten die worden gemaakt om de schade vast te stellen komen op grond van artikel 7:959 ' +
      'lid 1 van het Burgerlijk Wetboek ten laste van de verzekeraar, ook als daardoor het ' +
      'verzekerd bedrag wordt overschreden. Een opname op locatie en een onderbouwd schaderapport ' +
      'zijn nodig om de omvang van de schade te bepalen; de kosten daarvan zijn redelijk en in ' +
      'verhouding tot de schade. ' +
      (zakelijk
        ? 'Veel polissen kennen hiervoor een aparte dekking voor de kosten van een door de ' +
          'verzekerde ingeschakelde deskundige. Wij dienen de kosten in met een gespecificeerde ' +
          'onderbouwing, zodat de verzekeraar ze kan toetsen aan de polisvoorwaarden.'
        : 'Bij een particuliere verzekering mag van deze bepaling niet in het nadeel van de ' +
          'verzekeringnemer worden afgeweken.')],

    ['V', 'Doen wij het herstel, dan vervallen die kosten',
      'Krijgen wij binnen dertig dagen na goedkeuring door de verzekeraar de opdracht voor het ' +
      'herstel, dan brengen wij de kosten uit artikel III niet in rekening. Ze zitten dan in de ' +
      'herstelprijs. U betaalt dus niet twee keer.'],

    ['VI', 'Kiest u een andere aannemer',
      'Dat mag altijd \u2014 u bent vrij in uw keuze. In dat geval blijven de kosten uit ' +
      'artikel III wel verschuldigd, omdat dat werk al is gedaan en u het resultaat ervan ' +
      'gebruikt. U ontvangt daarvoor een factuur met een betaaltermijn van veertien dagen. ' +
      'Wij rekenen geen boete en geen extra vergoeding.'],

    ['VII', 'Het rapport blijft van ons tot het is betaald',
      'Het schaderapport en de begroting zijn opgesteld voor dit dossier. Zolang de kosten uit ' +
      'artikel III niet zijn voldaan, mogen deze stukken niet worden gebruikt door een andere ' +
      'aannemer of derde. Na betaling mag u ze vrij gebruiken.'],

    ['VIII', 'Wat wij de verzekeraar laten weten',
      'Voert een ander het herstel uit, of trekt u de opdracht in, dan melden wij dat bij de ' +
      'verzekeraar en dragen wij het dossier over. Wij melden alleen feiten: dat wij het herstel ' +
      'niet uitvoeren en per wanneer. Wij geven geen oordeel over u of over de andere partij.'],

    ['IX', 'Als de verzekeraar toch niet vergoedt',
      'Blijft de verzekeraar ondanks artikel IV bij een afwijzing, of valt de schade zelf buiten ' +
      'de dekking, dan komt het niet vergoede deel van de kosten uit artikel III voor uw ' +
      'rekening. Wij laten u dat weten zodra het bekend is, v\u00f3\u00f3rdat er verder wordt ' +
      'gewerkt, en wij helpen u kosteloos met bezwaar bij de verzekeraar. ' +
      'Deze afspraak geldt uitsluitend tussen u en ons: de verzekeraar kan er geen recht aan ' +
      'ontlenen om vergoeding te weigeren, en zij laat de verplichting uit artikel IV onverlet.' +
      (zakelijk
        ? ' De factuur gaat naar de vereniging, niet naar een individuele appartementseigenaar.'
        : '')],

    ['X', 'De uitkering gaat naar u',
      'De verzekeraar betaalt de schade-uitkering aan de verzekerde of rechthebbende, niet aan ons. ' +
      'Deze machtiging is geen cessie en geen betaalvolmacht. Wij tekenen geen ' +
      'vaststellingsovereenkomst of finale kwijting namens u, en maken geen afspraken die u ' +
      'financieel binden zonder uw schriftelijke akkoord.'],

    ['XI', 'Uw gegevens',
      'Wij delen de gegevens en documenten die voor de afhandeling nodig zijn met de verzekeraar, ' +
      'de tussenpersoon en de leveranciers die wij inschakelen. Verder met niemand. Dit gebeurt ' +
      'volgens onze privacyverklaring, en alleen voor deze schade.'],

    ['XII', 'Bevoegdheid',
      zakelijk
        ? `Ondergetekende verklaart bevoegd te zijn ${wie} rechtsgeldig te vertegenwoordigen, op ` +
          'grond van het splitsingsreglement, een bestuursbesluit, een besluit van de vergadering ' +
          'of een beheerovereenkomst, en binnen het daarin gegeven mandaat te handelen. ' +
          'Is voor deze opdracht een besluit van de vergadering nodig, dan zorgt de vereniging ' +
          'daarvoor; wij mogen daarvan een afschrift opvragen. Gaat het om schade in een ' +
          'privégedeelte, dan is de vereniging opdrachtgever voor het deel dat onder de ' +
          'opstalverzekering valt, en de eigenaar voor het deel dat voor zijn rekening komt, ' +
          'zoals het eigen risico of schade aan zijn inboedel of afwerking.'
        : 'Ondergetekende verklaart eigenaar of rechthebbende te zijn en bevoegd deze opdracht te geven.'],

    ['XIII', 'Hoe lang dit geldt',
      'Deze opdracht en machtiging lopen tot de schade is afgehandeld: tot het herstel is ' +
      'opgeleverd en gefactureerd, of tot vaststaat dat de claim is afgewezen en het dossier ' +
      'wordt gesloten. U kunt tussentijds opzeggen; wat tot dat moment is gedaan blijft ' +
      'verschuldigd tegen de tarieven uit artikel III. Wij dragen het dossier en de opgestelde ' +
      'stukken dan aan u over, nadat die kosten zijn voldaan.'],
  ];

  if (!zakelijk) {
    // Bij een particulier geldt veertien dagen bedenktijd. Die kun je niet
    // wegschrijven, dus regelen we hem zoals het hoort: hij vraagt zelf om
    // directe start en weet wat dat betekent.
    lijst.push(['XIV', 'Uw bedenktijd',
      'Omdat u deze opdracht op afstand geeft, heeft u veertien dagen bedenktijd. Vraagt u ons ' +
      'hieronder om meteen te beginnen, dan doen wij dat. Bedenkt u zich daarna alsnog binnen die ' +
      'veertien dagen, dan betaalt u alleen het deel dat op dat moment is uitgevoerd. Is de ' +
      'opdracht dan al helemaal uitgevoerd, dan is herroepen niet meer mogelijk.']);
  }

  return lijst;
}

// De tekst zoals hij getekend wordt, woordelijk bewaard bij de machtiging.
function machtigingTekst(s, zakelijk) {
  const wie = s.opdrachtgever || s.owner;
  const kop = `Met dit formulier machtigt ${wie} ${BEDRIJF.naam} om de opstalschade namens u te ` +
    'melden, het dossier op te stellen en in te dienen bij uw verzekeraar, en geeft u ons ' +
    'opdracht tot de opname en de rapportage.';
  const arts = artikelen(zakelijk, wie).map(([n, t, b]) => `${n}. ${t}. ${b}`).join('\n\n');
  const wij = `Opdrachtnemer: ${BEDRIJF.naam}, ${BEDRIJF.adres}, ${BEDRIJF.postcode} ` +
    `${BEDRIJF.plaats}. KvK ${BEDRIJF.kvk} \u00b7 ${BEDRIJF.email}` +
    (BEDRIJF.telefoon ? ` \u00b7 ${BEDRIJF.telefoon}` : '') + '.';
  return [kop, arts, wij].join('\n\n');
}

/* ══════ wat de klant ziet ══════ */

router.get('/machtiging/:token', async (req, res) => {
  const m = await prisma.machtiging.findUnique({
    where: { token: req.params.token },
    include: { schade: { select: { nummer: true, adres: true, plaats: true, owner: true } } },
  });
  if (!m) return res.status(404).send(pagina({ fout: 'Deze link bestaat niet of is verlopen.' }));
  if (m.status === 'ingetrokken') {
    return res.send(pagina({ fout: 'Deze machtiging is ingetrokken. U hoeft niets te doen.' }));
  }

  // Het openen leggen we vast: zo weet je of hij hem gezien heeft.
  if (m.status !== 'getekend') {
    await prisma.machtiging.update({
      where: { id: m.id },
      data: {
        status: m.status === 'open' ? 'geopend' : m.status,
        geopendAt: m.geopendAt || new Date(),
        openCount: { increment: 1 },
      },
    });
    if (!m.geopendAt) await log(null, 'Machtiging geopend door de klant', m.schadeId, m.naarNaam);
  }

  res.send(pagina({ m }));
});

router.post('/machtiging/:token/tekenen', express.json({ limit: '2mb' }), async (req, res) => {
  const m = await prisma.machtiging.findUnique({ where: { token: req.params.token } });
  if (!m) return res.status(404).json({ error: 'Deze link bestaat niet meer.' });
  if (m.status === 'getekend') return res.json({ ok: true, al: true });
  if (m.status === 'ingetrokken') return res.status(400).json({ error: 'Deze machtiging is ingetrokken.' });

  const naam = String(req.body?.naam || '').trim();
  const plaats = String(req.body?.plaats || '').trim();
  const functie = String(req.body?.functie || '').trim();
  const krabbel = String(req.body?.handtekening || '');

  if (naam.length < 3) return res.status(400).json({ error: 'Vul uw volledige naam in.' });
  if (!plaats) return res.status(400).json({ error: 'Vul in waar u ondertekent.' });
  if (m.zakelijk && !functie) {
    return res.status(400).json({ error: 'Vul uw functie in, bijvoorbeeld bestuurder of beheerder.' });
  }
  if (req.body?.akkoord !== true) return res.status(400).json({ error: 'Zet een vinkje bij de verklaring.' });
  if (!m.zakelijk && req.body?.directStart !== true) {
    return res.status(400).json({ error: 'Vink ook het tweede vakje aan, zodat wij mogen beginnen.' });
  }
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(krabbel)) {
    return res.status(400).json({ error: 'Zet uw handtekening in het vak.' });
  }
  if (krabbel.length < 1200) return res.status(400).json({ error: 'De handtekening is te klein om te bewaren.' });
  if (krabbel.length > 900000) return res.status(400).json({ error: 'De handtekening is te groot.' });

  // Alleen het begin van het adres, genoeg als bewijs en niet meer dan dat.
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0].trim().split('.').slice(0, 2).join('.') + '.x.x';

  await prisma.machtiging.update({
    where: { id: m.id },
    data: {
      status: 'getekend',
      getekendAt: new Date(),
      tekenNaam: naam,
      tekenFunctie: functie || null,
      tekenPlaats: plaats || null,
      tekenWijze: req.body?.wijze === 'teken' ? 'getekend' : 'getypt',
      directStart: req.body?.directStart === true,
      handtekening: krabbel,
      tekenIp: ip,
    },
  });

  await prisma.actiepunt.updateMany({
    where: { schadeId: m.schadeId, soort: 'machtiging', open: true },
    data: { open: false, afgerondAt: new Date() },
  });

  await log(null, 'Machtiging getekend', m.schadeId,
    `${naam}${functie ? ', ' + functie : ''}${plaats ? ' te ' + plaats : ''}`);

  res.json({ ok: true });
});

/* ══════ het portaal ══════ */
router.use(requireAuth);

router.get('/schades/:nummer/machtigingen', async (req, res) => {
  const s = await prisma.schade.findUnique({ where: { nummer: req.params.nummer }, select: { id: true } });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });

  const lijst = await prisma.machtiging.findMany({
    where: { schadeId: s.id },
    orderBy: { createdAt: 'desc' },
  });

  // Staat er een open machtiging langer stil dan de termijn, dan gaat de
  // herinnering vanzelf de deur uit. Zo hoeft niemand het te onthouden.
  for (const m of lijst) {
    if (m.status === 'getekend' || m.status === 'ingetrokken') continue;
    const vanaf = m.herinnerdAt || m.verstuurdAt;
    const dagen = Math.floor((Date.now() - new Date(vanaf).getTime()) / 864e5);
    if (dagen >= (m.herinnerDagen || 3) && m.herinneringen < 4) {
      await prisma.machtiging.update({
        where: { id: m.id },
        data: { herinneringen: { increment: 1 }, herinnerdAt: new Date() },
      });
      await log(null, `${m.herinneringen + 1}e herinnering machtiging verstuurd`, m.schadeId,
        `${m.naarNaam} \u00b7 ${m.status === 'geopend' ? 'wel geopend, niet getekend' : 'nog niet geopend'}`);
      m.herinneringen += 1;
      m.herinnerdAt = new Date();
    }
  }

  res.json({
    machtigingen: lijst.map((m) => ({
      ...m,
      // De afbeelding zelf halen we apart op; in de lijst hoeven we alleen
      // te weten dat hij er is.
      handtekening: undefined,
      heeftKrabbel: !!m.handtekening,
      link: `${PORTAAL}/machtiging/${m.token}`,
      dagenStil: Math.floor((Date.now() - new Date(m.herinnerdAt || m.verstuurdAt).getTime()) / 864e5),
    })),
  });
});

router.post('/schades/:nummer/machtigingen', async (req, res) => {
  const s = await prisma.schade.findUnique({
    where: { nummer: req.params.nummer },
    include: { verzekeraar: { select: { naam: true } } },
  });
  if (!s) return res.status(404).json({ error: 'Dossier niet gevonden' });

  const naarWie = String(req.body?.naar || 'klant');
  const naam = naarWie === 'beheerder' ? (s.opdrachtgever || s.owner) : s.owner;
  const email = naarWie === 'beheerder' ? s.beheerderEmail : s.email;
  if (!email) {
    return res.status(400).json({ error: `Er staat geen e-mailadres bij ${naam}. Vul dat eerst in bij Contact.` });
  }

  // Loopt er al een? Dan die opnieuw sturen in plaats van een tweede maken.
  const bestaat = await prisma.machtiging.findFirst({
    where: { schadeId: s.id, status: { in: ['open', 'geopend'] } },
  });
  if (bestaat) {
    const uit = await prisma.machtiging.update({
      where: { id: bestaat.id },
      data: { verstuurdAt: new Date(), herinneringen: { increment: 1 }, herinnerdAt: new Date() },
    });
    await log(req.user, 'Machtiging opnieuw verstuurd', s.id, naam);
    return res.json({ machtiging: { ...uit, handtekening: undefined, link: `${PORTAAL}/machtiging/${uit.token}` }, opnieuw: true });
  }

  const zakelijk = naarWie === 'beheerder' || !!s.opdrachtgever;
  const m = await prisma.machtiging.create({
    data: {
      schadeId: s.id,
      token: crypto.randomBytes(24).toString('base64url'),
      tekst: machtigingTekst(s, zakelijk),
      gegevens: gegevensBlok(s),
      zakelijk,
      naarNaam: naam,
      naarEmail: email,
      kanaal: req.body?.kanaal === 'app' ? 'app' : 'mail',
      herinnerDagen: Math.max(1, Math.min(Number(req.body?.herinnerDagen) || 3, 30)),
    },
  });

  const open = await prisma.actiepunt.findFirst({
    where: { schadeId: s.id, soort: 'machtiging', open: true },
  });
  const tekst = `Wacht op de getekende machtiging \u2014 ${naam}`;
  if (open) await prisma.actiepunt.update({ where: { id: open.id }, data: { tekst } });
  else await prisma.actiepunt.create({
    data: { schadeId: s.id, soort: 'machtiging', tekst, klant: true, doorNaam: req.user.naam },
  });

  await log(req.user, 'Machtiging verstuurd', s.id, `${naam} \u00b7 ${email}`);
  res.status(201).json({ machtiging: { ...m, handtekening: undefined, link: `${PORTAAL}/machtiging/${m.token}` } });
});

// Het stuk zelf, in elke stand. Is hij getekend, dan staat de handtekening
// eronder; zo niet, dan zie je wat er is verstuurd en of hij is geopend.
router.get('/machtigingen/:id/document', async (req, res) => {
  const m = await prisma.machtiging.findUnique({
    where: { id: req.params.id },
    include: { schade: { select: { nummer: true, adres: true, plaats: true, owner: true } } },
  });
  if (!m) return res.status(404).send('Niet gevonden');
  res.send(pagina({ m, alleenLezen: true }));
});

router.post('/machtigingen/:id/herinneren', async (req, res) => {
  const m = await prisma.machtiging.findUnique({ where: { id: req.params.id } });
  if (!m) return res.status(404).json({ error: 'Niet gevonden' });
  if (m.status === 'getekend') return res.status(400).json({ error: 'Deze is al getekend.' });

  const uit = await prisma.machtiging.update({
    where: { id: m.id },
    data: { herinneringen: { increment: 1 }, herinnerdAt: new Date() },
  });
  await log(req.user, `${uit.herinneringen}e herinnering machtiging verstuurd`, m.schadeId,
    `${m.naarNaam} \u00b7 ${m.status === 'geopend' ? 'wel geopend, niet getekend' : 'nog niet geopend'}`);

  res.json({ machtiging: { ...uit, handtekening: undefined, link: `${PORTAAL}/machtiging/${uit.token}` } });
});

router.post('/machtigingen/:id/intrekken', async (req, res) => {
  const m = await prisma.machtiging.findUnique({ where: { id: req.params.id } });
  if (!m) return res.status(404).json({ error: 'Niet gevonden' });

  await prisma.machtiging.update({ where: { id: m.id }, data: { status: 'ingetrokken' } });
  await prisma.actiepunt.updateMany({
    where: { schadeId: m.schadeId, soort: 'machtiging', open: true },
    data: { open: false, afgerondAt: new Date() },
  });
  await log(req.user, 'Machtiging ingetrokken', m.schadeId, m.naarNaam);
  res.json({ ok: true });
});


/* ══════ de pagina, in de vorm van het machtigingsformulier ══════ */

const VORM_CSS = `@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@500;600;700&family=Inter:wght@400;500;600&family=Caveat:wght@600&display=swap');
:root{
  --navy:#151F35;--navy-2:#26324C;--teal:#009BA8;--teal-ink:#007B86;--teal-soft:#E5F5F6;
  --ink:#25303f;--muted:#6b7280;--muted-2:#9aa4b2;--line:#e6e9ee;--line-2:#eef1f5;--canvas:#EEF1F4;--amber:#B7791F;--green:#1E9E63;--green-soft:#E7F6EE;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--canvas);font-family:'Inter',system-ui,sans-serif;color:var(--ink);line-height:1.55;-webkit-font-smoothing:antialiased;padding:34px 16px}
.sheet{max-width:820px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 18px 50px -20px rgba(20,31,53,.32);overflow:hidden}
.accent{height:5px;background:linear-gradient(90deg,var(--navy) 0 55%,var(--teal) 55% 100%)}
.pad{padding:38px 46px}
/* header */
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding:30px 46px 22px;border-bottom:1px solid var(--line)}
.fwd-logo{display:block;height:auto;width:172px}
.fwd-logo .cls-1{fill:var(--teal)}.fwd-logo .cls-2{fill:var(--navy)}.fwd-logo .cls-3{fill:none;stroke:var(--teal);stroke-miterlimit:10;stroke-width:1.4}
.head-meta{text-align:right;font-size:11px;color:var(--muted);line-height:1.6}
.head-meta b{color:var(--navy)}
/* titles */
.doc-eyebrow{font-family:'Poppins';font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--teal-ink)}
h1{font-family:'Poppins';font-size:25px;font-weight:700;color:var(--navy);margin:4px 0 6px;letter-spacing:-.01em}
.lede{font-size:13.5px;color:var(--muted);max-width:58ch}
.section{margin-top:26px}
.section > h2{font-family:'Poppins';font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--navy);display:flex;align-items:center;gap:10px;margin-bottom:14px}
.section > h2::before{content:"";width:20px;height:20px;border-radius:6px;background:var(--teal-soft);color:var(--teal-ink);flex:none;display:grid;place-items:center;font-size:11px;font-weight:700;font-family:'Poppins'}
.s1 h2::before{content:"1"}.s2 h2::before{content:"2"}.s3 h2::before{content:"3"}.s4 h2::before{content:"4"}
/* opdrachtgever type toggle */
.seg{display:inline-flex;background:var(--canvas);border:1px solid var(--line);border-radius:11px;padding:3px;gap:3px;margin-bottom:16px}
.seg button{font-family:inherit;font-size:12.5px;font-weight:600;padding:8px 15px;border-radius:8px;border:none;background:none;color:var(--muted);cursor:pointer;transition:.15s}
.seg button.on{background:#fff;color:var(--teal-ink);box-shadow:0 1px 4px rgba(20,31,53,.1)}
/* fields */
.grid{display:grid;grid-template-columns:1fr 1fr;gap:13px 18px}
.grid .full{grid-column:1/-1}
.f label{display:block;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--muted-2);margin-bottom:5px}
.f input{width:100%;font-family:inherit;font-size:13.5px;color:var(--ink);padding:9px 12px;border:1px solid var(--line);border-radius:9px;background:#fff;transition:.15s;outline:none}
.f input:focus{border-color:var(--teal);box-shadow:0 0 0 3px var(--teal-soft)}
.f input:read-only{background:var(--line-2);color:var(--navy);border-color:transparent}
/* opdrachtnemer block */
.on-block{background:var(--canvas);border-radius:12px;padding:15px 17px;font-size:12.5px;color:var(--ink);line-height:1.6}
.on-block b{color:var(--navy);font-family:'Poppins';font-size:13px}
.on-block .row{color:var(--muted)}
/* clauses */
.clause{display:flex;gap:13px;padding:12px 0;border-bottom:1px solid var(--line-2)}
.clause:last-child{border-bottom:none}
.clause .num{flex:none;width:26px;height:26px;border-radius:8px;background:var(--navy);color:#fff;font-family:'Poppins';font-weight:600;font-size:12px;display:grid;place-items:center}
.clause .body{font-size:13px;color:var(--ink)}
.clause .body b{color:var(--navy)}
.callout{background:var(--teal-soft);border-left:3px solid var(--teal);border-radius:10px;padding:12px 15px;font-size:12.5px;color:var(--navy);margin-top:14px}
/* signing */
.sign-wrap{background:var(--canvas);border-radius:14px;padding:22px 24px;margin-top:8px}
.sign-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 20px;margin-bottom:6px}
.sig-box{grid-column:1/-1}
.sig-pad{border:1.5px dashed var(--muted-2);border-radius:10px;background:#fff;height:92px;display:flex;align-items:center;padding:0 18px;position:relative}
.sig-pad .caveat{font-family:'Caveat',cursive;font-size:38px;color:var(--navy);line-height:1}
.sig-pad .ph{color:var(--muted-2);font-size:13px}
.consent{display:flex;gap:11px;align-items:flex-start;margin:16px 0 4px;font-size:12.5px;color:var(--ink)}
.consent input{width:18px;height:18px;accent-color:var(--teal);margin-top:1px;flex:none}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
.btn{font-family:inherit;font-size:13.5px;font-weight:600;padding:11px 20px;border-radius:10px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:9px;transition:.15s}
.btn svg{width:17px;height:17px}
.btn.primary{background:var(--teal);color:#fff;box-shadow:0 6px 16px -6px rgba(0,155,168,.6)}
.btn.primary:hover{background:var(--teal-ink)}
.btn.ghost{background:#fff;color:var(--navy);border:1px solid var(--line)}
.btn.ghost:hover{border-color:var(--muted-2)}
.btn:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
/* signed seal */
.seal{display:none;align-items:center;gap:14px;background:var(--green-soft);border:1px solid #b9e4cc;border-radius:12px;padding:15px 18px;margin-top:16px}
.seal.show{display:flex}
.seal .ico{width:40px;height:40px;border-radius:10px;background:var(--green);color:#fff;display:grid;place-items:center;flex:none}
.seal .t1{font-family:'Poppins';font-weight:600;font-size:14px;color:var(--green)}
.seal .t2{font-size:11.5px;color:var(--muted);margin-top:2px}
.foot{padding:18px 46px 30px;border-top:1px solid var(--line);display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:10.5px;color:var(--muted-2)}
.err{color:#C0392B;font-size:12px;font-weight:600;margin-top:10px;display:none}
.err.show{display:block}
@media(max-width:640px){.pad,.head,.foot{padding-left:22px;padding-right:22px}.grid,.sign-grid{grid-template-columns:1fr}h1{font-size:21px}}
@media print{
  body{background:#fff;padding:0}
  .sheet{box-shadow:none;border-radius:0;max-width:none}
  .seg,.actions,.err{display:none!important}
  .f input,.sig-pad{border:1px solid #cbd2da}
  .accent{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .clause .num,.btn.primary,.seal .ico,.section>h2::before{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}`;

const VORM_LOGO = `<svg class="fwd-logo" viewBox="0 0 239.41 89.51" xmlns="http://www.w3.org/2000/svg"><g>
<path class="cls-2" d="M6.85,15.58v10.47H2.37V.46h15.82V4.59H6.85v6.97h9.52v4.03H6.85Z"/>
<path class="cls-2" d="M43.6,26.46c-7.32,0-12.36-5.43-12.36-13.23S36.32,0,43.64,0s12.43,5.43,12.43,13.23-5.11,13.23-12.46,13.23Zm.04-22.16c-4.69,0-7.7,3.47-7.7,8.93s3.01,8.93,7.7,8.93,7.7-3.54,7.7-8.93-3.01-8.93-7.7-8.93Z"/>
<path class="cls-2" d="M70.73,26.04V.46h9.77c5.81,0,9.21,2.94,9.21,7.98,0,3.43-1.61,5.88-4.62,7.11l4.87,10.5h-4.9l-4.34-9.56h-5.5v9.56h-4.48Zm4.48-13.51h5.29c2.84,0,4.52-1.51,4.52-4.1s-1.68-3.99-4.52-3.99h-5.29V12.53Z"/>
<path class="cls-2" d="M102.22,.46h4.66l4.06,13.51c.39,1.4,.77,2.83,1.16,5.08,.42-2.27,.81-3.6,1.26-5.08L117.38,.46h4.94l3.96,13.51c.42,1.44,.8,2.91,1.23,5.08,.49-2.38,.84-3.75,1.23-5.04L132.85,.46h4.55l-7.77,25.59h-4.34l-5.46-18.62-5.57,18.62h-4.41L102.22,.46Z"/>
<path class="cls-2" d="M146.04,26.04L155.29,.46h4.59l9.24,25.59h-4.73l-2.07-5.92h-9.56l-2.07,5.92h-4.66Zm8.05-9.7h6.93l-2.94-8.26c-.21-.67-.46-1.44-.52-1.96-.1,.49-.31,1.26-.56,1.96l-2.91,8.26Z"/>
<path class="cls-2" d="M182.83,26.04V.46h9.77c5.81,0,9.21,2.94,9.21,7.98,0,3.43-1.61,5.88-4.62,7.11l4.87,10.5h-4.9l-4.34-9.56h-5.5v9.56h-4.48Zm4.48-13.51h5.29c2.84,0,4.52-1.51,4.52-4.1s-1.68-3.99-4.52-3.99h-5.29V12.53Z"/>
<path class="cls-2" d="M216.78,26.04V.46h8.96c7.56,0,12.78,5.22,12.78,12.85s-5.11,12.74-12.53,12.74h-9.21Zm4.48-21.46V21.91h4.31c5.11,0,8.23-3.29,8.23-8.61s-3.19-8.72-8.47-8.72h-4.06Z"/>
<path class="cls-1" d="M4.32,42.13c2.37,0,3.87,1.31,3.94,3.43h-2.05c-.05-1.01-.77-1.6-1.92-1.6-1.26,0-2.08,.61-2.08,1.58,0,.83,.45,1.3,1.42,1.52l1.84,.4c2,.43,2.98,1.46,2.98,3.2,0,2.18-1.7,3.59-4.27,3.59S.05,52.92,0,50.83H2.05c.02,.99,.82,1.58,2.13,1.58s2.22-.59,2.22-1.57c0-.78-.4-1.25-1.36-1.46l-1.86-.42c-1.98-.43-3.03-1.57-3.03-3.36,0-2.05,1.7-3.47,4.16-3.47Z"/>
<path class="cls-1" d="M18.43,48.2c0-3.63,2.29-6.05,5.71-6.05,2.77,0,4.83,1.62,5.23,4.13h-2.16c-.4-1.36-1.57-2.16-3.12-2.16-2.16,0-3.52,1.57-3.52,4.07s1.38,4.08,3.52,4.08c1.58,0,2.8-.83,3.19-2.13h2.13c-.45,2.47-2.59,4.1-5.36,4.1-3.41,0-5.62-2.37-5.62-6.03Z"/>
<path class="cls-1" d="M40.05,54.04v-11.7h2.05v4.83h5.19v-4.83h2.05v11.7h-2.05v-4.96h-5.19v4.96h-2.05Z"/>
<path class="cls-1" d="M59.6,54.04l4.23-11.7h2.1l4.23,11.7h-2.16l-.94-2.71h-4.37l-.94,2.71h-2.13Zm3.68-4.43h3.17l-1.34-3.78c-.1-.3-.21-.66-.24-.9-.05,.22-.14,.58-.26,.9l-1.33,3.78Z"/>
<path class="cls-1" d="M80.42,54.04v-11.7h4.1c3.46,0,5.84,2.38,5.84,5.87s-2.34,5.83-5.73,5.83h-4.21Zm2.05-9.81v7.92h1.97c2.34,0,3.76-1.5,3.76-3.94s-1.46-3.99-3.87-3.99h-1.86Z"/>
<path class="cls-1" d="M101.06,54.04v-11.7h7.27v1.89h-5.22v3.01h4.67v1.81h-4.67v3.11h5.22v1.89h-7.27Z"/>
<path class="cls-1" d="M119.34,54.04v-11.7h2.05v4.83h5.19v-4.83h2.05v11.7h-2.05v-4.96h-5.19v4.96h-2.05Z"/>
<path class="cls-1" d="M140.02,54.04v-11.7h7.27v1.89h-5.22v3.01h4.67v1.81h-4.67v3.11h5.22v1.89h-7.27Z"/>
<path class="cls-1" d="M158.3,54.04v-11.7h4.47c2.66,0,4.21,1.34,4.21,3.65,0,1.57-.74,2.69-2.11,3.25l2.22,4.8h-2.24l-1.98-4.37h-2.51v4.37h-2.05Zm2.05-6.18h2.42c1.3,0,2.06-.69,2.06-1.87s-.77-1.82-2.06-1.82h-2.42v3.7Z"/>
<path class="cls-1" d="M181.31,42.13c2.37,0,3.87,1.31,3.94,3.43h-2.05c-.05-1.01-.77-1.6-1.92-1.6-1.26,0-2.08,.61-2.08,1.58,0,.83,.45,1.3,1.42,1.52l1.84,.4c2,.43,2.98,1.46,2.98,3.2,0,2.18-1.7,3.59-4.27,3.59s-4.13-1.33-4.18-3.43h2.05c.02,.99,.82,1.58,2.13,1.58s2.22-.59,2.22-1.57c0-.78-.4-1.25-1.36-1.46l-1.86-.42c-1.98-.43-3.03-1.57-3.03-3.36,0-2.05,1.7-3.47,4.16-3.47Z"/>
<path class="cls-1" d="M194.91,42.34h8.9v1.89h-3.43v9.81h-2.05v-9.81h-3.43v-1.89Z"/>
<path class="cls-1" d="M214.18,54.04v-11.7h7.27v1.89h-5.22v3.01h4.67v1.81h-4.67v3.11h5.22v1.89h-7.27Z"/>
<path class="cls-1" d="M234.51,52.15h4.9v1.89h-6.95v-11.7h2.05v9.81Z"/>
</g>
<line class="cls-3" x1="42.92" y1="89.01" x2="200.34" y2="89.01"/></svg>`;

function veld(label, waarde, vol) {
  return `<div class="f${vol ? ' full' : ''}"><label>${escH(label)}</label>` +
    `<input value="${escH(waarde || '')}" readonly></div>`;
}

function artikelenBlok(m) {
  const rijen = Array.isArray(m.gegevens) ? m.gegevens : [];
  const wie = (rijen.find((r) => r[0] === 'Opdrachtgever') || [])[1] || m.naarNaam || 'de opdrachtgever';
  return artikelen(!!m.zakelijk, wie).map(([n, t, b]) =>
    `<div class="clause"><div class="num">${escH(n)}</div>` +
    `<div class="body"><b>${escH(t)}.</b> ${escH(b)}</div></div>`
  ).join('') +
  '<div class="callout">De uitkering gaat rechtstreeks naar de verzekerde. Forward regelt de ' +
  'melding, het dossier en \u2014 na akkoord \u2014 het herstel.</div>';
}

function pagina({ m, fout, alleenLezen }) {
  const kop = `<!doctype html><html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Machtiging opstalschade \u2014 ${escH(BEDRIJF.naam)}</title>
<style>${VORM_CSS}</style></head><body><div class="sheet"><div class="accent"></div>`;

  const voet = `<div class="foot">
    <span>${escH(BEDRIJF.naam)} \u00b7 ${escH(BEDRIJF.adres)}, ${escH(BEDRIJF.plaats)} \u00b7 ${escH(BEDRIJF.email)}</span>
    <span>Machtiging &amp; opdrachtbevestiging opstalschade</span>
  </div></div></body></html>`;

  if (fout) {
    return `${kop}<div class="pad"><h1>Machtiging</h1><p class="lede">${escH(fout)}</p></div>${voet}`;
  }

  const g = Object.fromEntries((Array.isArray(m.gegevens) ? m.gegevens : []).map((r) => [r[0], r[1]]));
  const zakelijk = !!m.zakelijk;
  const getekend = m.status === 'getekend';

  const hoofd = `<div class="head">${VORM_LOGO}
    <div class="head-meta">
      <div><b>${escH(BEDRIJF.naam)}</b></div>
      <div>Machtiging &amp; opdrachtbevestiging</div>
      <div>Kenmerk: <b>${escH(g['Schadenummer Forward'] || m.schade.nummer)}</b></div>
      <div>Datum: ${langeDatum(m.getekendAt || m.verstuurdAt)}</div>
    </div></div>`;

  const gegevens = `
    <div class="section s1"><h2>De opdrachtgever</h2>
      <div class="seg"><button type="button" class="${zakelijk ? 'on' : ''}">VvE</button>
        <button type="button" class="${zakelijk ? '' : 'on'}">Particulier eigenaar</button></div>
      <div class="grid">
        ${veld('Naam', g['Opdrachtgever'], true)}
        ${g['Eigenaar'] ? veld('Eigenaar', g['Eigenaar'], true) : ''}
      </div>
    </div>

    <div class="section s2"><h2>Schade &amp; polis</h2>
      <div class="grid">
        ${veld('Schadelocatie (adres)', g['Schadelocatie'], true)}
        ${veld('Schadedatum', g['Schadedatum'])}
        ${veld('Schadenummer Forward', g['Schadenummer Forward'] || m.schade.nummer)}
        ${veld('Verzekeraar', g['Verzekeraar'])}
        ${veld('Polisnummer', g['Polisnummer'])}
        ${veld('Tussenpersoon (indien van toepassing)', g['Tussenpersoon'], true)}
        ${veld('Tarief schade-opname', g['Tarief schade-opname'])}
        ${veld('Tarief rapportage', g['Tarief rapportage'])}
      </div>
    </div>

    <div class="section s3"><h2>De opdrachtnemer</h2>
      <div class="on-block">
        <b>${escH(BEDRIJF.naam)}</b><br>
        <span class="row">${escH(BEDRIJF.adres)}, ${escH(BEDRIJF.postcode)} ${escH(BEDRIJF.plaats)}</span><br>
        <span class="row">${escH(BEDRIJF.email)}${BEDRIJF.telefoon ? ' &nbsp;\u00b7&nbsp; ' + escH(BEDRIJF.telefoon) : ''}</span><br>
        <span class="row">KvK ${escH(BEDRIJF.kvk)} &nbsp;\u00b7&nbsp; hierna: \u201cForward\u201d</span>
      </div>
    </div>

    <div class="section s4"><h2>Wat u met deze machtiging afspreekt</h2>
      ${artikelenBlok(m)}
    </div>`;

  if (getekend) {
    return `${kop}${hoofd}<div class="pad">
      <div class="doc-eyebrow">Opstalschade \u00b7 volmacht &amp; opdrachtbevestiging</div>
      <h1>Machtiging tot behandeling van opstalschade</h1>
      <p class="lede">Deze machtiging is ondertekend. U kunt hem hieronder bewaren of afdrukken.</p>
      ${gegevens}
      <div class="section"><h2 style="display:block">Ondertekening</h2>
        <div class="sign-wrap">
          <div class="sign-grid">
            ${veld('Naam ondertekenaar', m.tekenNaam)}
            ${m.tekenFunctie ? veld('Functie / hoedanigheid', m.tekenFunctie) : veld('Plaats', m.tekenPlaats)}
            ${m.tekenFunctie ? veld('Plaats', m.tekenPlaats) : ''}
            ${veld('Datum', langeDatum(m.getekendAt))}
            <div class="f sig-box"><label>Handtekening</label>
              <div class="sig-pad">${m.handtekening
                ? `<img src="${escH(m.handtekening)}" alt="handtekening" style="max-height:80px">` : ''}</div></div>
          </div>
          <div class="seal show"><div class="ico"><svg viewBox="0 0 24 24" fill="none">
            <path d="M5 12l4 4L19 7" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
            <div><div class="t1">Digitaal ondertekend</div>
            <div class="t2">${escH(m.tekenNaam)}${m.tekenFunctie ? ', ' + escH(m.tekenFunctie) : ''}
              \u00b7 ${escH(m.tekenPlaats || '')} \u00b7 ${langeDatum(m.getekendAt)}</div>
            <div class="t2" style="margin-top:3px">${m.tekenWijze === 'getekend'
              ? 'Handtekening zelf gezet' : 'Naam getypt als handtekening'} \u00b7 vastgelegd op
              ${new Date(m.getekendAt).toLocaleString('nl-NL')} \u00b7 herkomst ${escH(m.tekenIp || '')}</div>
            ${m.directStart ? '<div class="t2" style="margin-top:3px">Verzocht om directe uitvoering binnen de bedenktijd.</div>' : ''}
            </div></div>
          <div class="actions"><button class="btn ghost" onclick="window.print()">
            <svg viewBox="0 0 24 24" fill="none"><path d="M6 9V3h12v6M6 18H4v-6h16v6h-2M8 14h8v7H8z"
              stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>Opslaan als PDF / printen</button></div>
        </div>
      </div>
    </div>${voet}`;
  }

  // Nog niet getekend. Vanuit het portaal alleen inzien; via de link tekenen.
  if (alleenLezen) {
    return `${kop}${hoofd}<div class="pad">
      <div class="doc-eyebrow">Opstalschade \u00b7 volmacht &amp; opdrachtbevestiging</div>
      <h1>Machtiging tot behandeling van opstalschade</h1>
      <div class="callout" style="margin-bottom:18px">Nog niet getekend \u2014 verstuurd aan
        ${escH(m.naarNaam)} op ${langeDatum(m.verstuurdAt)}${m.geopendAt
          ? `, ${m.openCount} keer bekeken` : ', nog niet geopend'}${m.herinneringen
          ? `, ${m.herinneringen} herinnering(en) verstuurd` : ''}.</div>
      ${gegevens}
      <div class="actions" style="margin-top:20px"><button class="btn ghost" onclick="window.print()">
        <svg viewBox="0 0 24 24" fill="none"><path d="M6 9V3h12v6M6 18H4v-6h16v6h-2M8 14h8v7H8z"
          stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>Opslaan als PDF / printen</button></div>
    </div>${voet}`;
  }

  return `${kop}${hoofd}<div class="pad">
    <div class="doc-eyebrow">Opstalschade \u00b7 volmacht &amp; opdrachtbevestiging</div>
    <h1>Machtiging tot behandeling van opstalschade</h1>
    <p class="lede">Met dit formulier machtigt u ${escH(BEDRIJF.naam)} om de opstalschade namens u
      te melden, het dossier op te stellen en in te dienen bij uw verzekeraar. U kunt het onderaan
      direct digitaal ondertekenen \u2014 typen of zelf tekenen \u2014 en ontvangt daarna een kopie.</p>
    ${gegevens}

    <div class="section"><h2 style="display:block">Digitaal ondertekenen</h2>
      <div class="sign-wrap">
        <div class="sign-grid">
          <div class="f"><label>Naam ondertekenaar</label>
            <input id="signName" placeholder="Voor- en achternaam" oninput="tekenNaam()"></div>
          ${zakelijk
            ? '<div class="f"><label>Functie / hoedanigheid</label><input id="signFunctie" placeholder="Bestuurder / beheerder VvE"></div>'
            : ''}
          <div class="f"><label>Plaats</label><input id="signPlaats" placeholder="Waar u ondertekent"></div>
          <div class="f sig-box"><label>Handtekening</label>
            <div class="seg" style="margin:2px 0 10px">
              <button type="button" class="on" id="sbType" onclick="setSig('type')">Typen</button>
              <button type="button" id="sbDraw" onclick="setSig('draw')">Zelf tekenen</button></div>
            <div class="sig-pad" id="sigType"><span class="ph" id="sigPh">Vul hierboven uw naam in\u2026</span>
              <span class="caveat" id="sigInk"></span></div>
            <div id="sigDraw" style="display:none">
              <div class="sig-pad" style="padding:0;overflow:hidden">
                <canvas id="sigCanvas" style="width:100%;height:92px;touch-action:none;cursor:crosshair"></canvas></div>
              <button type="button" class="btn ghost" style="padding:6px 12px;font-size:12px;margin-top:8px"
                onclick="wisDoek()">Wissen</button>
            </div>
          </div>
        </div>
        <label class="consent"><input type="checkbox" id="consent">
          <span>${zakelijk
            ? 'Ik verklaar bevoegd te zijn namens de opdrachtgever te handelen en ga akkoord met deze machtiging en opdracht, inclusief de kosten uit artikel III en IX.'
            : 'Ik verklaar eigenaar of rechthebbende te zijn en ga akkoord met deze machtiging en opdracht, inclusief de kosten uit artikel III en IX.'}</span></label>
        ${zakelijk ? '' : `<label class="consent"><input type="checkbox" id="consentStart">
          <span>Ik verzoek Forward om direct te beginnen, binnen mijn bedenktijd van veertien dagen.
          Ik begrijp dat ik bij volledige uitvoering geen herroepingsrecht meer heb, en dat ik bij
          eerdere herroeping betaal wat er tot dan toe is gedaan.</span></label>`}
        <div class="err" id="err"></div>
        <div class="actions">
          <button class="btn primary" id="knop" onclick="ondertekenen()">
            <svg viewBox="0 0 24 24" fill="none"><path d="M5 12l4 4L19 7" stroke="#fff" stroke-width="2.3"
              stroke-linecap="round" stroke-linejoin="round"/></svg>Digitaal ondertekenen</button>
          <button class="btn ghost" onclick="window.print()">
            <svg viewBox="0 0 24 24" fill="none"><path d="M6 9V3h12v6M6 18H4v-6h16v6h-2M8 14h8v7H8z"
              stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>Opslaan als PDF / printen</button>
        </div>
      </div>
    </div>
  </div>${voet}
  <script>
    var wijze = 'type', iets = false, pen = null;
    var doek = document.getElementById('sigCanvas');

    function tekenNaam(){
      var n = document.getElementById('signName').value.trim();
      document.getElementById('sigInk').textContent = n;
      document.getElementById('sigPh').style.display = n ? 'none' : 'inline';
    }

    function setSig(w){
      wijze = w;
      document.getElementById('sbType').classList.toggle('on', w === 'type');
      document.getElementById('sbDraw').classList.toggle('on', w === 'draw');
      document.getElementById('sigType').style.display = w === 'type' ? 'flex' : 'none';
      document.getElementById('sigDraw').style.display = w === 'draw' ? 'block' : 'none';
      if (w === 'draw') klaarDoek();
    }

    // Het doek is tweemaal zo groot als het beeld, zodat de handtekening
    // scherp blijft op een telefoon.
    function klaarDoek(){
      if (pen) return;
      doek.width = doek.offsetWidth * 2;
      doek.height = doek.offsetHeight * 2;
      pen = doek.getContext('2d');
      pen.scale(2, 2);
      pen.lineWidth = 2.2; pen.lineCap = 'round'; pen.lineJoin = 'round'; pen.strokeStyle = '#151F35';

      var bezig = false, vx = 0, vy = 0;
      function plek(e){
        var r = doek.getBoundingClientRect(), p = e.touches ? e.touches[0] : e;
        return { x: p.clientX - r.left, y: p.clientY - r.top };
      }
      function start(e){ e.preventDefault(); bezig = true; var p = plek(e); vx = p.x; vy = p.y; }
      function trek(e){
        if (!bezig) return; e.preventDefault();
        var p = plek(e);
        pen.beginPath(); pen.moveTo(vx, vy); pen.lineTo(p.x, p.y); pen.stroke();
        vx = p.x; vy = p.y; iets = true;
      }
      function stop(){ bezig = false; }
      doek.addEventListener('mousedown', start);
      doek.addEventListener('mousemove', trek);
      window.addEventListener('mouseup', stop);
      doek.addEventListener('touchstart', start, {passive:false});
      doek.addEventListener('touchmove', trek, {passive:false});
      doek.addEventListener('touchend', stop);
    }

    function wisDoek(){ if (pen) pen.clearRect(0,0,doek.width,doek.height); iets = false; }

    // De getypte naam op een doek zetten, zodat er altijd een afbeelding
    // wordt bewaard -- ook als er niet met de hand is getekend.
    function typNaarDoek(naam){
      var d = document.createElement('canvas');
      d.width = 900; d.height = 240;
      var c = d.getContext('2d');
      c.fillStyle = '#151F35';
      c.font = '96px Caveat, cursive';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(naam, 450, 120);
      return d.toDataURL('image/png');
    }

    function ondertekenen(){
      var naam = document.getElementById('signName').value.trim();
      var fnV = document.getElementById('signFunctie');
      var functie = fnV ? fnV.value.trim() : '';
      var plaats = document.getElementById('signPlaats').value.trim();
      var akkoord = document.getElementById('consent').checked;
      var startV = document.getElementById('consentStart');
      var err = document.getElementById('err');
      var knop = document.getElementById('knop');

      function zeg(t){ err.textContent = t; err.classList.add('show'); knop.disabled = false; }
      err.classList.remove('show');

      if (naam.length < 3) { zeg('Vul uw volledige naam in.'); return; }
      if (fnV && !functie) { zeg('Vul uw functie in, bijvoorbeeld bestuurder of beheerder.'); return; }
      if (!plaats) { zeg('Vul in waar u ondertekent.'); return; }
      if (!akkoord) { zeg('Vink de verklaring aan om te ondertekenen.'); return; }
      if (startV && !startV.checked) { zeg('Vink ook het tweede vakje aan, zodat wij mogen beginnen.'); return; }
      if (wijze === 'draw' && !iets) { zeg('Zet uw handtekening in het vak.'); return; }

      knop.disabled = true;
      var beeld = wijze === 'draw' ? doek.toDataURL('image/png') : typNaarDoek(naam);

      fetch('/machtiging/${escH(m.token)}/tekenen', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({naam:naam, plaats:plaats, functie:functie, akkoord:akkoord,
          directStart: startV ? startV.checked : true,
          wijze: wijze === 'draw' ? 'teken' : 'typ', handtekening: beeld})
      }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
        .then(function(u){
          if (!u.ok) { zeg(u.d.error || 'Er ging iets mis.'); return; }
          location.reload();
        })
        .catch(function(){ zeg('Geen verbinding. Probeer het zo nog eens.'); });
    }
  <\/script>`;
}

module.exports = router;
