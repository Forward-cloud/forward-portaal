const fs = require('fs');
const path = require('path');
const prisma = require('../db');

/* ─────────── e-mail versturen ───────────
   Eén plek waar post het pand verlaat. Elke route die iets verstuurt — brieven,
   berichten, machtigingen, opdrachtbonnen, prijsaanvragen — gaat hier doorheen,
   zodat de regels overal hetzelfde zijn:

   - Zonder sleutel wordt er niets verstuurd, maar wel vastgelegd. Het portaal
     blijft dan gewoon werken; je ziet in het dossier dat de post klaarstaat.
   - Een mislukte verzending laat een spoor na met de reden, zodat je niet
     denkt dat iets is aangekomen terwijl dat niet zo is.
   - Testdossiers zijn hiervoor al omgeleid in testmodus.js; hier gaan we uit
     van de adressen die we krijgen.                                          */

/* Twee wegen naar buiten:

   SMTP (Google Workspace)  — de gewone weg. Verzonden post staat daarna in de
     mailbox bij Verzonden, en een antwoord van de verzekeraar komt gewoon in
     schade@ binnen. Instellen met MAIL_GEBRUIKER en MAIL_WACHTWOORD (een
     app-wachtwoord uit het Google-account).

   Resend                   — alternatief als er geen mailbox is. Werkt, maar
     verzonden post staat dan nergens in een mailbox.

   Staat er niets ingesteld, dan wordt post wel vastgelegd en niet verstuurd.  */

const SMTP_HOST = (process.env.MAIL_HOST || 'smtp.gmail.com').trim();
const SMTP_POORT = Number(process.env.MAIL_POORT || 465);
const SMTP_GEBRUIKER = (process.env.MAIL_GEBRUIKER || '').trim();
const SMTP_WACHTWOORD = (process.env.MAIL_WACHTWOORD || '').replace(/\s+/g, '');

const SLEUTEL = (process.env.RESEND_API_KEY || '').trim();
const AFZENDER = (process.env.MAIL_VAN
  || (SMTP_GEBRUIKER ? `Forward Schadeherstel <${SMTP_GEBRUIKER}>` : '')
  || 'Forward Schadeherstel <schade@forwardschadeherstel.nl>').trim();
const ANTWOORD_NAAR = (process.env.MAIL_ANTWOORD || '').trim();
const OPSLAG = process.env.UPLOAD_DIR || '/data/uploads';

function viaSmtp() { return !!(SMTP_GEBRUIKER && SMTP_WACHTWOORD); }
function wegNaarBuiten() { return viaSmtp() ? 'smtp' : (SLEUTEL ? 'resend' : null); }

// Bijlagen bij elkaar mogen niet te groot worden; de meeste mailboxen weigeren
// boven de 25 MB. Wij houden 20 MB aan zodat er ruimte overblijft.
const MAX_BIJLAGEN = Number(process.env.MAIL_MAX_BIJLAGEN || 20 * 1024 * 1024);

function beschikbaar() {
  return !!wegNaarBuiten();
}

// Eén verbinding hergebruiken; opnieuw verbinden per bericht is traag en
// levert bij Google sneller een blokkade op.
let vervoer = null;
function smtpVervoer() {
  if (vervoer) return vervoer;
  const nodemailer = require('nodemailer');
  vervoer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_POORT,
    secure: SMTP_POORT === 465,
    auth: { user: SMTP_GEBRUIKER, pass: SMTP_WACHTWOORD },
    pool: true,
    maxConnections: 2,
  });
  return vervoer;
}

/* Platte tekst wordt een eenvoudige HTML-brief. Geen opmaakwerk: witregels
   blijven witregels, en meer is er niet nodig. De ontvanger krijgt ook de
   platte tekst mee, voor wie geen HTML leest. */
function alsHtml(tekst) {
  const veilig = String(tekst || '')
    .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const alinea = veilig
    .split(/\n{2,}/)
    .map((blok) => `<p style="margin:0 0 14px">${blok.replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;`
       + `font-size:14px;line-height:1.6;color:#101828;max-width:640px">${alinea}</div>`;
}

/* De bijlagen van schijf halen. Ontbreekt een bestand, dan slaan we het over
   en melden we dat — liever een brief zonder bijlage dan geen brief. */
function haalBijlagen(documenten) {
  const uit = [];
  const overgeslagen = [];
  let totaal = 0;

  for (const d of documenten) {
    const volledig = path.join(OPSLAG, d.opslagnaam);
    try {
      if (!fs.existsSync(volledig)) { overgeslagen.push(`${d.bestandsnaam} (niet gevonden)`); continue; }
      const inhoud = fs.readFileSync(volledig);
      if (totaal + inhoud.length > MAX_BIJLAGEN) {
        overgeslagen.push(`${d.bestandsnaam} (samen te groot)`);
        continue;
      }
      totaal += inhoud.length;
      uit.push({ filename: d.bestandsnaam, content: inhoud.toString('base64') });
    } catch (e) {
      overgeslagen.push(`${d.bestandsnaam} (${e.message})`);
    }
  }
  return { bijlagen: uit, overgeslagen, totaal };
}

/* De kale verzending naar Resend. Geeft terug wat er gebeurd is; gooit niet,
   want een mislukte mail mag het dossier niet blokkeren. */
async function stuur({ naar, onderwerp, tekst, html, bijlagen, antwoordNaar, kenmerk, antwoordOp }) {
  const ontvangers = (Array.isArray(naar) ? naar : [naar])
    .map((e) => String(e || '').trim())
    .filter((e) => e.includes('@'));

  if (!ontvangers.length) return { gelukt: false, fout: 'Geen geldig e-mailadres' };
  if (!wegNaarBuiten()) {
    return { gelukt: false, verstuurd: false, fout: null, geenSleutel: true };
  }

  const onderw = String(onderwerp || '(geen onderwerp)').slice(0, 300);
  const platte = String(tekst || '');
  const opgemaakt = html || alsHtml(platte);
  const antwoord = antwoordNaar || ANTWOORD_NAAR || undefined;

  /* Een eigen Message-ID, met het dossiernummer erin. Antwoordt de ontvanger,
     dan verwijst zijn bericht hiernaar en weten wij meteen bij welk dossier
     het hoort \u2014 ook als hij het onderwerp verandert. */
  const domein = (AFZENDER.match(/@([^>\s]+)/) || [])[1] || 'forwardschadeherstel.nl';
  const eigenId = `<${(kenmerk || 'fw').replace(/[^A-Za-z0-9._-]/g, '')}.`
    + `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}@${domein}>`;

  if (viaSmtp()) {
    try {
      const uit = await smtpVervoer().sendMail({
        from: AFZENDER,
        to: ontvangers,
        subject: onderw,
        text: platte,
        html: opgemaakt,
        replyTo: antwoord,
        messageId: eigenId,
        inReplyTo: antwoordOp || undefined,
        references: antwoordOp || undefined,
        attachments: (bijlagen || []).map((b) => ({
          filename: b.filename,
          content: Buffer.from(b.content, 'base64'),
        })),
      });
      return { gelukt: true, verstuurd: true, id: uit.messageId || eigenId, via: 'smtp' };
    } catch (e) {
      // De melding van Google is bruikbaar; die geven we door.
      return { gelukt: false, verstuurd: false, via: 'smtp', fout: e.message };
    }
  }

  // ── Resend ──
  const body = {
    from: AFZENDER,
    to: ontvangers,
    subject: onderw,
    text: platte,
    html: opgemaakt,
    headers: { 'Message-ID': eigenId },
  };
  if (antwoord) body.reply_to = antwoord;
  if (bijlagen && bijlagen.length) body.attachments = bijlagen;

  try {
    const stop = new AbortController();
    const klok = setTimeout(() => stop.abort(), 30000);
    let r;
    try {
      r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SLEUTEL}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: stop.signal,
      });
    } finally { clearTimeout(klok); }

    if (!r.ok) {
      let reden = `Resend antwoordde met ${r.status}`;
      try {
        const j = await r.json();
        if (j && (j.message || j.error)) reden = j.message || j.error;
      } catch (e) { /* geen json terug */ }
      return { gelukt: false, verstuurd: false, via: 'resend', fout: reden };
    }

    await r.json().catch(() => ({}));
    return { gelukt: true, verstuurd: true, id: eigenId, via: 'resend' };
  } catch (e) {
    return {
      gelukt: false,
      verstuurd: false,
      via: 'resend',
      fout: e.name === 'AbortError' ? 'Geen antwoord binnen dertig seconden' : e.message,
    };
  }
}

/* Een bestaande rij uit Verzending daadwerkelijk versturen en de stand
   bijwerken. Dit is wat de routes aanroepen; zij hoeven niets van Resend te
   weten.

   status wordt:  verstuurd  — de post is aangenomen door Resend
                  klaar      — geen sleutel; staat gereed maar is niet verstuurd
                  mislukt    — geprobeerd en niet gelukt, reden staat in fout  */
async function verstuurVerzending(rij, opties = {}) {
  const documenten = Array.isArray(rij.documentIds) && rij.documentIds.length
    ? await prisma.document.findMany({ where: { id: { in: rij.documentIds } } })
    : [];

  const { bijlagen, overgeslagen } = haalBijlagen(documenten);

  const uit = await stuur({
    naar: rij.naar,
    onderwerp: rij.onderwerp,
    tekst: rij.tekst,
    html: opties.html,
    bijlagen,
    antwoordNaar: opties.antwoordNaar,
    kenmerk: opties.kenmerk,
    antwoordOp: opties.antwoordOp,
  });

  const notities = [];
  if (overgeslagen.length) notities.push(`Bijlage niet meegestuurd: ${overgeslagen.join(', ')}`);
  if (uit.fout) notities.push(uit.fout);

  await prisma.verzending.update({
    where: { id: rij.id },
    data: {
      status: uit.geenSleutel ? 'klaar' : (uit.verstuurd ? 'verstuurd' : 'mislukt'),
      fout: notities.length ? notities.join(' \u00b7 ').slice(0, 500) : null,
      // Bewaren, zodat een antwoord straks aan dit dossier te koppelen is.
      messageId: uit.id || null,
    },
  });

  return { ...uit, overgeslagen };
}

/* Een bericht versturen zonder dat er een verzendingsrij bij hoort — voor een
   herinnering of een machtigingslink. Wel altijd vastleggen, zodat er een
   spoor is. */
async function stuurLos({ schadeId, soort, naar, onderwerp, tekst, doorNaam }) {
  const rij = await prisma.verzending.create({
    data: {
      schadeId,
      soort: soort || 'vrij',
      naar: Array.isArray(naar) ? naar : [naar].filter(Boolean),
      onderwerp: String(onderwerp || ''),
      tekst: String(tekst || ''),
      documentIds: [],
      status: 'klaar',
      doorNaam: doorNaam || null,
    },
  });
  const uit = await verstuurVerzending(rij);
  return { verzending: rij, ...uit };
}

module.exports = {
  beschikbaar, wegNaarBuiten, viaSmtp, stuur, stuurLos, verstuurVerzending, alsHtml,
  AFZENDER, MAX_BIJLAGEN, SMTP_GEBRUIKER, SMTP_HOST, SMTP_POORT,
};
