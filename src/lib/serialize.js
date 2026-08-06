const { isDirectie } = require('../auth/roles');
const { normaliseerHaltes, volgendeHalte, isAfgerond, positie } = require('./haltes');

// Standaard documentenlijst van een dossier (later uit de DB / opslag)
const DOCS = [
  { key: 'Schaderapport.pdf', naam: 'Schaderapport', ico: '📄', kleur: 'red' },
  { key: 'Offerte herstel.pdf', naam: 'Offerte herstel', ico: '🧾', kleur: 'teal' },
  { key: 'Polisblad.pdf', naam: 'Polisblad', ico: '📑', kleur: 'grey' },
];

function safeUser(u) {
  return { id: u.id, naam: u.naam, email: u.email, role: u.role, active: u.active };
}

// Dossier zoals de MEDEWERKER het mag zien — financiën alleen voor directie.
function schadeForUser(s, user) {
  const haltes = normaliseerHaltes(s.haltes);
  const base = {
    id: s.id,
    nummer: s.nummer,
    owner: s.owner,
    email: s.email,
    adres: s.adres,
    plaats: s.plaats,
    ins: s.ins,
    amount: s.amount,
    status: s.status,
    step: s.step,
    traject: s.traject,

    haltes,
    preset: s.preset,
    volgendeHalte: volgendeHalte(s.step, haltes),
    afgerond: isAfgerond(s.step, haltes),
    positie: positie(s.step, haltes).positie,
    totaal: positie(s.step, haltes).totaal,

    bronStatus: s.bronStatus,
    bronOpmerking: s.bronOpmerking,
    bronHersteldAt: s.bronHersteldAt,
    bronDoorReden: s.bronDoorReden,

    opdrachtnummer: s.opdrachtnummer,
    opdrachtgever: s.opdrachtgever,

    verzekeraarId: s.verzekeraarId,
    verzekeraar: s.verzekeraar || null,
    tussenpersoonId: s.tussenpersoonId,
    tussenpersoonRel: s.tussenpersoonRel || null,

    verzStatus: s.verzStatus,
    verzSchadenummer: s.verzSchadenummer,
    verzEmail: s.verzEmail,
    tussenpersoon: s.tussenpersoon,
    verzIngediendAt: s.verzIngediendAt,
    afwijzingReden: s.afwijzingReden,

    wachtReden: s.wachtReden,
    wachtTot: s.wachtTot,
    inWacht: !!s.wachtReden,

    archived: s.archived,
    archivedAt: s.archivedAt,

    uitvoeringAt: s.uitvoeringAt,
    gefactureerd: s.gefactureerd,

    ingediendAt: s.ingediendAt,
    docVisible: s.docVisible || {},
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
  if (isDirectie(user)) {
    base.profit = s.profit;
    base.fin = {
      expertiseOmzet: s.finExpertiseOmzet,
      herstelOmzet: s.finHerstelOmzet,
      herstelInkoop: s.finHerstelInkoop,
      herstelUitbesteed: s.finHerstelUitbesteed,
    };
  }
  return base;
}

// Dossier zoals de KLANT het mag zien — nooit financiën, nooit de wachtstand,
// nooit het opdrachtnummer van de beheerder, alleen vrijgegeven documenten.
function schadeForClient(s) {
  const dv = s.docVisible || {};
  const documents = DOCS.filter((d) => dv[d.key]).map((d) => ({ naam: d.naam, ico: d.ico, kleur: d.kleur }));
  return {
    nummer: s.nummer,
    owner: s.owner,
    adres: s.adres,
    plaats: s.plaats,
    ins: s.ins,
    status: s.status,
    step: s.step,
    traject: s.traject,
    haltes: normaliseerHaltes(s.haltes),
    bronStatus: s.bronStatus,
    documents,
  };
}

module.exports = { safeUser, schadeForUser, schadeForClient, DOCS };
