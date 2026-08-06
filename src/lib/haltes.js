// Haltes, presets en het afleiden van de voortgang uit de schadekaart.

const HALTES = [
  'Schademelding ontvangen',   // 1
  'Schade-opname ingepland',   // 2
  'Schaderapport opgesteld',   // 3
  'Offerte naar verzekeraar',  // 4
  'Akkoord verzekeraar',       // 5
  'Herstel ingepland',         // 6
  'Herstel in uitvoering',     // 7
  'Opgeleverd',                // 8
  'Uitgefactureerd',           // 9
];

// Haltes 1, 2 en 9 gelden altijd; alleen 3 t/m 8 zijn per dossier instelbaar.
const VAST = [1, 2, 9];

const PRESETS = {
  volledig:        { label: 'Volledig',                    haltes: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
  expertise:       { label: 'Alleen expertise',            haltes: [1, 2, 3, 9] },
  er_rapport:      { label: 'Eigen risico · met rapport',  haltes: [1, 2, 3, 6, 7, 8, 9] },
  er_offerte:      { label: 'Eigen risico · offerte',      haltes: [1, 2, 6, 7, 8, 9] },
  er_mandaat:      { label: 'Eigen risico · mandaat',      haltes: [1, 2, 7, 8, 9] },
};

function haltesVoorPreset(preset) {
  const p = PRESETS[preset] || PRESETS.volledig;
  return p.haltes.slice();
}

// Zorgt dat de vaste haltes er altijd in zitten en de lijst oplopend/uniek is.
function normaliseerHaltes(lijst) {
  const set = new Set(
    (Array.isArray(lijst) ? lijst : [])
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 9)
  );
  VAST.forEach((n) => set.add(n));
  return Array.from(set).sort((a, b) => a - b);
}

// De eerstvolgende halte die nog open staat (of null als alles gedaan is).
function volgendeHalte(step, haltes) {
  const actief = normaliseerHaltes(haltes);
  return actief.find((h) => h > Number(step || 0)) || null;
}

function isAfgerond(step, haltes) {
  const actief = normaliseerHaltes(haltes);
  return Number(step || 0) >= actief[actief.length - 1];
}

const jaTekst = (v) => {
  if (v === true) return true;
  const t = String(v == null ? '' : v).trim().toLowerCase();
  return t === 'ja' || t === 'j' || t === 'yes' || t === 'x' || t === 'true';
};

const heeftWaarde = (v) => v != null && String(v).trim() !== '';

/**
 * Leidt preset, actieve haltes en bereikte halte af uit één regel van de schadekaart.
 * Verwacht de kolommen zoals ze in "SO Dossiers" staan.
 */
function leidAfUitKaart(r) {
  const opname       = jaTekst(r.opname);
  const rapport      = jaTekst(r.rapport);
  const offerte      = jaTekst(r.offerte);
  const ingediend    = jaTekst(r.ingediend);
  const uitkering    = jaTekst(r.uitkering);
  const hersteld     = jaTekst(r.hersteld);
  const gefactureerd = jaTekst(r.gefactureerd);
  const datumUitv    = heeftWaarde(r.uitvoeringAt);
  const heeftVerz    = heeftWaarde(r.ins);

  // Preset: gaat het dossier langs de verzekeraar of niet?
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

  const haltes = haltesVoorPreset(preset);

  // Bereikte halte: van achter naar voren, de eerste die waar is.
  let step = 1;
  if (opname) step = 2;
  if (rapport) step = 3;
  if (offerte && haltes.includes(4)) step = 4;
  if (ingediend) step = 4;
  if (uitkering) step = 5;
  if (datumUitv) step = 6;
  if (hersteld) step = 8;
  if (gefactureerd) step = 9;

  // Bij eigen risico bestaan halte 4 en 5 niet; zak terug naar de dichtstbijzijnde actieve halte.
  if (!haltes.includes(step)) {
    const lager = haltes.filter((h) => h < step);
    step = lager.length ? lager[lager.length - 1] : haltes[0];
  }

  // Verzekeraarstatus
  let verzStatus = 'geen';
  if (uitkering) verzStatus = 'akkoord';
  else if (ingediend) verzStatus = 'ingediend';

  return { preset, haltes, step, verzStatus };
}

module.exports = {
  HALTES, VAST, PRESETS,
  haltesVoorPreset, normaliseerHaltes, volgendeHalte, isAfgerond,
  leidAfUitKaart, jaTekst,
};
