const express = require('express');
const { requireDirectie } = require('../auth/middleware');

const router = express.Router();

/* ─────────── zelftest van de koppelingen ───────────
   Eén pagina die per koppeling zegt of hij het doet, en zo niet: waarom.
   Zonder dit moet je in de logs graven of gokken of een sleutel goed staat.

   Open in het portaal:  /api/zelftest
   Alleen voor directie, want hier staan namen van instellingen in.          */

// Nooit de sleutel zelf tonen — alleen dat hij er is en hoe lang hij is.
function sleutelHint(v) {
  if (!v) return null;
  const s = String(v);
  return `${s.length} tekens, begint met ${s.slice(0, 6)}\u2026`;
}

async function metTijdslimiet(fn, ms) {
  const stop = new AbortController();
  const klok = setTimeout(() => stop.abort(), ms);
  try {
    return await fn(stop.signal);
  } finally {
    clearTimeout(klok);
  }
}

// ── Anthropic ──────────────────────────────────────────────────────────
async function testAnthropic() {
  // Bij het plakken in Coolify sluipt er makkelijk een spatie of regeleinde in.
  const sleutel = (process.env.ANTHROPIC_API_KEY || '').trim();
  const model = (process.env.AI_MODEL || 'claude-sonnet-4-6').trim();
  const werkruimte = (process.env.ANTHROPIC_WORKSPACE_ID || '').trim();
  const uit = { naam: 'Brieven opstellen (Anthropic)', instelling: 'ANTHROPIC_API_KEY',
    ingesteld: !!sleutel, sleutel: sleutelHint(sleutel), model,
    werkruimte: werkruimte || null };

  if (!sleutel) {
    uit.stand = 'uit';
    uit.melding = 'Geen sleutel ingesteld. Zet ANTHROPIC_API_KEY in Coolify.';
    return uit;
  }

  try {
    // De modellenlijst opvragen kost niets en zegt meteen of de sleutel deugt.
    const koppen = { 'x-api-key': sleutel, 'anthropic-version': '2023-06-01' };
    if (werkruimte) koppen['anthropic-workspace-id'] = werkruimte;

    const r = await metTijdslimiet((signal) => fetch('https://api.anthropic.com/v1/models', {
      headers: koppen, signal,
    }), 8000);

    if (!r.ok) {
      // Anthropic stuurt de reden mee in het antwoord. Die is veel bruikbaarder
      // dan alleen een statuscode, dus laten we hem zien.
      let reden = '';
      try {
        const j = await r.json();
        if (j && j.error && j.error.message) reden = j.error.message;
      } catch (e) { /* geen json terug */ }

      uit.stand = 'fout';
      if (/workspace/i.test(reden)) {
        // Deze fout komt vaak voor en de oplossing is niet vanzelfsprekend.
        uit.melding = 'Deze sleutel hangt aan de organisatie, niet aan een werkruimte. '
          + 'Maak in console.anthropic.com een sleutel aan binnen een werkruimte, '
          + 'of zet ANTHROPIC_WORKSPACE_ID in Coolify met het ID van de werkruimte.';
      } else {
        uit.melding = r.status === 401
          ? `De sleutel wordt geweigerd${reden ? `: ${reden}` : '. Controleer of hij volledig is gekopieerd.'}`
          : `Anthropic antwoordde met ${r.status}${reden ? `: ${reden}` : '.'}`;
      }
      return uit;
    }

    const d = await r.json();
    const namen = (d.data || []).map((m) => m.id);
    uit.beschikbaar = namen;

    if (!namen.includes(model)) {
      uit.stand = 'let op';
      uit.melding = `De sleutel werkt, maar het ingestelde model "${model}" staat niet in de lijst. `
        + `Zet AI_MODEL op een van de beschikbare modellen.`;
      return uit;
    }

    uit.stand = 'goed';
    uit.melding = `De sleutel werkt en model ${model} is beschikbaar.`;
    return uit;
  } catch (e) {
    uit.stand = 'fout';
    uit.melding = e.name === 'AbortError'
      ? 'Geen antwoord binnen acht seconden.'
      : `Kon Anthropic niet bereiken: ${e.message}`;
    return uit;
  }
}

// ── KvK ────────────────────────────────────────────────────────────────
async function testKvk() {
  const sleutel = (process.env.KVK_API_KEY || '').trim();
  const basis = process.env.KVK_API_URL || 'https://api.kvk.nl/api/v1';
  // Ons eigen KvK-nummer: een echte opvraging, en wij weten wat eruit moet komen.
  const proefnummer = process.env.KVK_PROEFNUMMER || '76164144';
  const uit = { naam: 'KvK opzoeken', instelling: 'KVK_API_KEY',
    ingesteld: !!sleutel, sleutel: sleutelHint(sleutel), model: basis };

  if (!sleutel) {
    uit.stand = 'uit';
    uit.melding = 'Niet ingesteld. Dit is optioneel en kost \u20ac 6,40 per maand plus '
      + '\u20ac 0,02 per opvraging. Opzoeken op btw-nummer via VIES is gratis en werkt al.';
    return uit;
  }

  try {
    const r = await metTijdslimiet((signal) => fetch(`${basis}/basisprofielen/${proefnummer}`, {
      headers: { apikey: sleutel, Accept: 'application/json' }, signal,
    }), 8000);

    if (r.status === 401 || r.status === 403) {
      uit.stand = 'fout';
      uit.melding = 'De KvK weigert onze sleutel. Controleer KVK_API_KEY, en of het abonnement loopt.';
      return uit;
    }
    if (r.status === 404) {
      uit.stand = 'let op';
      uit.melding = `De sleutel werkt, maar op proefnummer ${proefnummer} is niets gevonden.`;
      return uit;
    }
    if (!r.ok) {
      uit.stand = 'fout';
      uit.melding = `De KvK antwoordde met ${r.status}.`;
      return uit;
    }

    const d = await r.json();
    const hoofd = (d._embedded && d._embedded.hoofdvestiging) || {};
    const adressen = hoofd.adressen || [];
    uit.stand = 'goed';
    uit.melding = `De sleutel werkt. Proefopvraging ${proefnummer} gaf: `
      + `${d.statutaireNaam || d.naam || 'geen naam'}`
      + (adressen.length ? `, ${adressen.length} adres(sen).` : ', maar geen adressen.');
    return uit;
  } catch (e) {
    uit.stand = 'fout';
    uit.melding = e.name === 'AbortError'
      ? 'Geen antwoord binnen acht seconden.'
      : `Kon de KvK niet bereiken: ${e.message}`;
    return uit;
  }
}

// ── PDOK ───────────────────────────────────────────────────────────────
async function testPdok() {
  const basis = process.env.PDOK_URL || 'https://api.pdok.nl/bzk/locatieserver/search/v3_1';
  const uit = { naam: 'Adres nakijken (PDOK)', instelling: 'geen sleutel nodig',
    ingesteld: true, sleutel: null, model: basis };
  try {
    const r = await metTijdslimiet((signal) => fetch(
      `${basis}/free?q=${encodeURIComponent('Weena 100 Rotterdam')}&fq=type:adres&rows=1`,
      { headers: { Accept: 'application/json' }, signal }
    ), 8000);
    if (!r.ok) {
      uit.stand = 'fout';
      uit.melding = `PDOK antwoordde met ${r.status}.`;
      return uit;
    }
    const d = await r.json();
    const n = ((d.response && d.response.docs) || []).length;
    uit.stand = n ? 'goed' : 'let op';
    uit.melding = n ? 'Werkt. Proefzoekopdracht gaf een adres terug.'
                    : 'Bereikbaar, maar de proefzoekopdracht gaf niets terug.';
    return uit;
  } catch (e) {
    uit.stand = 'fout';
    uit.melding = e.name === 'AbortError'
      ? 'Geen antwoord binnen acht seconden.'
      : `Kon PDOK niet bereiken: ${e.message}`;
    return uit;
  }
}

// ── VIES ───────────────────────────────────────────────────────────────
async function testVies() {
  const basis = process.env.VIES_URL || 'https://ec.europa.eu/taxation_customs/vies/rest-api';
  const uit = { naam: 'Bedrijfsgegevens via btw-nummer (VIES)', instelling: 'geen sleutel nodig',
    ingesteld: true, sleutel: null, model: basis };
  try {
    // De statusdienst zegt of de landen bereikbaar zijn; dat kost niets en
    // vraagt geen echt btw-nummer op.
    const r = await metTijdslimiet((signal) => fetch(`${basis}/check-status`, {
      headers: { Accept: 'application/json' }, signal,
    }), 8000);
    if (!r.ok) {
      uit.stand = 'fout';
      uit.melding = `VIES antwoordde met ${r.status}.`;
      return uit;
    }
    const d = await r.json();
    const landen = (d.countries || []);
    const nl = landen.find((c) => c.countryCode === 'NL');
    uit.stand = !nl ? 'let op' : (nl.availability === 'Available' ? 'goed' : 'let op');
    uit.melding = !nl
      ? 'Bereikbaar, maar Nederland staat niet in de statuslijst.'
      : nl.availability === 'Available'
        ? 'Werkt. De Nederlandse belastingdienst is bereikbaar via VIES. Gratis, geen sleutel nodig.'
        : `De Nederlandse dienst meldt: ${nl.availability}. Probeer het later opnieuw.`;
    return uit;
  } catch (e) {
    uit.stand = 'fout';
    uit.melding = e.name === 'AbortError'
      ? 'Geen antwoord binnen acht seconden.'
      : `Kon VIES niet bereiken: ${e.message}`;
    return uit;
  }
}

// ── e-mail versturen ───────────────────────────────────────────────────
async function testMail() {
  const mail = require('../lib/mail');
  const weg = mail.wegNaarBuiten();
  const uit = {
    naam: 'E-mail versturen',
    instelling: weg === 'smtp' ? 'MAIL_GEBRUIKER + MAIL_WACHTWOORD' : 'RESEND_API_KEY',
    ingesteld: !!weg,
    sleutel: null,
    model: mail.AFZENDER,
  };

  if (!weg) {
    uit.stand = 'uit';
    uit.melding = 'Nog niet ingericht. Verzendingen worden vastgelegd in het logboek en de '
      + 'correspondentie, maar er gaat nog geen e-mail de deur uit. '
      + 'Zet MAIL_GEBRUIKER en MAIL_WACHTWOORD in Coolify.';
    return uit;
  }

  if (weg === 'resend') {
    uit.melding = 'Verstuurt via Resend. Verzonden post staat dan niet in een mailbox; '
      + 'via Google Workspace zou dat wel zo zijn.';
    uit.stand = 'let op';
    return uit;
  }

  // Bij SMTP echt verbinden en inloggen \u2014 dat is de enige manier om te
  // weten of het app-wachtwoord klopt.
  try {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({
      host: mail.SMTP_HOST,
      port: mail.SMTP_POORT,
      secure: mail.SMTP_POORT === 465,
      auth: { user: mail.SMTP_GEBRUIKER, pass: (process.env.MAIL_WACHTWOORD || '').replace(/\s+/g, '') },
      connectionTimeout: 8000,
      greetingTimeout: 8000,
    });
    await t.verify();
    t.close();
    uit.stand = 'goed';
    uit.melding = `Ingelogd op ${mail.SMTP_HOST} als ${mail.SMTP_GEBRUIKER}. `
      + 'Verzonden post komt in die mailbox te staan.';
  } catch (e) {
    uit.stand = 'fout';
    uit.melding = /invalid login|username and password/i.test(e.message)
      ? 'Inloggen mislukt. Gebruik een app-wachtwoord van Google, niet het gewone wachtwoord; '
        + 'daarvoor moet tweestapsverificatie aanstaan op dat account.'
      : `Kon niet inloggen op de mailserver: ${e.message}`;
  }
  return uit;
}

// ── postvak ────────────────────────────────────────────────────────────
async function testPostvak() {
  const postvak = require('../lib/postvak');
  const uit = {
    naam: 'Postvak (binnenkomende post)',
    instelling: 'MAIL_GEBRUIKER + MAIL_WACHTWOORD',
    ingesteld: postvak.ingesteld(),
    sleutel: null,
    model: postvak.ingesteld() ? `${postvak.HOST} \u00b7 ${postvak.MAP}` : null,
  };

  if (!postvak.ingesteld()) {
    uit.stand = 'uit';
    uit.melding = 'Geen mailbox gekoppeld. Zonder dit blijft het postvak leeg.';
    return uit;
  }

  try {
    const { ImapFlow } = require('imapflow');
    const client = new ImapFlow({
      host: postvak.HOST, port: 993, secure: true,
      auth: { user: postvak.GEBRUIKER, pass: (process.env.MAIL_WACHTWOORD || '').replace(/\s+/g, '') },
      logger: false,
    });
    await client.connect();
    const slot = await client.getMailboxLock(postvak.MAP);
    const aantal = client.mailbox && client.mailbox.exists;
    slot.release();
    await client.logout();

    uit.stand = 'goed';
    uit.melding = `Verbonden met ${postvak.MAP} van ${postvak.GEBRUIKER}`
      + (aantal ? ` \u2014 ${aantal} berichten in de map.` : '.');
  } catch (e) {
    uit.stand = 'fout';
    uit.melding = /invalid credentials|authentication/i.test(e.message)
      ? 'Inloggen mislukt. Controleer het app-wachtwoord, en of IMAP aanstaat in Gmail '
        + '(Instellingen \u2192 Doorsturen en POP/IMAP).'
      : `Kon de mailbox niet openen: ${e.message}`;
  }
  return uit;
}

const KLEUR = { goed: ['#12704A', '#E6F4EC'], 'let op': ['#8A5A0B', '#FDF3E0'],
  fout: ['#B3261E', '#FBE9E9'], uit: ['#5B6675', '#F1F3F6'] };

function escH(v) {
  return String(v == null ? '' : v).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

router.get('/zelftest', requireDirectie, async (req, res) => {
  const uitslag = [
    await testAnthropic(),
    await testVies(),
    await testKvk(),
    await testPdok(),
    await testMail(),
    await testPostvak(),
  ];

  if (String(req.query.formaat || '') === 'json' || /application\/json/.test(req.headers.accept || '')) {
    return res.json({ uitslag });
  }

  const rijen = uitslag.map((u) => {
    const [tekst, vlak] = KLEUR[u.stand] || KLEUR.uit;
    return `<div class="kaart">
      <div class="kop">
        <b>${escH(u.naam)}</b>
        <span class="pil" style="color:${tekst};background:${vlak}">${escH(u.stand)}</span>
      </div>
      <div class="rij"><span>Instelling</span><code>${escH(u.instelling)}</code></div>
      ${u.sleutel ? `<div class="rij"><span>Sleutel</span>${escH(u.sleutel)}</div>` : ''}
      ${u.model ? `<div class="rij"><span>${
        u.naam.indexOf('Anthropic') > -1 ? 'Model'
        : u.naam.indexOf('versturen') > -1 ? 'Afzender'
        : u.naam.indexOf('Postvak') > -1 ? 'Mailbox' : 'Adres'
      }</span><code>${escH(u.model)}</code></div>` : ''}
      ${u.werkruimte ? `<div class="rij"><span>Werkruimte</span><code>${escH(u.werkruimte)}</code></div>` : ''}
      <div class="melding">${escH(u.melding)}</div>
      ${u.domeinen ? `<details><summary>Domeinen in Resend (${u.domeinen.length})</summary>
        <div class="lijst">${u.domeinen.map((m) => `<code>${escH(m)}</code>`).join(' ')}</div></details>` : ''}
      ${u.beschikbaar ? `<details><summary>Beschikbare modellen (${u.beschikbaar.length})</summary>
        <div class="lijst">${u.beschikbaar.map((m) => `<code>${escH(m)}</code>`).join(' ')}</div></details>` : ''}
    </div>`;
  }).join('');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zelftest koppelingen — Forward</title>
<style>
  body{margin:0;padding:28px 20px;background:#F6F8FA;color:#101828;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.55}
  .vel{max-width:720px;margin:0 auto}
  h1{font-size:21px;margin:0 0 4px}
  .sub{color:#5B6675;font-size:13px;margin:0 0 22px}
  .kaart{background:#fff;border:1px solid #E4E9EF;border-radius:14px;padding:16px 18px;margin-bottom:12px}
  .kop{display:flex;align-items:center;gap:10px;margin-bottom:10px}
  .kop b{font-size:15px}
  .pil{margin-left:auto;font-size:11.5px;font-weight:600;border-radius:20px;padding:4px 11px;text-transform:uppercase;letter-spacing:.03em}
  .rij{display:flex;gap:10px;font-size:12.5px;color:#5B6675;padding:3px 0}
  .rij span{min-width:88px}
  code{background:#F1F3F6;border-radius:5px;padding:1px 6px;font-size:12px}
  .melding{margin-top:9px;font-size:13px}
  details{margin-top:9px}
  summary{font-size:12.5px;color:#0E7C86;cursor:pointer}
  .lijst{margin-top:7px;display:flex;flex-wrap:wrap;gap:5px}
  .voet{color:#8A94A6;font-size:12px;margin-top:18px}
</style></head><body><div class="vel">
  <h1>Zelftest koppelingen</h1>
  <p class="sub">Ververs deze pagina nadat je een sleutel in Coolify hebt gezet en opnieuw hebt uitgerold.</p>
  ${rijen}
  <p class="voet">Sleutels worden nooit volledig getoond. Deze pagina is alleen voor directie.</p>
</div></body></html>`);
});

module.exports = router;
