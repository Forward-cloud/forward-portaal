const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const prisma = require('../db');
const { OPSLAG, bepaalMime, veiligeNaam } = require('./documentsoorten');

/* ─────────── binnengekomen post ───────────
   Leest de mailbox van schade@ uit en zet berichten in het postvak. Twee dingen
   maken het verschil tussen een bruikbaar postvak en een tweede inbox vol ruis:

   1. Filteren. Nieuwsbrieven, automatische antwoorden en afwezigheidsberichten
      horen er niet in. Wat we weglaten leggen we wel vast, met de reden, zodat
      je kunt nakijken waarom iets niet is verschenen.

   2. Koppelen. Een antwoord op onze brief hoort bij het dossier waar die brief
      uit kwam, zonder dat iemand dat handmatig moet aanwijzen.             */

const HOST = (process.env.IMAP_HOST || 'imap.gmail.com').trim();
const POORT = Number(process.env.IMAP_POORT || 993);
const GEBRUIKER = (process.env.MAIL_GEBRUIKER || '').trim();
// Een app-wachtwoord van Google wordt met spaties getoond; die horen er niet bij.
const WACHTWOORD = (process.env.MAIL_WACHTWOORD || '').replace(/\s+/g, '');
const MAP = (process.env.IMAP_MAP || 'INBOX').trim();

// Hoe ver terug we kijken bij de eerste keer. Daarna alleen wat nieuw is.
const DAGEN_TERUG = Number(process.env.IMAP_DAGEN || 14);

// Bijlagen bewaren we op schijf, zodat je een polisblad of offerte uit de mail
// met één klik als dossierstuk kunt opslaan. Twee grenzen: niets groter dan dit
// per bestand, en niet meer dan dit bij elkaar per bericht. Een mailbox vol
// foto's mag de schijf niet laten vollopen.
const BIJLAGE_MAX = Number(process.env.POSTVAK_BIJLAGE_MAX || 20 * 1024 * 1024);
const BIJLAGE_MAX_TOTAAL = Number(process.env.POSTVAK_BIJLAGE_TOTAAL || 40 * 1024 * 1024);

function ingesteld() {
  return !!(GEBRUIKER && WACHTWOORD);
}

/* ─────────── filteren ───────────
   De volgorde is bewust: eerst wat zeker geen post voor ons is, dan de
   twijfelgevallen. Elke reden is een korte tekst die in het portaal te zien is. */

const RECLAME_WOORDEN = [
  'nieuwsbrief', 'newsletter', 'uitschrijven', 'unsubscribe', 'aanbieding',
  'webinar', 'gratis proefperiode', 'kortingscode', 'black friday',
];

function wegreden(bericht) {
  const k = bericht.koppen || {};
  const van = String(bericht.van || '').toLowerCase();
  const onderwerp = String(bericht.onderwerp || '').toLowerCase();

  // Deze koppen zetten fatsoenlijke verzenders er zelf op.
  if (k['list-unsubscribe'] || k['list-id']) return 'nieuwsbrief';
  if (/bulk|list|junk/i.test(k.precedence || '')) return 'massamail';
  if (k['auto-submitted'] && !/^no$/i.test(k['auto-submitted'])) return 'automatisch antwoord';
  if (k['x-autoreply'] || k['x-autorespond']) return 'automatisch antwoord';
  if (/^\s*(yes|oof)\s*$/i.test(k['x-auto-response-suppress'] || '')) return 'automatisch antwoord';

  // Gmail zet zelf een label op wat het als ongewenst ziet.
  if (/spam|phishing/i.test(k['x-gm-labels'] || '')) return 'door Gmail als spam gemarkeerd';
  if (/^yes$/i.test(k['x-spam-flag'] || '')) return 'als spam gemarkeerd';

  // Postbussen waar nooit een mens achter zit.
  if (/^(no-?reply|noreply|donotreply|mailer-daemon|postmaster|bounce)/i.test(van)) {
    // Een bounce is wél belangrijk: dan is onze post niet aangekomen.
    if (/^(mailer-daemon|postmaster)/i.test(van)) return null;
    return 'afzender ontvangt geen antwoord';
  }

  if (/^(automatisch antwoord|automatic reply|out of office|afwezig)/i.test(onderwerp)) {
    return 'afwezigheidsbericht';
  }
  if (RECLAME_WOORDEN.some((w) => onderwerp.includes(w))) return 'reclame';

  return null;
}

/* ─────────── koppelen aan een dossier ───────────
   Vier manieren, van zeker naar waarschijnlijk. We stoppen bij de eerste die
   raak is, en leggen vast welke het was \u2014 zodat je bij twijfel kunt zien
   waarom iets aan een dossier hangt. */

async function zoekDossier(bericht) {
  const verwijzingen = [bericht.inReplyTo, ...(bericht.refs || [])].filter(Boolean);

  // 1. Antwoord op een bericht dat wij hebben gestuurd. Het zekerst.
  if (verwijzingen.length) {
    const eerder = await prisma.verzending.findFirst({
      where: { messageId: { in: verwijzingen } },
      select: { schadeId: true },
    });
    if (eerder) return { schadeId: eerder.schadeId, wijze: 'antwoord op onze brief' };
  }

  // 2. Ons dossiernummer in het onderwerp of de tekst.
  const tekst = `${bericht.onderwerp || ''} ${bericht.tekst || ''}`;
  const nummers = tekst.match(/\bFS-\d{4}-\d{3,5}\b/gi) || [];
  for (const nr of nummers) {
    const s = await prisma.schade.findUnique({
      where: { nummer: nr.toUpperCase() }, select: { id: true },
    });
    if (s) return { schadeId: s.id, wijze: `kenmerk ${nr.toUpperCase()} in het bericht` };
  }

  // 3. Het schadenummer van de verzekeraar.
  const verzNrs = tekst.match(/\b\d{5}-\d{4,6}-\d\b/g) || [];
  for (const nr of verzNrs) {
    const s = await prisma.schade.findFirst({
      where: { verzSchadenummer: nr }, select: { id: true },
    });
    if (s) return { schadeId: s.id, wijze: `schadenummer verzekeraar ${nr}` };
  }

  // 4. Het e-mailadres van de afzender bij een lopend dossier. Minder zeker:
  //    een beheerder kan meerdere dossiers hebben, dus alleen als het er één is.
  const van = String(bericht.van || '').toLowerCase();
  if (van.includes('@')) {
    const kandidaten = await prisma.schade.findMany({
      where: {
        archived: false,
        OR: [
          { email: { equals: van, mode: 'insensitive' } },
          { beheerderEmail: { equals: van, mode: 'insensitive' } },
          { verzEmail: { equals: van, mode: 'insensitive' } },
        ],
      },
      select: { id: true },
      take: 2,
    });
    if (kandidaten.length === 1) {
      return { schadeId: kandidaten[0].id, wijze: 'afzender hoort bij dit dossier' };
    }
  }

  return { schadeId: null, wijze: null };
}

/* ─────────── één bericht opslaan ─────────── */
/* ─────────── bijlagen op schijf zetten ───────────
   Pas nadat vaststaat dat het bericht nieuw is; anders schrijven we bij elke
   ronde dezelfde bestanden opnieuw weg. Lukt één bijlage niet, dan gaat de rest
   gewoon door — liever een bericht met één ontbrekende bijlage dan geen bericht. */
function bewaarBijlagen(lijst, kenmerk) {
  const uit = [];
  let totaal = 0;

  for (const a of lijst || []) {
    // Wat er alleen staat om een logo in de handtekening te tonen, slaan we
    // over; anders staat het postvak vol met bedrijfslogo's van drie kilobyte.
    if (a.related) continue;

    const naam = veiligeNaam(a.naam || 'bijlage');
    const mime = String(a.mime || '');
    const inhoud = a.content;
    const grootte = inhoud ? inhoud.length : Number(a.grootte || 0);
    const regel = { naam, mime, grootte };

    if (!inhoud || !inhoud.length) { uit.push(regel); continue; }
    if (grootte > BIJLAGE_MAX) { regel.reden = 'te groot om te bewaren'; uit.push(regel); continue; }
    if (totaal + grootte > BIJLAGE_MAX_TOTAAL) {
      regel.reden = 'samen te groot om te bewaren'; uit.push(regel); continue;
    }

    try {
      fs.mkdirSync(OPSLAG, { recursive: true });
      const punt = naam.lastIndexOf('.');
      const ext = punt > 0 ? naam.slice(punt).toLowerCase().slice(0, 8) : '';
      const opslagnaam = `post-${kenmerk}-${crypto.randomBytes(6).toString('hex')}${ext}`;
      fs.writeFileSync(path.join(OPSLAG, opslagnaam), inhoud);
      regel.opslagnaam = opslagnaam;
      // Kan dit stuk zo als dossierstuk worden opgeslagen?
      regel.bruikbaar = !!bepaalMime(mime, naam);
      totaal += grootte;
    } catch (e) {
      regel.reden = `niet opgeslagen: ${e.message}`;
    }
    uit.push(regel);
  }

  return uit;
}

async function bewaar(bericht) {
  if (!bericht.messageId) return { overgeslagen: 'geen Message-ID' };

  const bestaat = await prisma.inkomend.findUnique({ where: { messageId: bericht.messageId } });
  if (bestaat) return { overgeslagen: 'al binnen' };

  const reden = wegreden(bericht);
  const koppel = reden ? { schadeId: null, wijze: null } : await zoekDossier(bericht);

  const rij = await prisma.inkomend.create({
    data: {
      messageId: bericht.messageId,
      inReplyTo: bericht.inReplyTo || null,
      refs: bericht.refs || [],
      van: bericht.van || '',
      vanNaam: bericht.vanNaam || null,
      aan: bericht.aan || [],
      onderwerp: (bericht.onderwerp || '').slice(0, 500),
      tekst: (bericht.tekst || '').slice(0, 100000),
      ontvangenAt: bericht.datum || new Date(),
      // Waar het bericht in de mailbox staat. Nodig om het later te kunnen
      // verplaatsen naar het label van het dossier.
      uid: bericht.uid || null,
      mailbox: bericht.mailbox || MAP,
      stand: reden ? 'genegeerd' : (koppel.schadeId ? 'gekoppeld' : 'nieuw'),
      wegreden: reden,
      koppelwijze: koppel.wijze,
      schadeId: koppel.schadeId,
      // Reclame en automatische antwoorden krijgen geen plek op de schijf;
      // daarvan bewaren we alleen dat er een bijlage bij zat.
      bijlagen: reden
        ? (bericht.bijlagen || []).map((a) => ({
            naam: veiligeNaam(a.naam || 'bijlage'),
            mime: a.mime || '',
            grootte: a.grootte || 0,
          }))
        : bewaarBijlagen(
            bericht.bijlagen,
            new Date(bericht.datum || Date.now()).toISOString().slice(0, 10)
          ),
    },
  });

  // Bij het dossier zetten wat er binnenkwam, zodat het in het logboek staat.
  if (koppel.schadeId) {
    await prisma.logEntry.create({
      data: {
        text: `Antwoord ontvangen van ${bericht.vanNaam || bericht.van}`,
        detail: `${bericht.onderwerp || '(geen onderwerp)'} \u00b7 ${koppel.wijze}`,
        schadeId: koppel.schadeId,
        byName: 'Postvak',
      },
    }).catch(() => {});
  }

  return { rij, reden, koppel };
}

/* ─────────── de mailbox uitlezen ───────────
   Draait periodiek. Faalt hij, dan meldt hij dat en probeert het de volgende
   ronde opnieuw; het portaal blijft gewoon werken. */
async function haalOp({ dagen } = {}) {
  if (!ingesteld()) {
    return { gelukt: false, reden: 'geen mailbox ingesteld', nieuw: 0, genegeerd: 0 };
  }

  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');

  const client = new ImapFlow({
    host: HOST,
    port: POORT,
    secure: true,
    auth: { user: GEBRUIKER, pass: WACHTWOORD },
    logger: false,
  });

  let nieuw = 0; let genegeerd = 0; let gezien = 0;

  try {
    await client.connect();
    const slot = await client.getMailboxLock(MAP);
    try {
      const sinds = new Date(Date.now() - (dagen || DAGEN_TERUG) * 864e5);
      for await (const bericht of client.fetch({ since: sinds }, { source: true, uid: true })) {
        gezien++;
        const p = await simpleParser(bericht.source);

        const koppen = {};
        // De koppen die het filter gebruikt, in kleine letters.
        for (const [k, v] of (p.headers || new Map())) {
          koppen[String(k).toLowerCase()] = typeof v === 'string' ? v : (v && v.text) || '';
        }

        const uit = await bewaar({
          uid: bericht.uid || null,
          mailbox: MAP,
          messageId: p.messageId,
          inReplyTo: p.inReplyTo || null,
          refs: Array.isArray(p.references) ? p.references : (p.references ? [p.references] : []),
          van: (p.from && p.from.value && p.from.value[0] && p.from.value[0].address) || '',
          vanNaam: (p.from && p.from.value && p.from.value[0] && p.from.value[0].name) || null,
          aan: ((p.to && p.to.value) || []).map((x) => x.address).filter(Boolean),
          onderwerp: p.subject || '',
          tekst: p.text || (p.html ? String(p.html).replace(/<[^>]+>/g, ' ') : ''),
          datum: p.date || new Date(),
          // De inhoud gaat mee; bewaar() zet hem pas op schijf zodra vaststaat
          // dat dit bericht nog niet binnen was.
          bijlagen: (p.attachments || []).map((a) => ({
            naam: a.filename || 'bijlage',
            mime: a.contentType || '',
            grootte: a.size || (a.content ? a.content.length : 0),
            related: !!a.related,
            content: a.content || null,
          })),
          koppen,
        });

        if (uit.rij) { if (uit.reden) genegeerd++; else nieuw++; }
      }
    } finally {
      slot.release();
    }
    await client.logout();
    return { gelukt: true, gezien, nieuw, genegeerd };
  } catch (e) {
    try { await client.close(); } catch (x) { /* al dicht */ }
    return { gelukt: false, reden: e.message, gezien, nieuw, genegeerd };
  }
}


/* ─────────── laten beoordelen ───────────
   Nieuwe post door de AI laten lezen: vraagt dit iets van ons? Zo ja, dan komt
   er een actiepunt op het dossier, en dat verschijnt op het dashboard.

   Dit gebeurt na het ophalen, niet tijdens: een IMAP-verbinding openhouden
   terwijl je op een AI-antwoord wacht is vragen om een verbroken sessie.
   Zonder AI-sleutel gebeurt er niets en blijft de rest gewoon werken.        */
async function beoordeelNieuwe({ aantal } = {}) {
  const ai = require('./ai');
  if (!ai.beschikbaar()) return { gelukt: false, reden: 'geen AI-sleutel', beoordeeld: 0, acties: 0 };

  const rijen = await prisma.inkomend.findMany({
    where: { aiScanAt: null, wegreden: null, stand: { in: ['nieuw', 'gekoppeld'] } },
    include: { schade: { select: { id: true, nummer: true } } },
    orderBy: { ontvangenAt: 'desc' },
    take: Math.min(Number(aantal) || 25, 50),
  });
  if (!rijen.length) return { gelukt: true, beoordeeld: 0, acties: 0 };

  let beoordeeld = 0; let acties = 0;

  for (const r of rijen) {
    const uit = await ai.beoordeelPost({
      van: r.vanNaam ? `${r.vanNaam} <${r.van}>` : r.van,
      onderwerp: r.onderwerp,
      tekst: r.tekst,
      dossier: r.schade ? r.schade.nummer : null,
    });

    // Geen antwoord van de AI? Dan laten we het bericht ongemoeid en probeert
    // de volgende ronde het opnieuw -- beter dan 'geen actie' vastleggen.
    if (!uit.gelukt) continue;
    beoordeeld++;

    const data = {
      aiScanAt: new Date(),
      aiActie: !!uit.actie,
      aiTekst: uit.tekst || null,
      aiSoort: uit.soort || null,
      aiTermijn: uit.termijn || null,
    };

    // Hoort het bij een dossier en vraagt het iets? Dan komt het op de lijst
    // van dat dossier te staan, en daarmee op het dashboard.
    if (uit.actie && r.schade && uit.tekst && !r.actiepuntId) {
      const punt = await prisma.actiepunt.create({
        data: {
          schadeId: r.schade.id,
          soort: uit.soort || 'klant',
          tekst: uit.tekst,
          klant: false,
          doorNaam: 'Postvak',
        },
      }).catch(() => null);
      if (punt) {
        data.actiepuntId = punt.id;
        acties++;
        await prisma.logEntry.create({
          data: {
            text: `Actiepunt uit binnengekomen post: ${uit.tekst}`,
            detail: `Bericht van ${r.vanNaam || r.van}` + (uit.termijn ? ` \u00b7 ${uit.termijn}` : ''),
            schadeId: r.schade.id,
            byName: 'Postvak',
          },
        }).catch(() => {});
      }
    }

    await prisma.inkomend.update({ where: { id: r.id }, data }).catch(() => {});
  }

  return { gelukt: true, beoordeeld, acties };
}

module.exports = { ingesteld, haalOp, bewaar, wegreden, zoekDossier, bewaarBijlagen,
  beoordeelNieuwe, GEBRUIKER, HOST, MAP };
