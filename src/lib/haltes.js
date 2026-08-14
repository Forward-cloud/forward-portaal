// Haltes, presets en het afleiden van de voortgang uit de schadekaart.

// Versiestempel — het portaal toont dit, zodat je ziet of frontend en server bij elkaar horen.
const VERSIE = 'haltes-6-schema';

const HALTES = [
  'Schademelding ontvangen',           // 1
  'Schade-opname ingepland',           // 2
  'Bronherstel',                       // 3
  'Schaderapport opgesteld',           // 4
  'Dossier ingediend bij verzekeraar', // 5
  'Akkoord verzekeraar',               // 6
  'Herstel ingepland',                 // 7
  'Herstel in uitvoering',             // 8
  'Opgeleverd',                        // 9
  'Uitgefactureerd',                   // 10
];

// Haltes 1, 2 en 10 gelden altijd; de rest is per dossier instelbaar.
const VAST = [1, 2, 10];

// Halte 3 (bron) staat standaard aan, maar mag uit — bij stormschade is er geen bron.
const BRON = 3;

const PRESETS = {
  volledig:   { label: 'Volledig',                   haltes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
  expertise:  { label: 'Alleen expertise',           haltes: [1, 2, 3, 4, 10] },
  er_rapport: { label: 'Eigen risico · met rapport', haltes: [1, 2, 3, 4, 7, 8, 9, 10] },
  // Bij eigen risico met offerte betaalt de klant zelf. Halte 5 en 6 zijn dan
  // 'offerte verstuurd' en 'offerte akkoord' -- zelfde plek in de reis, andere naam.
  er_offerte: { label: 'Eigen risico · offerte',     haltes: [1, 2, 3, 5, 6, 7, 8, 9, 10] },
  er_mandaat: { label: 'Eigen risico · mandaat',     haltes: [1, 2, 3, 8, 9, 10] },
};

// Wie de rekening betaalt bepaalt hoe halte 5 en 6 heten.
const HALTES_EIGEN_RISICO = { 5: 'Offerte verstuurd', 6: 'Offerte akkoord' };
const isEigenRisico = (preset) => String(preset || '').indexOf('er_') === 0;

function halteNaam(n, preset) {
  const i = Number(n);
  if (isEigenRisico(preset) && HALTES_EIGEN_RISICO[i]) return HALTES_EIGEN_RISICO[i];
  return HALTES[i - 1] || '';
}

function halteNamen(preset) {
  return HALTES.map((_, i) => halteNaam(i + 1, preset));
}

// Bronstatus
const BRON_STATUS = {
  nvt:         'Niet van toepassing',
  open:        'Nog niet hersteld',
  hersteld:    'Hersteld',
  onvoldoende: 'Onvoldoende hersteld',
};

function haltesVoorPreset(preset) {
  const p = PRESETS[preset] || PRESETS.volledig;
  return p.haltes.slice();
}

function normaliseerHaltes(lijst) {
  const set = new Set(
    (Array.isArray(lijst) ? lijst : [])
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= HALTES.length)
  );
  VAST.forEach((n) => set.add(n));
  return Array.from(set).sort((a, b) => a - b);
}

function volgendeHalte(step, haltes) {
  const actief = normaliseerHaltes(haltes);
  return actief.find((h) => h > Number(step || 0)) || null;
}

function isAfgerond(step, haltes) {
  const actief = normaliseerHaltes(haltes);
  return Number(step || 0) >= actief[actief.length - 1];
}

function positie(step, haltes) {
  const actief = normaliseerHaltes(haltes);
  const i = actief.indexOf(Number(step));
  return { positie: i < 0 ? 1 : i + 1, totaal: actief.length };
}

const jaTekst = (v) => {
  if (v === true) return true;
  const t = String(v == null ? '' : v).trim().toLowerCase();
  return t === 'ja' || t === 'j' || t === 'yes' || t === 'x' || t === 'true';
};

// 'Nee', '-', 'n.v.t.' en 'geen' zijn ingevulde cellen zonder inhoud.
const LEEG = ['', '-', '--', 'nee', 'n', 'geen', 'nvt', 'n.v.t.', 'n.v.t', 'nb', 'x'];
const heeftEchteWaarde = (v) => {
  if (v == null) return false;
  return LEEG.indexOf(String(v).trim().toLowerCase()) === -1;
};

/**
 * Mag dit dossier voorbij de bron?
 *
 * Een lekkende bron houdt het schaderapport tegen (halte 4). Slaat de route halte 4
 * over -- eigen risico met offerte of mandaat -- dan houdt hij het inplannen van het
 * herstel tegen (halte 7), want stucwerk boven een lek is weggegooid geld.
 *
 * Bij 'onvoldoende' mag het wel door, maar alleen met een vastgelegde reden.
 */
function bronBlokkeert(schade, doelStep) {
  const haltes = normaliseerHaltes(schade.haltes);
  if (!haltes.includes(BRON)) return null;
  if (schade.bronStatus !== 'onvoldoende' && schade.bronStatus !== 'open') return null;
  if (schade.bronDoorReden && String(schade.bronDoorReden).trim()) return null;

  const grens = haltes.includes(4) ? 4 : 7;
  if (Number(doelStep) < grens) return null;

  const wat = schade.bronStatus === 'open' ? 'nog niet hersteld' : 'onvoldoende hersteld';
  return grens === 4
    ? `De bron is ${wat}. Het schaderapport kan pas als dat is opgelost.`
    : `De bron is ${wat}. Herstel inplannen kan pas als dat is opgelost.`;
}

/**
 * Vanaf welke dag telt de termijnbewaking?
 * De laatste van drie momenten: indienen, de laatste herinnering, of onze eigen
 * aanlevering. Vroeg de verzekeraar om informatie, dan staat de teller stil --
 * de bal ligt dan bij ons.
 */
function tellerVanaf(schade) {
  const punten = [schade.verzIngediendAt, schade.herinnerLaatstAt, schade.infoVerstuurdAt]
    .filter(Boolean)
    .map((d) => new Date(d).getTime());
  return punten.length ? new Date(Math.max(...punten)) : null;
}

function tellerLoopt(schade) {
  return schade.verzStatus === 'ingediend' && !!tellerVanaf(schade);
}

function dagenOpen(schade) {
  const vanaf = tellerVanaf(schade);
  if (!vanaf) return 0;
  return Math.floor((Date.now() - vanaf.getTime()) / 86400000);
}

function termijnOver(schade) {
  if (!tellerLoopt(schade)) return false;
  return dagenOpen(schade) >= Number(schade.herinnerDagen || 7);
}

/**
 * Leidt preset, actieve haltes en bereikte halte af uit één regel van de schadekaart.
 */
function leidAfUitKaart(r) {
  const opname       = jaTekst(r.opname);
  const bronOk       = jaTekst(r.bron);
  const bronInvuld   = r.bron != null && String(r.bron).trim() !== '';
  const rapport      = jaTekst(r.rapport);
  const offerte      = jaTekst(r.offerte);
  const ingediend    = jaTekst(r.ingediend);
  const uitkering    = jaTekst(r.uitkering);
  const hersteld     = jaTekst(r.hersteld);
  const gefactureerd = jaTekst(r.gefactureerd);
  const datumUitv    = heeftEchteWaarde(r.uitvoeringAt);
  const heeftVerz    = heeftEchteWaarde(r.ins);

  let preset;
  if (heeftVerz || ingediend || uitkering) {
    preset = 'volledig';
  } else if (rapport) {
    preset = 'er_rapport';
  } else if (offerte) {
    preset = 'er_offerte';
  } else {
    preset = 'er_mandaat';
  }

  let haltes = haltesVoorPreset(preset);
  // Geen bron ingevuld in de kaart? Dan geldt de bron-halte niet voor dit dossier.
  if (!bronInvuld) haltes = haltes.filter((h) => h !== BRON);

  let step = 1;
  if (opname) step = 2;
  if (bronOk) step = 3;
  if (rapport) step = 4;
  if (offerte && haltes.includes(5)) step = isEigenRisico(preset) ? 6 : 5;
  if (ingediend) step = 5;
  if (uitkering) step = 6;
  if (datumUitv) step = 7;
  if (hersteld) step = 9;
  if (gefactureerd) step = 10;

  if (!haltes.includes(step)) {
    const lager = haltes.filter((h) => h < step);
    step = lager.length ? lager[lager.length - 1] : haltes[0];
  }

  let verzStatus = 'geen';
  if (uitkering) verzStatus = 'akkoord';
  else if (ingediend) verzStatus = 'ingediend';

  let bronStatus = 'nvt';
  if (bronInvuld) bronStatus = bronOk ? 'hersteld' : 'open';

  return { preset, haltes, step, verzStatus, bronStatus };
}

const VERZ_STATUS = {
  geen:       'Nog niet ingediend',
  ingediend:  'Wacht op reactie',
  informatie: 'Vraagt aanvullende informatie',
  akkoord:    'Akkoord',
  afgewezen:  'Afgewezen',
};

// Bij eigen risico gaat het niet over een claim maar over onze eigen offerte.
const OFFERTE_STATUS = {
  geen:       'Nog niet verstuurd',
  ingediend:  'Wacht op de klant',
  informatie: 'Klant heeft vragen',
  akkoord:    'Akkoord',
  afgewezen:  'Afgewezen',
};

const standen = (preset) => (isEigenRisico(preset) ? OFFERTE_STATUS : VERZ_STATUS);

// Soorten actiepunten. De tekst maakt de route zelf; dit legt alleen vast
// wat er bestaat en of de klant het mag zien.
const ACTIEPUNTEN = {
  machtiging:  { klant: true },
  bron:        { klant: true },
  herinnering: { klant: false },
  bellen:      { klant: false },
  info:        { klant: true },
  herstel:     { klant: true },
  offerte:     { klant: false },
  klant:       { klant: false },
};

module.exports = {
  VERSIE, HALTES, VERZ_STATUS, OFFERTE_STATUS, VAST, BRON, PRESETS, BRON_STATUS,
  HALTES_EIGEN_RISICO, ACTIEPUNTEN,
  haltesVoorPreset, normaliseerHaltes, volgendeHalte, isAfgerond, positie,
  halteNaam, halteNamen, isEigenRisico, standen,
  bronBlokkeert, tellerVanaf, tellerLoopt, dagenOpen, termijnOver,
  leidAfUitKaart, jaTekst, heeftEchteWaarde,
};
