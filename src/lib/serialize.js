const { isDirectie } = require('../auth/roles');
const {
  normaliseerHaltes, volgendeHalte, isAfgerond, positie,
  halteNaam, halteNamen, isEigenRisico, standen,
  tellerVanaf, tellerLoopt, dagenOpen, termijnOver, bronBlokkeert,
} = require('./haltes');

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
    verzekeraarId: s.verzekeraarId,
    tussenpersoonId: s.tussenpersoonId,
    verzekeraar: s.verzekeraar
      ? { id: s.verzekeraar.id, naam: s.verzekeraar.naam, email: s.verzekeraar.email,
          telefoon: s.verzekeraar.telefoon, contactpersoon: s.verzekeraar.contactpersoon,
          reactietermijn: s.verzekeraar.reactietermijn }
      : null,
    tussenpersoonRel: s.tussenpersoonRel
      ? { id: s.tussenpersoonRel.id, naam: s.tussenpersoonRel.naam,
          email: s.tussenpersoonRel.email, telefoon: s.tussenpersoonRel.telefoon }
      : null,
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

    aangenomenAt: s.aangenomenAt,
    weigerReden: s.weigerReden,
    bronStatus: s.bronStatus,
    bronBeoordeeld: s.bronBeoordeeld,
    bronAanbod: s.bronAanbod,
    bronFactuur: s.bronFactuur,
    bronDoorOns: s.bronDoorOns,
    weigerReden: s.weigerReden,
    bronOpmerking: s.bronOpmerking,
    bronHersteldAt: s.bronHersteldAt,
    bronDoorReden: s.bronDoorReden,

    opdrachtnummer: s.opdrachtnummer,
    opdrachtgever: s.opdrachtgever,
    beheerderEmail: s.beheerderEmail,
    beheerderTel: s.beheerderTel,
    telefoon: s.telefoon,
    postcode: s.postcode,
    bewonerSoort: s.bewonerSoort,
    contactpersoon: s.contactpersoon,
    locaties: (s.locaties || []).map((l) => ({
      id: l.id, adres: l.adres, postcode: l.postcode, plaats: l.plaats, aanduiding: l.aanduiding,
      bewoner: l.bewoner, bewonerSoort: l.bewonerSoort, telefoon: l.telefoon, email: l.email,
      status: l.status, ingepland: l.ingepland, tijdvak: l.tijdvak, opgeleverdAt: l.opgeleverdAt,
      notitie: l.notitie, hoofd: l.hoofd,
    })),
    aantalLocaties: (s.locaties || []).length,

    // Werkgangen per adres
    uitvoeringen: (s.uitvoeringen || []).map((u) => ({
      id: u.id, locatieId: u.locatieId, datum: u.datum, starttijd: u.starttijd,
      uren: u.uren, omschrijving: u.omschrijving, afgerond: u.afgerond,
      afgerondAt: u.afgerondAt, doorNaam: u.doorNaam,
    })),

    // Wat er openstaat. Blijft staan als de halte verspringt.
    actiepunten: (s.actiepunten || []).map((a) => ({
      id: a.id, soort: a.soort, tekst: a.tekst, open: a.open,
      klant: a.klant, afgerondAt: a.afgerondAt, doorNaam: a.doorNaam,
    })),
    openActiepunten: (s.actiepunten || []).filter((a) => a.open).length,

    // De behandelaar staat onder de brieven en op de bonnen.
    behandelaarId: s.behandelaarId,
    behandelaar: s.behandelaar
      ? { id: s.behandelaar.id, naam: s.behandelaar.naam, role: s.behandelaar.role }
      : null,

    afwijzingAt: s.afwijzingAt,
    naAfwijzing: s.naAfwijzing,
    betalerNaAfwijzing: s.betalerNaAfwijzing,
    polisnummer: s.polisnummer,
    oorzaak: s.oorzaak,
    opnameAt: s.opnameAt,
    schadedatum: s.schadedatum,
    polisvorm: s.polisvorm,
    offerteOpen: !!(s.offertes || []).find((o) => o.status === 'open'),
    offerteVerstuurdAt: ((s.offertes || []).find((o) => o.status === 'open') || {}).verstuurdAt || null,
    offerteGeopendAt: ((s.offertes || []).find((o) => o.status === 'open') || {}).geopendAt || null,
    uitvraagTeLaat: (s.opdrachtbonnen || []).filter((b) =>
      b.soort === 'aanvraag' && !b.bedrag && b.status !== 'vervallen' &&
      b.reactieVoor && new Date(b.reactieVoor) < new Date()).length || null,
    offerteStatus: ((s.offertes || [])[0] || {}).status || null,
    bronStatus: s.bronStatus,

    verzekeraarId: s.verzekeraarId,
    verzekeraar: s.verzekeraar || null,
    tussenpersoonId: s.tussenpersoonId,
    tussenpersoonRel: s.tussenpersoonRel || null,

    verzStatus: s.verzStatus,
    verzStatusLabel: (standen(s.preset) || {})[s.verzStatus] || null,
    verzSchadenummer: s.verzSchadenummer,
    verzEmail: s.verzEmail,
    tussenpersoon: s.tussenpersoon,
    verzIngediendAt: s.verzIngediendAt,
    afwijzingReden: s.afwijzingReden,

    // Termijnbewaking. De teller staat stil zolang de bal bij ons ligt.
    herinnerDagen: s.herinnerDagen,
    herinnerAantal: s.herinnerAantal,
    herinnerLaatstAt: s.herinnerLaatstAt,
    infoVerstuurdAt: s.infoVerstuurdAt,
    tellerVanaf: tellerVanaf(s),
    tellerLoopt: tellerLoopt(s),
    dagenOpen: dagenOpen(s),
    termijnOver: termijnOver(s),

    // Bij eigen risico heten halte 5 en 6 anders, en betaalt de klant zelf.
    eigenRisico: isEigenRisico(s.preset),
    halteNamen: halteNamen(s.preset),
    halteNaam: halteNaam(s.step, s.preset),
    bronBlokkade: bronBlokkeert(s, s.step + 1),

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
    const omzet = s.finHerstelOmzet || 0;
    const inkoop = s.finHerstelInkoop || 0;
    const uitbesteed = s.finHerstelUitbesteed || 0;
    const expertise = s.finExpertiseOmzet || 0;
    const marge = omzet - inkoop - uitbesteed;

    base.profit = s.profit;
    base.fin = {
      expertiseOmzet: expertise,
      herstelOmzet: omzet,
      herstelInkoop: inkoop,
      herstelUitbesteed: uitbesteed,
      // De marge gaat over het herstel. De expertise staat er los naast,
      // en telt wel mee in de totale schadeomzet.
      marge,
      margeInclusiefRapport: marge + expertise,
      totaleOmzet: omzet + expertise,
    };
    base.facturen = (s.facturen || []).map((f) => ({
      id: f.id, nummer: f.nummer, status: f.status, jorttStatus: f.jorttStatus,
      datum: f.datum, termijn: f.termijn, vervaltAt: f.vervaltAt,
      aanNaam: f.aanNaam, totaal: f.totaal, openstaand: f.openstaand,
      verstuurdAt: f.verstuurdAt, betaaldAt: f.betaaldAt, herinneringen: f.herinneringen,
    }));
  }
  return base;
}

// Dossier zoals de KLANT het mag zien — nooit financiën, nooit de wachtstand,
// nooit het opdrachtnummer van de beheerder, alleen vrijgegeven documenten.
function schadeForClient(s) {
  const dv = s.docVisible || {};
  const documents = DOCS.filter((d) => dv[d.key]).map((d) => ({ naam: d.naam, ico: d.ico, kleur: d.kleur }));
  const haltes = normaliseerHaltes(s.haltes);
  return {
    nummer: s.nummer,
    owner: s.owner,
    adres: s.adres,
    plaats: s.plaats,
    ins: s.ins,
    status: s.status,
    step: s.step,
    traject: s.traject,
    haltes,
    halteNamen: halteNamen(s.preset),
    halteNaam: halteNaam(s.step, s.preset),
    positie: positie(s.step, haltes).positie,
    totaal: positie(s.step, haltes).totaal,
    eigenRisico: isEigenRisico(s.preset),
    verzStatus: s.verzStatus,
    verzStatusLabel: (standen(s.preset) || {})[s.verzStatus] || null,
    bronStatus: s.bronStatus,
    // Alleen de punten die voor de klant bedoeld zijn.
    actiepunten: (s.actiepunten || [])
      .filter((a) => a.open && a.klant)
      .map((a) => ({ tekst: a.tekst })),
    // Alleen wat er echt staat, geen interne planning.
    uitvoeringen: (s.uitvoeringen || []).map((u) => ({
      datum: u.datum, starttijd: u.starttijd, uren: u.uren,
      omschrijving: u.omschrijving, afgerond: u.afgerond,
    })),
    documents,
  };
}

module.exports = { safeUser, schadeForUser, schadeForClient, DOCS };
