// Wat voor stuk is het, en welke bestanden nemen we aan.
//
// Dit stond eerst alleen in documenten.routes.js. Nu het postvak bijlagen
// rechtstreeks als dossierstuk kan opslaan, hebben twee plekken dezelfde lijst
// nodig — en twee lijsten die uit elkaar lopen is vragen om problemen.

const SOORTEN = {
  schaderapport: 'Schaderapport',
  offerte: 'Offerte herstel',
  // Herstel in eigenbeheer: de opdrachtgever levert zelf een offerte aan van
  // zijn eigen aannemer, en wij leggen onze toetsing daarnaast.
  offerte_klant: 'Herstelofferte van de opdrachtgever',
  toetsing: 'Toetsing herstelofferte',
  factuur_onder: 'Onderaannemersfactuur',
  offerte_lev: 'Offerte van leverancier',
  factuur_bron: 'Bronherstel · ter info',
  factuur_expertise: 'Factuur schade-expertise',
  machtiging: 'Getekende machtiging',
  polis: 'Polisblad',
  foto: "Foto's",
  uitkeringsbericht: 'Uitkeringsbericht',
  overig: 'Overig',
};

const TOEGESTAAN = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/heic': '.heic',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/msword': '.doc',
  'application/vnd.ms-excel': '.xls',
};

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB per bestand

// Waar de bestanden staan. Buiten de container-image, op een schijf in Coolify.
const OPSLAG = process.env.UPLOAD_DIR || '/data/uploads';

// Sommige mailprogramma's sturen een pdf als 'application/octet-stream'. Dan
// kijken we naar de extensie, anders zou een gewone factuur worden geweigerd.
const OP_EXTENSIE = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.heic': 'image/heic',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
};

/** Welk mime-type houden we aan? Valt terug op de extensie van de bestandsnaam. */
function bepaalMime(mime, bestandsnaam) {
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  if (TOEGESTAAN[m]) return m;
  const naam = String(bestandsnaam || '').toLowerCase();
  const punt = naam.lastIndexOf('.');
  if (punt > -1 && OP_EXTENSIE[naam.slice(punt)]) return OP_EXTENSIE[naam.slice(punt)];
  return null;
}

function veiligeNaam(naam) {
  return String(naam || 'bestand')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

module.exports = { SOORTEN, TOEGESTAAN, MAX_BYTES, OPSLAG, bepaalMime, veiligeNaam };
