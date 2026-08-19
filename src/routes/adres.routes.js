const express = require('express');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();
router.use(requireAuth);

/* ─────────── adressen nakijken bij PDOK ───────────
   De locatieserver van PDOK draait op het BAG, de officiële registratie van
   alle Nederlandse adressen. Gratis, geen sleutel nodig. Wij vragen het aan de
   serverkant, zodat de browser er niet zelf langs hoeft en wij het antwoord in
   één vorm teruggeven.

   Twee manieren:
     /api/adres?postcode=3012CM&huisnummer=100   \u2014 het zekerst
     /api/adres?q=Weena 100 Rotterdam            \u2014 als de postcode ontbreekt   */

const PDOK = process.env.PDOK_URL
  || 'https://api.pdok.nl/bzk/locatieserver/search/v3_1';

const schoonPc = (v) => String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const schoonNr = (v) => String(v || '').trim();
// Voor het vergelijken: 147-3, 147 3 en 1473 zijn hetzelfde huisnummer.
const kaalNr = (v) => String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

/* Het huisnummer in elkaar zetten. Nederland kent twee soorten toevoegingen
   en die schrijf je verschillend:
     huisletter            plakt vast aan het nummer      12 + A   -> 12A
     huisnummertoevoeging  komt achter een streepje       147 + 3  -> 147-3
   Alles aan elkaar plakken maakt van 147-3 een 1473, en dat is een ander pand. */
function bouwNummer(doc) {
  const nr = doc.huisnummer === undefined || doc.huisnummer === null ? '' : String(doc.huisnummer).trim();
  const letter = String(doc.huisletter || '').trim();
  const toev = String(doc.huisnummertoevoeging || '').trim();
  return (nr + letter + (toev ? `-${toev}` : '')).trim();
}

// PDOK levert 'Weena 100, 3012CM Rotterdam' als één regel plus losse velden.
function uitPdok(doc) {
  if (!doc) return null;
  const straat = doc.straatnaam || '';
  const nummer = bouwNummer(doc);
  // De weergavenaam is PDOK's eigen schrijfwijze; die is leidend als hij er is.
  const uitNaam = String(doc.weergavenaam || '').split(',')[0].trim();
  const postcode = doc.postcode
    ? `${String(doc.postcode).slice(0, 4)} ${String(doc.postcode).slice(4)}`.trim()
    : null;
  return {
    gevonden: true,
    adres: uitNaam || [straat, nummer].filter(Boolean).join(' ').trim() || null,
    straat: straat || null,
    huisnummer: nummer || null,
    postcode,
    plaats: doc.woonplaatsnaam || null,
    gemeente: doc.gemeentenaam || null,
    provincie: doc.provincienaam || null,
    volledig: doc.weergavenaam || null,
    // Een verblijfsobject is een echt adres; een 'weg' of 'postcode' niet.
    soort: doc.type || null,
  };
}

async function zoek(vraag, aantal) {
  const url = `${PDOK}/free?q=${encodeURIComponent(vraag)}`
    + `&fq=type:adres&rows=${aantal}&fl=id,weergavenaam,straatnaam,huisnummer,huisletter,`
    + 'huisnummertoevoeging,postcode,woonplaatsnaam,gemeentenaam,provincienaam,type';
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`PDOK antwoordde met ${r.status}`);
  const d = await r.json();
  return ((d.response && d.response.docs) || []).map(uitPdok).filter(Boolean);
}

router.get('/adres', async (req, res) => {
  const pc = schoonPc(req.query.postcode);
  const nr = schoonNr(req.query.huisnummer);
  const q = String(req.query.q || '').trim();

  if (!q && !(pc && nr)) {
    return res.status(400).json({
      error: 'Geef een postcode met huisnummer, of een zoekterm.',
    });
  }

  // Postcode plus huisnummer is eenduidig; een zoekterm kan meer opleveren.
  const vraag = pc && nr ? `${pc} ${nr}` : q;

  try {
    const gevonden = await zoek(vraag, pc && nr ? 5 : 8);

    if (!gevonden.length) {
      return res.json({
        gevonden: false,
        boodschap: pc && nr
          ? `Geen adres gevonden op ${pc.slice(0, 4)} ${pc.slice(4)} ${nr}. Klopt het huisnummer?`
          : `Geen adres gevonden voor "${q}".`,
      });
    }

    // Bij postcode plus huisnummer nemen we de treffer die exact past; een
    // huisnummer 12 mag niet stiekem 12A worden.
    let beste = gevonden[0];
    if (pc && nr) {
      const exact = gevonden.find(
        (a) => schoonPc(a.postcode) === pc && kaalNr(a.huisnummer) === kaalNr(nr)
      );
      if (exact) beste = exact;
      // Geen exacte treffer, maar wel iets op dezelfde postcode: dan is het
      // huisnummer waarschijnlijk verkeerd. Dat zeggen we liever dan dat we
      // stilzwijgend het verkeerde pand invullen.
      else if (gevonden.length) {
        return res.json({
          gevonden: false,
          boodschap: `Huisnummer ${nr} bestaat niet op ${pc.slice(0, 4)} ${pc.slice(4)}. `
                   + `Bedoelde je ${gevonden.map((a) => a.huisnummer).filter(Boolean).slice(0, 4).join(', ')}?`,
          alternatieven: gevonden.slice(0, 5),
        });
      }
    }

    res.json({ gevonden: true, adres: beste, alternatieven: gevonden.slice(0, 5) });
  } catch (e) {
    // Ligt PDOK eruit, dan mag dat het werk niet blokkeren.
    res.status(502).json({
      gevonden: false,
      error: `Kon het adres nu niet nakijken (${e.message}). Je kunt gewoon doorgaan.`,
    });
  }
});

module.exports = router;
