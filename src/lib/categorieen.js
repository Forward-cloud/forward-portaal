/* ─────────── categorieën leveranciers ───────────
   Waarvoor je een partij inschakelt. Deze lijst bepaalt welke namen je te zien
   krijgt bij een opdrachtbon of prijsaanvraag, en staat daarom op één plek:
   het portaal en de opdrachtbonnen lezen allebei hieruit.

   Staat er iets niet bij, dan kun je in het portaal zelf een categorie
   toevoegen. Die wordt bewaard bij de relatie en verschijnt daarna vanzelf in
   de lijst — zie vrijeCategorieen(). */

const CATEGORIEEN = {
  loodgieter: 'Loodgieter',
  tegelzetter: 'Tegelzetter',
  stukadoor: 'Stukadoor',
  schilder: 'Schilder',
  dakwerk: 'Dakwerk',
  vloeren: 'Vloeren',
  elektra: 'Elektra',
  inspectie: 'Bouwkundige inspectie',
  keuken: 'Keukenleverancier of monteur',
  timmerman: 'Timmerman',
  sloper: 'Sloper',
  // Deze drie horen bij waterschade en zaten al in bestaande opdrachtbonnen.
  droging: 'Drogen en meten',
  schoonmaak: 'Schoonmaak',
  overig: 'Overig',
};

// Wat vroeger anders heette. Zo blijven oude bonnen en relaties werken.
const OUDE_NAMEN = {
  stuc: 'stukadoor',
  tegel: 'tegelzetter',
  dak: 'dakwerk',
  vloer: 'vloeren',
  timmer: 'timmerman',
};

// Een eigen categorie wordt een korte sleutel: 'Glaszetter' -> 'glaszetter'.
function sleutel(v) {
  return String(v || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

// Onbekende sleutels laten we staan; alleen de oude namen zetten we om.
function normaliseer(v) {
  const s = sleutel(v);
  return OUDE_NAMEN[s] || s;
}

function label(v) {
  const s = normaliseer(v);
  if (CATEGORIEEN[s]) return CATEGORIEEN[s];
  // Een zelf toegevoegde categorie: eerste letter groot, streepjes naar spaties.
  const t = s.replace(/-/g, ' ');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

function geldig(v) {
  return /^[a-z0-9-]{2,32}$/.test(normaliseer(v));
}

module.exports = { CATEGORIEEN, OUDE_NAMEN, sleutel, normaliseer, label, geldig };
