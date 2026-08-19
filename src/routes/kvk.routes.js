const express = require('express');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();
router.use(requireAuth);

/* ─────────── KvK-nummer opzoeken ───────────
   De KvK biedt de Basisprofiel-API aan. Die vraagt om een abonnement en een
   sleutel; die zet je in Coolify als KVK_API_KEY. Zonder sleutel zegt deze
   route dat eerlijk, zodat je niet denkt dat het zoeken mislukt is terwijl er
   simpelweg nog niets is ingesteld. */

const KVK_URL = process.env.KVK_API_URL
  || 'https://api.kvk.nl/api/v1/basisprofielen';

// Acht cijfers, eventueel met streepjes of spaties ertussen.
function schoonNummer(v) {
  return String(v || '').replace(/[^0-9]/g, '');
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
    const r = await fetch(`${KVK_URL}/${nummer}`, {
      headers: { apikey: sleutel, Accept: 'application/json' },
    });

    if (r.status === 404) {
      return res.status(404).json({ error: `Geen bedrijf gevonden op KvK-nummer ${nummer}.` });
    }
    if (!r.ok) {
      return res.status(502).json({ error: `De KvK antwoordde met ${r.status}. Probeer het later nog eens.` });
    }

    const d = await r.json();

    // Van alle adressen pakken we het bezoekadres en het postadres apart.
    const adressen = Array.isArray(d.adressen) ? d.adressen : [];
    const bezoek = adressen.find((a) => /bezoek/i.test(a.type || '')) || adressen[0] || {};
    const post = adressen.find((a) => /post|correspond/i.test(a.type || '')) || {};

    function straat(a) {
      return [a.straatnaam, a.huisnummer, a.huisnummerToevoeging].filter(Boolean).join(' ').trim() || null;
    }

    res.json({
      gevonden: true,
      naam: d.statutaireNaam || d.naam || null,
      kvk: d.kvkNummer || nummer,
      adres: straat(bezoek),
      postcode: bezoek.postcode || null,
      plaats: bezoek.plaats || null,
      postAdres: straat(post),
      postPostcode: post.postcode || null,
      postPlaats: post.plaats || null,
      website: Array.isArray(d.websites) && d.websites.length ? d.websites[0] : null,
    });
  } catch (e) {
    res.status(502).json({ error: `Kon de KvK niet bereiken: ${e.message}` });
  }
});

module.exports = router;
