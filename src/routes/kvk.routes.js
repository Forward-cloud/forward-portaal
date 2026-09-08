const express = require('express');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();
router.use(requireAuth);

/* ─────────── KvK-nummer opzoeken ───────────
   Basisprofiel API van de Kamer van Koophandel, versie 1.
   Endpoint : https://api.kvk.nl/api/v1/basisprofielen/{kvkNummer}
   Sleutel  : in de header 'apikey', te zetten als KVK_API_KEY in Coolify.

   Let op bij het antwoord: het basisprofiel zelf bevat alleen de naam en de
   activiteiten. Adressen en websites zitten een niveau dieper, in _embedded,
   bij de hoofdvestiging of bij de eigenaar. Dat is precies waar het eerder
   misging — wij lazen ze op het hoofdniveau, waar ze niet staan. */

const KVK_URL = process.env.KVK_API_URL || 'https://api.kvk.nl/api/v1';

const schoonNummer = (v) => String(v || '').replace(/[^0-9]/g, '');

// Huisletter plakt vast aan het nummer, een toevoeging komt achter een streepje.
function bouwStraat(a) {
  if (!a) return null;
  if (a.straatHuisnummer) return String(a.straatHuisnummer).trim();
  const nr = a.huisnummer === undefined || a.huisnummer === null ? '' : String(a.huisnummer);
  const letter = String(a.huisletter || '').trim();
  const toev = String(a.huisnummerToevoeging || '').trim();
  const nummer = nr + letter + (toev ? `-${toev}` : '');
  return [a.straatnaam, nummer].filter(Boolean).join(' ').trim() || null;
}

function nettePostcode(v) {
  const p = String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return p.length === 6 ? `${p.slice(0, 4)} ${p.slice(4)}` : (v || null);
}

// Bezoekadres en correspondentieadres uit de lijst vissen.
function kiesAdressen(lijst) {
  const a = Array.isArray(lijst) ? lijst : [];
  const zichtbaar = a.filter((x) => String(x.indAfgeschermd || '').toLowerCase() !== 'ja');
  const bezoek = zichtbaar.find((x) => /bezoek/i.test(x.type || '')) || zichtbaar[0] || null;
  const post = zichtbaar.find((x) => /correspond|post/i.test(x.type || '')) || null;
  return { bezoek, post };
}

// De foutmelding van de KvK is bruikbaarder dan alleen een statuscode.
async function kvkFout(res, standaard) {
  try {
    const j = await res.json();
    const f = j && Array.isArray(j.fout) ? j.fout[0] : null;
    if (f && f.omschrijving) return f.omschrijving;
  } catch (e) { /* geen json terug; laat de standaardtekst staan */ }
  return standaard;
}

router.get('/kvk/:nummer', async (req, res) => {
  const nummer = schoonNummer(req.params.nummer);
  if (nummer.length !== 8) {
    return res.status(400).json({ error: 'Een KvK-nummer bestaat uit acht cijfers.' });
  }

  const sleutel = process.env.KVK_API_KEY;
  if (!sleutel) {
    return res.status(503).json({
      error: 'Opzoeken bij de KvK staat nog niet aan. Zet KVK_API_KEY in Coolify; '
           + 'tot die tijd vul je de gegevens met de hand in.',
      instelling: 'KVK_API_KEY',
    });
  }

  try {
    const r = await fetch(`${KVK_URL}/basisprofielen/${nummer}`, {
      headers: { apikey: sleutel, Accept: 'application/json' },
    });

    if (r.status === 401 || r.status === 403) {
      return res.status(502).json({
        error: await kvkFout(r, 'De KvK weigert onze sleutel. Controleer KVK_API_KEY in Coolify.'),
      });
    }
    if (r.status === 404) {
      return res.status(404).json({ error: `Geen bedrijf gevonden op KvK-nummer ${nummer}.` });
    }
    if (!r.ok) {
      return res.status(502).json({
        error: await kvkFout(r, `De KvK antwoordde met ${r.status}. Probeer het later nog eens.`),
      });
    }

    const d = await r.json();

    // Adressen en websites staan bij de hoofdvestiging; is die er niet, dan
    // vallen we terug op de eigenaar.
    const emb = d._embedded || {};
    const hoofd = emb.hoofdvestiging || {};
    const eig = emb.eigenaar || {};
    const { bezoek, post } = kiesAdressen(
      (hoofd.adressen && hoofd.adressen.length ? hoofd.adressen : eig.adressen) || []
    );
    const sites = (hoofd.websites && hoofd.websites.length ? hoofd.websites : eig.websites) || [];

    // De statutaire naam is het netst; anders de maatschappelijke activiteit,
    // en anders de eerste handelsnaam.
    const naam = d.statutaireNaam || d.naam || hoofd.eersteHandelsnaam
      || (Array.isArray(d.handelsnamen) && d.handelsnamen.length ? d.handelsnamen[0].naam : null);

    res.json({
      gevonden: true,
      naam: naam || null,
      kvk: d.kvkNummer || nummer,
      rechtsvorm: eig.uitgebreideRechtsvorm || eig.rechtsvorm || null,

      adres: bouwStraat(bezoek),
      postcode: bezoek ? nettePostcode(bezoek.postcode) : null,
      plaats: bezoek ? bezoek.plaats || null : null,

      postAdres: bouwStraat(post),
      postPostcode: post ? nettePostcode(post.postcode) : null,
      postPlaats: post ? post.plaats || null : null,

      website: sites.length ? sites[0] : null,
      volledigAdres: (bezoek && bezoek.volledigAdres) || null,
      uitgeschreven: !!eig.datumUitschrijving,
    });
  } catch (e) {
    res.status(502).json({ error: `Kon de KvK niet bereiken: ${e.message}` });
  }
});

module.exports = router;
