const { isDirectie } = require('../auth/roles');

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
  const base = {
    nummer: s.nummer,
    owner: s.owner,
    email: s.email,
    adres: s.adres,
    ins: s.ins,
    amount: s.amount,
    status: s.status,
    step: s.step,
    traject: s.traject,
    ingediendAt: s.ingediendAt,
    docVisible: s.docVisible || {},
    createdAt: s.createdAt,
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

// Dossier zoals de KLANT het mag zien — nooit financiën, alleen vrijgegeven documenten.
function schadeForClient(s) {
  const dv = s.docVisible || {};
  const documents = DOCS.filter((d) => dv[d.key]).map((d) => ({ naam: d.naam, ico: d.ico, kleur: d.kleur }));
  return {
    nummer: s.nummer,
    owner: s.owner,
    adres: s.adres,
    ins: s.ins,
    status: s.status,
    step: s.step,
    traject: s.traject,
    documents, // leeg = klant ziet geen documenten-tab
  };
}

module.exports = { safeUser, schadeForUser, schadeForClient, DOCS };
