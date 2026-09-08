const express = require('express');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();
router.use(requireAuth);

/* ─────────── bedrijfsgegevens via het btw-nummer ───────────
   VIES is de btw-controledienst van de Europese Commissie. Gratis, geen
   abonnement en geen sleutel. Je zoekt op btw-nummer in plaats van op
   KvK-nummer, en je krijgt de naam en het adres terug zoals de Belastingdienst
   die kent.

   Twee dingen om te weten:
   - Niet elk land geeft naam en adres vrij. Nederland doet dat wel.
   - Een geldig btw-nummer betekent dat het bedrijf btw-plichtig is. Voor een
     onderaannemer is dat precies wat je wilt weten voordat je btw verlegt.

   Het adres komt als één regel binnen, bijvoorbeeld:
     "BOVENDIJK 35 P\n2295RV KWINTSHEUL"
   Wij knippen dat in straat, postcode en plaats.                            */

const VIES_URL = process.env.VIES_URL
  || 'https://ec.europa.eu/taxation_customs/vies/rest-api';

// NL864238777B01 -> land NL, nummer 864238777B01
function splits(v) {
  const s = String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const m = /^([A-Z]{2})(.+)$/.exec(s);
  // Zonder landcode gaan we uit van Nederland.
  if (!m) return { land: 'NL', nummer: s };
  return { land: m[1] === 'EL' ? 'EL' : m[1], nummer: m[2] };
}

function nettePostcode(v) {
  const p = String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return p.length === 6 ? `${p.slice(0, 4)} ${p.slice(4)}` : null;
}

/* Het adres uit VIES is één blok tekst. Voor een Nederlands adres ziet de
   laatste regel er zo uit: "2295RV KWINTSHEUL". Alles daarvoor is de straat. */
function ontleedAdres(tekst) {
  const regels = String(tekst || '')
    .split(/\r?\n/)
    .map((r) => r.trim())
    .filter((r) => r && r !== '---');
  if (!regels.length) return { adres: null, postcode: null, plaats: null };

  const laatste = regels[regels.length - 1];
  const m = /^([0-9]{4}\s?[A-Z]{2})\s+(.+)$/.exec(laatste);
  if (m) {
    return {
      // '35 P' is bij ons '35P', zoals de KvK en het BAG het schrijven.
      adres: (regels.slice(0, -1).join(', ') || null || '')
        .replace(/(\d)\s+([A-Za-z])(?![A-Za-z])/g, '$1$2') || null,
      postcode: nettePostcode(m[1]),
      plaats: m[2].trim(),
    };
  }
  // Geen herkenbare postcode: alles als adres teruggeven, niets verzinnen.
  return { adres: regels.join(', '), postcode: null, plaats: null };
}

/* VIES schrijft alles in hoofdletters: "BS DAKWERKEN B.V." leest lelijk in een
   brief. Wij maken er gewone schrijfwijze van, maar laten korte woorden die
   helemaal uit hoofdletters bestaan met rust \u2014 dat zijn initialen of
   afkortingen: BS, VOF, B.V. */
function netteTekst(v) {
  const s = String(v || '').trim();
  if (!s || s === '---') return null;
  if (s !== s.toUpperCase()) return s;      // was al gemengd, niet aankomen

  return s.split(/(\s+)/).map((woord) => {
    if (/^\s+$/.test(woord)) return woord;
    const kaal = woord.replace(/[^A-Z0-9]/g, '');
    // Korte woorden zonder klinker, of losse letters: laten staan.
    if (kaal.length <= 3 && !/[AEIOUY]/.test(kaal)) return woord;
    if (/^\d/.test(woord)) return woord;    // huisnummers ongemoeid
    return woord.charAt(0) + woord.slice(1).toLowerCase();
  }).join('')
    .replace(/\bB\.?v\.?\b/g, 'B.V.')
    .replace(/\bN\.?v\.?\b/g, 'N.V.');
}

router.get('/btw/:nummer', async (req, res) => {
  const { land, nummer } = splits(req.params.nummer);
  if (!nummer || nummer.length < 4) {
    return res.status(400).json({ error: 'Vul een volledig btw-nummer in, bijvoorbeeld NL123456789B01.' });
  }

  try {
    const stop = new AbortController();
    const klok = setTimeout(() => stop.abort(), 10000);
    let r;
    try {
      r = await fetch(`${VIES_URL}/ms/${land}/vat/${nummer}`, {
        headers: { Accept: 'application/json' }, signal: stop.signal,
      });
    } finally { clearTimeout(klok); }

    if (!r.ok) {
      return res.status(502).json({
        error: `De btw-controle van de EU antwoordde met ${r.status}. Probeer het later nog eens.`,
      });
    }

    const d = await r.json();

    // VIES meldt fouten in het antwoord zelf, niet met een statuscode.
    if (d.userError && d.userError !== 'VALID') {
      const uitleg = {
        INVALID_INPUT: 'Dit btw-nummer heeft niet de juiste vorm.',
        MS_UNAVAILABLE: 'De belastingdienst van dit land is nu niet bereikbaar. Probeer het later.',
        MS_MAX_CONCURRENT_REQ: 'Het is nu te druk bij de belastingdienst. Probeer het over een minuut.',
        TIMEOUT: 'De belastingdienst reageerde niet op tijd.',
        SERVICE_UNAVAILABLE: 'De dienst is tijdelijk niet beschikbaar.',
      }[d.userError];
      return res.status(502).json({ error: uitleg || `De btw-controle gaf terug: ${d.userError}` });
    }

    if (!d.isValid) {
      return res.status(404).json({
        gevonden: false,
        error: `${land}${nummer} is geen geldig btw-nummer. Controleer het nummer, of het bedrijf is niet btw-plichtig.`,
      });
    }

    const adres = ontleedAdres(d.address);
    res.json({
      gevonden: true,
      geldig: true,
      btwNummer: `${land}${nummer}`,
      naam: netteTekst(d.name),
      adres: netteTekst(adres.adres),
      postcode: adres.postcode,
      plaats: netteTekst(adres.plaats),
      // Bewijs dat je op deze datum hebt gecontroleerd; handig bij btw verlegd.
      gecontroleerdOp: d.requestDate || null,
      bron: 'VIES (Europese Commissie)',
    });
  } catch (e) {
    res.status(502).json({
      error: e.name === 'AbortError'
        ? 'De btw-controle reageerde niet binnen tien seconden.'
        : `Kon de btw-controle niet bereiken: ${e.message}`,
    });
  }
});

module.exports = router;
