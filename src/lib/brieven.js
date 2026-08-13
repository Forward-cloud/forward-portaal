// Begeleidend schrijven per soort verzending — tekst volgt uit het dossier.

const BEDRIJF = {
  naam: 'Forward Real Estate B.V.',
  handelsnaam: 'Forward Schadeherstel',
  adres: 'De Entree 201',
  postcode: '1101 HG',
  plaats: 'Amsterdam',
  telefoon: '',
  email: 'info@forwardre.nl',
  web: 'www.forwardre.nl',
  kvk: '76164144',
  btw: 'NL860530644B01',
  iban: 'NL98 INGB 0007 9448 84',
};

// Wie krijgt wat, en welke stukken gaan standaard mee.
const SOORTEN = {
  claim: {
    label: 'Schadeclaim indienen',
    naar: 'verzekeraar',
    vereist: 5,
    bijlagen: ['machtiging', 'schaderapport', 'offerte', 'factuur_expertise', 'factuur_bron'],
    uitleg: 'Volledig dossier naar de verzekeraar of tussenpersoon.',
  },
  rapport: {
    label: 'Schaderapport versturen',
    naar: 'opdrachtgever',
    vereist: 4,
    bijlagen: ['schaderapport'],
    uitleg: 'Rapport naar de VvE-beheerder of opdrachtgever.',
  },
  offerte: {
    label: 'Offerte versturen',
    naar: 'klant',
    vereist: 7,
    bijlagen: ['offerte'],
    uitleg: 'Herstelofferte naar de klant.',
  },
  herinnering: {
    label: 'Herinnering sturen',
    naar: 'verzekeraar',
    vereist: 5,
    bijlagen: [],
    uitleg: 'Rappel bij uitblijvende reactie.',
  },
  melding_beheerder: {
    label: 'Bericht aan de beheerder',
    naar: 'beheerder',
    vereist: 5,
    bijlagen: ['machtiging', 'schaderapport', 'offerte', 'factuur_expertise', 'factuur_bron'],
    uitleg: 'Kopie van wat er is ingediend, met alle stukken.',
  },
  melding_eigenaar: {
    label: 'Bericht aan de eigenaar',
    naar: 'eigenaar',
    vereist: 5,
    bijlagen: [],
    uitleg: 'Melding dat het is ingediend, met verwijzing naar het portaal.',
  },
  update_eigenaar: {
    label: 'Tussentijdse update aan de eigenaar',
    naar: 'eigenaar',
    vereist: 5,
    bijlagen: [],
    uitleg: 'Laat weten wat er speelt en verwijst naar het portaal.',
  },
  update_beheerder: {
    label: 'Tussentijdse update aan de beheerder',
    naar: 'beheerder',
    vereist: 5,
    bijlagen: [],
    uitleg: 'Zelfde bericht, gericht aan de beheerder.',
  },
  offerte_rappel: {
    label: 'Herinnering offerte',
    naar: 'klant',
    vereist: 7,
    bijlagen: [],
    uitleg: 'Bij een offerte waar nog geen antwoord op is.',
  },
  afronding_eigenaar: {
    label: 'Werk afgerond \u2014 bericht aan de eigenaar',
    naar: 'eigenaar',
    vereist: 9,
    bijlagen: [],
    uitleg: 'Melding dat het herstel klaar is.',
  },
  afronding_beheerder: {
    label: 'Werk afgerond \u2014 bericht aan de beheerder',
    naar: 'beheerder',
    vereist: 9,
    bijlagen: [],
    uitleg: 'Zelfde bericht, gericht aan de beheerder.',
  },
};

// Welke brieven horen bij een dossier met deze haltes?
function soortenVoor(haltes) {
  const actief = Array.isArray(haltes) ? haltes.map(Number) : [];
  return Object.entries(SOORTEN)
    .filter(([, v]) => !v.vereist || actief.includes(v.vereist))
    .map(([k, v]) => ({ key: k, label: v.label, naar: v.naar, uitleg: v.uitleg }));
}

// Waarom sturen we een tussentijdse update?
const AANLEIDINGEN = {
  herinnering: 'Wij hebben de verzekeraar herinnerd',
  informatie: 'De verzekeraar vraagt aanvullende informatie',
  vertraging: 'De behandeling duurt langer dan verwacht',
  bron: 'De oorzaak moet eerst verholpen worden',
};

const PORTAAL = process.env.PORTAAL_URL || 'https://portaal.forwardschadeherstel.nl';

// Onder welke dekking dienen we in? Bepaalt één zin in de claimbrief.
const POLISVORMEN = {
  vve_opstal: 'De schade valt onder de opstalverzekering van de VvE.',
  particulier_opstal: 'De schade valt onder de opstalverzekering van de eigenaar.',
  inboedel: 'De schade valt onder de inboedelverzekering.',
  aansprakelijkheid: 'Wij dienen de schade bij u in op grond van aansprakelijkheid.',
  anders: '',
};

const eur = (n) =>
  '\u20ac ' +
  (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('nl-NL', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const datumNL = (d) =>
  new Date(d || Date.now()).toLocaleDateString('nl-NL', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

// Adresblok van de ontvanger.
function adresblok(soort, schade) {
  if (soort === 'claim' || soort === 'herinnering') {
    const v = schade.verzekeraar || schade.tussenpersoonRel;
    if (!v) return [schade.ins || 'De verzekeraar'];
    return [v.naam, v.adres, [v.postcode, v.plaats].filter(Boolean).join(' ')].filter(Boolean);
  }
  if (['rapport', 'melding_beheerder', 'update_beheerder', 'afronding_beheerder'].includes(soort)) {
    return [schade.opdrachtgever || schade.owner].filter(Boolean);
  }
  return [schade.owner, schade.adres, schade.plaats].filter(Boolean);
}

const AANHEF = {
  claim: 'Indiening schadeclaim',
  rapport: 'Schaderapport',
  offerte: 'Offerte herstel gevolgschade',
  herinnering: 'Rappel schadeclaim',
  melding_beheerder: 'Claim ingediend bij de verzekeraar',
  melding_eigenaar: 'Uw schade is aangemeld',
  offerte_rappel: 'Uw offerte',
  afronding_eigenaar: 'Het herstel is afgerond',
  afronding_beheerder: 'Het herstel is afgerond',
  update_eigenaar: 'Stand van zaken',
  update_beheerder: 'Stand van zaken',
};

function betreft(soort, schade) {
  const waar = [schade.adres, schade.plaats].filter(Boolean).join(', ');
  return `${AANHEF[soort] || AANHEF.claim} \u2014 ${waar}`;
}

// De kenmerken waar een schadebehandelaar op zoekt.
function kenmerken(soort, schade) {
  const uit = [];
  if (soort === 'claim' || soort === 'herinnering') {
    if (schade.polisnummer) uit.push({ label: 'Polisnummer', waarde: schade.polisnummer, mono: true });
    // Het schadenummer krijgen wij pas van de verzekeraar; vóór die tijd blijft dit leeg.
    if (schade.verzSchadenummer) uit.push({ label: 'Uw schadenummer', waarde: schade.verzSchadenummer, mono: true });
    if (schade.opdrachtgever || schade.owner) {
      uit.push({ label: 'Verzekeringnemer', waarde: schade.opdrachtgever || schade.owner });
    }
    if (schade.schadedatum) uit.push({ label: 'Schadedatum', waarde: datumNL(schade.schadedatum) });
  }
  uit.push({ label: 'Ons dossier', waarde: schade.nummer, mono: true });
  if (schade.opnameAt || schade.createdAt) {
    uit.push({ label: 'Datum opname', waarde: datumNL(schade.opnameAt || schade.createdAt) });
  }
  return uit;
}

// Hoe elk soort document in de brief genoemd wordt.
const BIJLAGE_NAAM = {
  machtiging: {
    naam: 'Getekende machtiging',
    toelichting: 'waarmee de verzekeringnemer ons opdracht geeft de schade namens hem af te handelen',
  },
  schaderapport: {
    naam: 'Schaderapport',
    toelichting: 'oorzaakdiagnose, schadeomschrijving, vochtmetingen en inspectiebevindingen',
  },
  offerte: {
    naam: 'Herstelofferte',
    toelichting: 'specificatie van de noodzakelijke herstelwerkzaamheden',
    telt: true,
  },
  factuur_expertise: { naam: 'Factuur schade-expertise en rapportage', telt: true },
  factuur_bron: { naam: 'Bewijsstuk uitgevoerd bronherstel' },
  factuur_onder: { naam: 'Factuur onderaannemer' },
  uitkeringsbericht: { naam: 'Uitkeringsbericht verzekeraar' },
  polis: { naam: 'Polisblad' },
  foto: { naam: "Foto's van de schade" },
  overig: { naam: 'Bijlage' },
};

// Volgorde waarin bijlagen in de brief komen te staan.
const VOLGORDE = ['machtiging', 'schaderapport', 'offerte', 'factuur_expertise', 'factuur_bron',
  'factuur_onder', 'uitkeringsbericht', 'polis', 'foto', 'overig'];

/**
 * Bepaalt welke stukken meegaan.
 * gekozenIds — als die is meegegeven, telt alleen die selectie.
 *              Anders wordt een voorstel gedaan op basis van het soort verzending.
 */
function stukken(soort, documenten, gekozenIds) {
  const s = SOORTEN[soort] || SOORTEN.claim;
  const docs = documenten || [];

  const gekozen = Array.isArray(gekozenIds)
    ? docs.filter((d) => gekozenIds.indexOf(d.id) > -1)
    : docs.filter((d) => s.bijlagen.indexOf(d.soort) > -1);

  return gekozen
    .slice()
    .sort((a, b) => {
      const va = VOLGORDE.indexOf(a.soort), vb = VOLGORDE.indexOf(b.soort);
      return (va < 0 ? 99 : va) - (vb < 0 ? 99 : vb);
    })
    .map((d) => {
      const t = BIJLAGE_NAAM[d.soort] || BIJLAGE_NAAM.overig;
      return {
        naam: t.naam,
        toelichting: t.toelichting,
        doc: d,
        // Alleen offertes en facturen tellen mee in het schadebedrag.
        bedrag: t.telt && d.bedrag ? d.bedrag : null,
      };
    });
}

function opsomming(lijst) {
  return lijst.map((s, i) => `${i + 1}. ${s.naam}${s.toelichting ? ' met daarin ' + s.toelichting : ''};`).join('\n');
}

/**
 * Stelt het begeleidend schrijven samen.
 * schade      — dossier inclusief verzekeraar/tussenpersoon
 * documenten  — documenten van het dossier
 */
function stelOp(soort, schade, documenten, gekozenIds) {
  const type = SOORTEN[soort] ? soort : 'claim';
  const docs = documenten || [];
  const bij = stukken(type, docs, gekozenIds);
  const waar = [schade.adres, schade.plaats].filter(Boolean).join(' in ');
  const opname = schade.opnameAt ? datumNL(schade.opnameAt) : datumNL(schade.createdAt);

  // Bedragen komen uit de stukken zelf, nooit met de hand.
  const posten = bij.filter((b) => b.bedrag);
  const totaal = posten.reduce((a, b) => a + (Number(b.bedrag) || 0), 0);

  let body = '';
  let slot = '';
  let stappen = null;
  let portaalblok = null;
  let betaling = '';
  let labels = null;

  if (type === 'claim') {
    body =
      `Op ${opname} hebben wij de schade opgenomen aan ${waar}, in opdracht van ` +
      `${schade.opdrachtgever || schade.owner}. Hierbij sturen wij u de stukken, zodat u de claim kunt beoordelen. ` +
      POLISVORMEN[schade.polisvorm] || POLISVORMEN.vve_opstal;

    if (schade.oorzaak) {
      body +=
        `\n\nWat de schade heeft veroorzaakt, staat in het schaderapport: ${schade.oorzaak}. ` +
        `Daarin vindt u ook de vochtmetingen en onze verdere bevindingen.`;
    }

    if (bij.some((b) => b.doc && b.doc.soort === 'machtiging')) {
      body +=
        `\n\nWij handelen deze schade af namens de verzekeringnemer. ` +
        `De getekende machtiging vindt u bij de stukken.`;
    }

    if (schade.bronStatus === 'hersteld') {
      body += `\n\nDe oorzaak is inmiddels verholpen, zodat het herstel van de gevolgschade kan beginnen.`;
    } else if (schade.bronStatus === 'open') {
      body += `\n\nHet verhelpen van de oorzaak loopt nog. Wij starten pas met het herstel als dat rond is.`;
    } else if (schade.bronStatus === 'onvoldoende') {
      body += `\n\nDe oorzaak is aangepakt, maar naar ons oordeel nog niet afdoende. Wij houden dit in de gaten.`;
    }

    if (posten.length) {
      body += `\n\nHet schadebedrag komt uit op ${eur(totaal)} inclusief btw:`;
    }

    slot =
      `Wilt u de claim in behandeling nemen? Heeft u nog iets nodig, dan sturen wij dat graag toe.`;

    betaling =
      `Wij treden op namens de verzekeringnemer en verzorgen zowel de opname als het herstel. ` +
      `Voor de uitkering kunt u ons dossiernummer ${schade.nummer} aanhouden.`;
  }

  if (type === 'rapport') {
    body =
      `Op ${opname} hebben wij in uw opdracht de schade opgenomen aan ${waar}. ` +
      `Bijgaand ons rapport: wat de oorzaak is, wat er beschadigd is en wat wij hebben gemeten.`;

    // Bij een expertise-opdracht stopt onze rol hier; anders volgt de indiening.
    const alleenExpertise = schade.preset === 'expertise' || schade.traject === 'expertise';
    slot = alleenExpertise
      ? `Hiermee is onze opdracht afgerond. Heeft u vragen over het rapport of wilt u dat wij ` +
        `het herstel verzorgen, dan horen wij het graag.`
      : `Laat u ons weten of u akkoord bent? Dan dienen wij de claim namens u in bij de verzekeraar. ` +
        `Heeft u vragen of mist u iets, dan horen wij het graag.`;
  }

  if (type === 'offerte') {
    const off = posten[0];
    body = `Bijgaand onze offerte voor het herstel van de schade aan ${waar}.`;
    if (off) {
      body +=
        `\n\nHet herstel komt op ${eur(off.bedrag)} inclusief btw. ` +
        `In de offerte ziet u precies welke werkzaamheden daarbij horen.`;
    }
    if (schade.offerteLink) {
      portaalblok = {
        titel: 'Akkoord geven doet u online',
        tekst:
          'Op de pagina hieronder ziet u de offerte en geeft u met één klik akkoord \u2014 of laat u ' +
          'weten dat u het anders wilt. Uw keuze leggen wij meteen vast.',
        link: schade.offerteLink,
        inlog: schade.offerteGeldigTot
          ? `Deze offerte is geldig tot ${datumNL(schade.offerteGeldigTot)}.`
          : '',
      };
      slot = `Heeft u vragen over het werk of de planning, bel of mail ons gerust.`;
    } else {
      slot =
        `Bent u akkoord, dan plannen wij het herstel in overleg met u in. ` +
        `Heeft u vragen over het werk of de planning, bel of mail ons gerust.`;
    }
  }

  if (type === 'herinnering') {
    const sinds = schade.verzIngediendAt ? datumNL(schade.verzIngediendAt) : null;
    const weken = schade.verzIngediendAt
      ? Math.floor((Date.now() - new Date(schade.verzIngediendAt).getTime()) / 6048e5)
      : 0;

    body =
      (sinds ? `Op ${sinds} hebben wij` : `Enige tijd geleden hebben wij`) +
      ` bij u een schadeclaim ingediend voor ${waar}` +
      (schade.verzSchadenummer ? `, bij u bekend onder schadenummer ${schade.verzSchadenummer}` : '') +
      `. Wij hebben daar nog geen reactie op ontvangen` +
      (weken >= 1 ? `, inmiddels ${weken} ${weken === 1 ? 'week' : 'weken'} geleden` : '') +
      `.`;

    slot = `Kunt u ons laten weten wat de stand van zaken is? Mist u nog stukken, dan sturen wij die dezelfde dag na.`;
  }

  if (type === 'melding_beheerder') {
    const verz = (schade.verzekeraar && schade.verzekeraar.naam) || schade.ins || 'de verzekeraar';
    body =
      `Wij hebben de schadeclaim voor ${waar} vandaag ingediend bij ${verz}. ` +
      `Ter informatie sturen wij u dezelfde stukken die wij hebben opgestuurd.`;
    if (posten.length) {
      body += `\n\nDe claim komt uit op ${eur(totaal)} inclusief btw:`;
    }
    stappen = [
      {
        ico: 'loep',
        titel: 'De verzekeraar beoordeelt de claim',
        tekst:
          'De behandeltijd verschilt per verzekeraar. Reken op minimaal twee tot drie weken.',
      },
      {
        ico: 'bel',
        titel: 'Wij bewaken de termijn',
        tekst:
          'Blijft het stil, dan sturen wij een herinnering. U hoeft daar zelf niet achteraan.',
      },
      {
        ico: 'kalender',
        titel: 'Bij akkoord plannen wij het herstel',
        tekst: 'Wij stemmen de datum rechtstreeks af met de bewoner en houden u op de hoogte.',
      },
      {
        ico: 'vink',
        titel: 'Oplevering en facturatie',
        tekst: 'Na oplevering ronden wij het dossier financieel af.',
      },
    ];

    portaalblok = {
      titel: 'Volg het dossier online',
      tekst: 'In ons portaal ziet u de stand van zaken en wat wij hebben gedaan.',
      link: PORTAAL,
      inlog: `Dossiernummer ${schade.nummer}.`,
    };

    slot =
      `Zodra de verzekeraar reageert, laten wij het u weten. ` +
      `Heeft u in de tussentijd vragen, dan horen wij het graag.`;
  }

  if (type === 'melding_eigenaar') {
    const verz = (schade.verzekeraar && schade.verzekeraar.naam) || schade.ins || 'de verzekeraar';
    body =
      `Wij hebben de schade aan uw woning vandaag aangemeld bij ${verz}. ` +
      `Hieronder leest u wat er nu gebeurt en wanneer u iets van ons hoort.`;

    stappen = [
      {
        ico: 'loep',
        titel: 'De verzekeraar beoordeelt de claim',
        tekst:
          'Hoe lang dat duurt verschilt per verzekeraar. Houd rekening met minimaal twee tot drie weken. ' +
          'Bij een uitgebreide schade kan het langer duren.',
      },
      {
        ico: 'bel',
        titel: 'Wij houden het in de gaten',
        tekst:
          'Blijft het stil, dan sturen wij de verzekeraar een herinnering. ' +
          'U hoeft daar zelf niets voor te doen.',
      },
      {
        ico: 'kalender',
        titel: 'Akkoord? Dan plannen wij het herstel',
        tekst: 'Wij nemen contact met u op voor een datum die u schikt.',
      },
      {
        ico: 'vink',
        titel: 'Herstel en oplevering',
        tekst: 'Onze vakmensen voeren het werk uit. Daarna lopen wij het samen met u na.',
      },
    ];

    portaalblok = {
      titel: 'Volg uw dossier online',
      tekst:
        `In ons portaal ziet u precies waar uw dossier staat en wat wij hebben gedaan \u2014 ` +
        `ook onze herinneringen aan de verzekeraar.`,
      link: PORTAAL,
      inlog: `Inloggen met dossiernummer ${schade.nummer} en uw postcode.`,
    };

    slot = `Zodra er nieuws is, hoort u van ons. Heeft u tussendoor vragen, bel of mail ons gerust.`;
  }

  if (type === 'update_eigenaar' || type === 'update_beheerder') {
    const naarBeheerder = type === 'update_beheerder';
    const wie = naarBeheerder ? 'de eigenaar' : 'u';
    const bezit = naarBeheerder ? 'de woning' : 'uw woning';
    const verz = (schade.verzekeraar && schade.verzekeraar.naam) || schade.ins || 'de verzekeraar';
    const sinds = schade.verzIngediendAt ? datumNL(schade.verzIngediendAt) : null;
    const reden = schade.aanleiding || 'herinnering';

    if (reden === 'herinnering') {
      body =
        `Wij hebben de schade aan ${bezit} aan ${waar}` +
        (sinds ? ` op ${sinds}` : '') +
        ` aangemeld bij ${verz}. Daar hebben wij nog geen reactie op ontvangen. ` +
        `Vandaag hebben wij ${verz} een herinnering gestuurd.`;
      slot =
        (naarBeheerder
          ? `U hoeft zelf niets te doen. Zodra wij iets horen, laten wij het u en de eigenaar weten.`
          : `U hoeft zelf niets te doen. Zodra wij iets horen, laten wij het u weten.`);
    } else if (reden === 'informatie') {
      body =
        `${verz} heeft ons om aanvullende informatie gevraagd over de schade aan ${waar}. ` +
        `Wij zorgen dat zij die zo snel mogelijk krijgen.`;
      slot = `Zodra ${verz} weer aan zet is, ziet u dat in het portaal. Wij houden ${wie} op de hoogte.`;
    } else if (reden === 'vertraging') {
      body =
        `De behandeling van de schade aan ${waar} duurt langer dan wij hadden verwacht. ` +
        `Wij blijven ${verz} volgen en sturen herinneringen zolang dat nodig is.`;
      slot = `U hoeft zelf niets te doen. Zodra er nieuws is, hoort u van ons.`;
    } else {
      body =
        `De oorzaak van de schade aan ${waar} moet eerst verholpen worden voordat wij met het ` +
        `herstel van de gevolgschade kunnen beginnen. Zolang dat niet rond is, staat het dossier stil.`;
      slot = `Zodra de oorzaak is verholpen, pakken wij het herstel op en hoort u van ons.`;
    }

    portaalblok = {
      titel: 'Alles staat in het portaal',
      tekst:
        'Daar ziet u waar het dossier staat, wat wij hebben gedaan en wanneer. ' +
        'Ook onze herinneringen aan de verzekeraar staan erin, zodat u niet hoeft te bellen.',
      link: PORTAAL,
      inlog: naarBeheerder
        ? `Dossiernummer ${schade.nummer}.`
        : `Inloggen met dossiernummer ${schade.nummer} en uw postcode.`,
    };
  }

  if (type === 'offerte_rappel') {
    const dagen = schade.offerteVerstuurdAt
      ? Math.floor((Date.now() - new Date(schade.offerteVerstuurdAt).getTime()) / 864e5)
      : 0;
    body =
      `Enige tijd geleden stuurden wij u onze offerte voor het herstel van de schade aan ${waar}` +
      (dagen >= 1 ? `, inmiddels ${dagen} dagen geleden` : '') +
      `. Wij hebben daar nog geen reactie op gehad.`;
    if (schade.offerteGeopendAt) {
      body += `\n\nMisschien is het u ontschoten of heeft u nog vragen. Beide kan \u2014 laat het gerust weten.`;
    } else {
      body += `\n\nMogelijk is onze e-mail niet aangekomen. Via de link hieronder komt u er alsnog bij.`;
    }

    if (schade.offerteLink) {
      portaalblok = {
        titel: 'Bekijk en beantwoord de offerte',
        tekst: 'U geeft met één klik akkoord, of laat weten dat u het anders wilt.',
        link: schade.offerteLink,
        inlog: schade.offerteGeldigTot
          ? `Geldig tot ${datumNL(schade.offerteGeldigTot)}.`
          : '',
      };
    }
    slot = `Heeft u vragen over de offerte, bel of mail ons gerust. Wij denken graag mee.`;
  }

  if (type === 'afronding_eigenaar' || type === 'afronding_beheerder') {
    const naarBeheerder = type === 'afronding_beheerder';
    const bezit = naarBeheerder ? 'de woning' : 'uw woning';
    const eigenRisico = String(schade.preset || '').startsWith('er_');

    body =
      `Het herstel van de schade aan ${bezit} aan ${waar} is afgerond. ` +
      (naarBeheerder
        ? `Wij hebben het werk samen met de bewoner nagelopen.`
        : `Wij hebben het werk samen met u nagelopen.`);

    if (eigenRisico) {
      body +=
        `\n\nOmdat deze schade onder het eigen risico valt, is er geen verzekeraar bij betrokken. ` +
        `De nota volgt rechtstreeks` + (naarBeheerder ? ' aan u' : '') + `.`;
    }

    slot = naarBeheerder
      ? `Ziet u of hoort u later toch nog iets, laat het ons weten. Wij komen er dan op terug.`
      : `Merkt u later toch nog iets aan het herstel, laat het ons weten. Wij komen er dan op terug.`;

    portaalblok = {
      titel: 'Terugkijken kan altijd',
      tekst: 'In het portaal vindt u het volledige dossier: wat er is gebeurd, wanneer en door wie.',
      link: PORTAAL,
      inlog: naarBeheerder
        ? `Dossiernummer ${schade.nummer}.`
        : `Inloggen met dossiernummer ${schade.nummer} en uw postcode.`,
    };
  }

  // Statuslabels: in één oogopslag zien of het dossier rond is.
  if (type === 'claim' || type === 'melding_beheerder') {
    labels = [];
    if (schade.bronStatus === 'hersteld') {
      labels.push({ tekst: 'Oorzaak verholpen', kleur: 'groen', vink: true });
    } else if (schade.bronStatus === 'open') {
      labels.push({ tekst: 'Oorzaak wordt nog verholpen', kleur: 'amber' });
    } else if (schade.bronStatus === 'onvoldoende') {
      labels.push({ tekst: 'Oorzaak nog niet afdoende verholpen', kleur: 'amber' });
    }
    if (bij.some((b) => b.doc && b.doc.soort === 'schaderapport')) {
      labels.push({ tekst: 'Schaderapport bijgevoegd', kleur: 'teal', vink: true });
    }
    if (bij.some((b) => b.doc && b.doc.soort === 'offerte')) {
      labels.push({ tekst: 'Herstelofferte bijgevoegd', kleur: 'teal', vink: true });
    }
    if (schade.traject === 'expertise') {
      labels.push({ tekst: 'Alleen expertise', kleur: 'neutraal' });
    }
  }

  const ontvanger = adresblok(type, schade);

  return {
    soort: type,
    label: SOORTEN[type].label,
    naar: SOORTEN[type].naar,
    ontvanger,
    plaatsdatum: `${BEDRIJF.plaats}, ${datumNL()}`,
    onderwerp: betreft(type, schade),
    eyebrow: AANHEF[type] || AANHEF.claim,
    titel: [schade.adres, schade.plaats].filter(Boolean).join(', '),
    kenmerken: kenmerken(type, schade),
    aanhef: 'Geachte heer, mevrouw,',
    body,
    slot,
    stappen,
    portaalblok,
    betaling,
    labels,
    afsluiting: 'Met vriendelijke groet,',
    posten: posten.map((p) => ({ naam: p.naam, bedrag: p.bedrag })),
    bijlagen: bij.map((b) => ({ naam: b.naam, toelichting: b.toelichting || '' })),
    documentIds: bij.map((b) => b.doc && b.doc.id).filter(Boolean),
    totaal,
    bedrijf: BEDRIJF,
  };
}

// Platte tekst voor in een e-mail.
function alsTekst(brief, afzender) {
  const posten = (brief.posten || []).filter((p) => p.bedrag);
  const bedragen = posten.length
    ? '\n\n' + posten.map((p) => `\u2022 ${p.naam}: ${eur(p.bedrag)}`).join('\n') +
      `\n  Totaal inclusief btw: ${eur(brief.totaal)}`
    : '';
  const lijst = (brief.bijlagen || []).length
    ? '\n\nBijlagen bij deze brief:\n' +
      brief.bijlagen.map((b) => `\u2022 ${typeof b === 'string' ? b : b.naam}`).join('\n')
    : '';
  const stap = (brief.stappen || []).length
    ? '\n\nHoe gaat het nu verder?\n' +
      brief.stappen.map((st, i) => `${i + 1}. ${st.titel}\n   ${st.tekst}`).join('\n')
    : '';
  const pb = brief.portaalblok
    ? `\n\n${brief.portaalblok.titel}\n${brief.portaalblok.tekst}\n` +
      `${brief.portaalblok.link}\n${brief.portaalblok.inlog}`
    : '';
  const bet = brief.betaling ? `\n\nUitkering\n${brief.betaling}` : '';
  const con = brief.contact ? `\n\nVragen over dit dossier? ${brief.contact}` : '';
  const slot = brief.slot ? `\n\n${brief.slot}` : '';

  return (
    `${brief.aanhef}\n\n${brief.body}${bedragen}${stap}${pb}${lijst}${bet}${slot}${con}\n\n${brief.afsluiting}\n\n` +
    `${afzender || ''}\n${BEDRIJF.handelsnaam}\n` +
    `${BEDRIJF.adres}, ${BEDRIJF.postcode} ${BEDRIJF.plaats}\n` +
    `${BEDRIJF.email} \u00b7 ${BEDRIJF.web}\n` +
    `KvK ${BEDRIJF.kvk} \u00b7 btw ${BEDRIJF.btw}`
  );
}


/* ── Briefpapier: A4 in huisstijl ── */

const LOGO = "<g>\n<path class=\"cls-2\" d=\"M6.85,15.58v10.47H2.37V.46h15.82V4.59H6.85v6.97h9.52v4.03H6.85Z\"/>\n<path class=\"cls-2\" d=\"M43.6,26.46c-7.32,0-12.36-5.43-12.36-13.23S36.32,0,43.64,0s12.43,5.43,12.43,13.23-5.11,13.23-12.46,13.23Zm.04-22.16c-4.69,0-7.7,3.47-7.7,8.93s3.01,8.93,7.7,8.93,7.7-3.54,7.7-8.93-3.01-8.93-7.7-8.93Z\"/>\n<path class=\"cls-2\" d=\"M70.73,26.04V.46h9.77c5.81,0,9.21,2.94,9.21,7.98,0,3.43-1.61,5.88-4.62,7.11l4.87,10.5h-4.9l-4.34-9.56h-5.5v9.56h-4.48Zm4.48-13.51h5.29c2.84,0,4.52-1.51,4.52-4.1s-1.68-3.99-4.52-3.99h-5.29V12.53Z\"/>\n<path class=\"cls-2\" d=\"M102.22,.46h4.66l4.06,13.51c.39,1.4,.77,2.83,1.16,5.08,.42-2.27,.81-3.6,1.26-5.08L117.38,.46h4.94l3.96,13.51c.42,1.44,.8,2.91,1.23,5.08,.49-2.38,.84-3.75,1.23-5.04L132.85,.46h4.55l-7.77,25.59h-4.34l-5.46-18.62-5.57,18.62h-4.41L102.22,.46Z\"/>\n<path class=\"cls-2\" d=\"M146.04,26.04L155.29,.46h4.59l9.24,25.59h-4.73l-2.07-5.92h-9.56l-2.07,5.92h-4.66Zm8.05-9.7h6.93l-2.94-8.26c-.21-.67-.46-1.44-.52-1.96-.1,.49-.31,1.26-.56,1.96l-2.91,8.26Z\"/>\n<path class=\"cls-2\" d=\"M182.83,26.04V.46h9.77c5.81,0,9.21,2.94,9.21,7.98,0,3.43-1.61,5.88-4.62,7.11l4.87,10.5h-4.9l-4.34-9.56h-5.5v9.56h-4.48Zm4.48-13.51h5.29c2.84,0,4.52-1.51,4.52-4.1s-1.68-3.99-4.52-3.99h-5.29V12.53Z\"/>\n<path class=\"cls-2\" d=\"M216.78,26.04V.46h8.96c7.56,0,12.78,5.22,12.78,12.85s-5.11,12.74-12.53,12.74h-9.21Zm4.48-21.46V21.91h4.31c5.11,0,8.23-3.29,8.23-8.61s-3.19-8.72-8.47-8.72h-4.06Z\"/>\n<path class=\"cls-1\" d=\"M4.32,42.13c2.37,0,3.87,1.31,3.94,3.43h-2.05c-.05-1.01-.77-1.6-1.92-1.6-1.26,0-2.08,.61-2.08,1.58,0,.83,.45,1.3,1.42,1.52l1.84,.4c2,.43,2.98,1.46,2.98,3.2,0,2.18-1.7,3.59-4.27,3.59S.05,52.92,0,50.83H2.05c.02,.99,.82,1.58,2.13,1.58s2.22-.59,2.22-1.57c0-.78-.4-1.25-1.36-1.46l-1.86-.42c-1.98-.43-3.03-1.57-3.03-3.36,0-2.05,1.7-3.47,4.16-3.47Z\"/>\n<path class=\"cls-1\" d=\"M18.43,48.2c0-3.63,2.29-6.05,5.71-6.05,2.77,0,4.83,1.62,5.23,4.13h-2.16c-.4-1.36-1.57-2.16-3.12-2.16-2.16,0-3.52,1.57-3.52,4.07s1.38,4.08,3.52,4.08c1.58,0,2.8-.83,3.19-2.13h2.13c-.45,2.47-2.59,4.1-5.36,4.1-3.41,0-5.62-2.37-5.62-6.03Z\"/>\n<path class=\"cls-1\" d=\"M40.05,54.04v-11.7h2.05v4.83h5.19v-4.83h2.05v11.7h-2.05v-4.96h-5.19v4.96h-2.05Z\"/>\n<path class=\"cls-1\" d=\"M59.6,54.04l4.23-11.7h2.1l4.23,11.7h-2.16l-.94-2.71h-4.37l-.94,2.71h-2.13Zm3.68-4.43h3.17l-1.34-3.78c-.1-.3-.21-.66-.24-.9-.05,.22-.14,.58-.26,.9l-1.33,3.78Z\"/>\n<path class=\"cls-1\" d=\"M80.42,54.04v-11.7h4.1c3.46,0,5.84,2.38,5.84,5.87s-2.34,5.83-5.73,5.83h-4.21Zm2.05-9.81v7.92h1.97c2.34,0,3.76-1.5,3.76-3.94s-1.46-3.99-3.87-3.99h-1.86Z\"/>\n<path class=\"cls-1\" d=\"M101.06,54.04v-11.7h7.27v1.89h-5.22v3.01h4.67v1.81h-4.67v3.11h5.22v1.89h-7.27Z\"/>\n<path class=\"cls-1\" d=\"M119.34,54.04v-11.7h2.05v4.83h5.19v-4.83h2.05v11.7h-2.05v-4.96h-5.19v4.96h-2.05Z\"/>\n<path class=\"cls-1\" d=\"M140.02,54.04v-11.7h7.27v1.89h-5.22v3.01h4.67v1.81h-4.67v3.11h5.22v1.89h-7.27Z\"/>\n<path class=\"cls-1\" d=\"M158.3,54.04v-11.7h4.47c2.66,0,4.21,1.34,4.21,3.65,0,1.57-.74,2.69-2.11,3.25l2.22,4.8h-2.24l-1.98-4.37h-2.51v4.37h-2.05Zm2.05-6.18h2.42c1.3,0,2.06-.69,2.06-1.87s-.77-1.82-2.06-1.82h-2.42v3.7Z\"/>\n<path class=\"cls-1\" d=\"M181.31,42.13c2.37,0,3.87,1.31,3.94,3.43h-2.05c-.05-1.01-.77-1.6-1.92-1.6-1.26,0-2.08,.61-2.08,1.58,0,.83,.45,1.3,1.42,1.52l1.84,.4c2,.43,2.98,1.46,2.98,3.2,0,2.18-1.7,3.59-4.27,3.59s-4.13-1.33-4.18-3.43h2.05c.02,.99,.82,1.58,2.13,1.58s2.22-.59,2.22-1.57c0-.78-.4-1.25-1.36-1.46l-1.86-.42c-1.98-.43-3.03-1.57-3.03-3.36,0-2.05,1.7-3.47,4.16-3.47Z\"/>\n<path class=\"cls-1\" d=\"M194.91,42.34h8.9v1.89h-3.43v9.81h-2.05v-9.81h-3.43v-1.89Z\"/>\n<path class=\"cls-1\" d=\"M214.18,54.04v-11.7h7.27v1.89h-5.22v3.01h4.67v1.81h-4.67v3.11h5.22v1.89h-7.27Z\"/>\n<path class=\"cls-1\" d=\"M234.51,52.15h4.9v1.89h-6.95v-11.7h2.05v9.81Z\"/>\n</g>\n<line class=\"cls-3\" x1=\"42.92\" y1=\"89.01\" x2=\"200.34\" y2=\"89.01\"/>";

const escH = (v) =>
  String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Zet het begeleidend schrijven om naar een afdrukbare A4 in huisstijl.
 * afzender — naam van wie ondertekent
 */
function briefHtml(brief, afzender, functie, handtekening) {
  const B = brief.bedrijf || BEDRIJF;

  const kenm = (brief.kenmerken || []).length
    ? `<div class="kenmerken">${brief.kenmerken
        .map((k) => `<div class="k"><div class="lab">${escH(k.label)}</div><div class="val${k.mono ? ' mono' : ''}">${escH(k.waarde)}</div></div>`)
        .join('')}</div>`
    : '';

  const posten = (brief.posten || []).filter((p) => p.bedrag);
  const tabel = posten.length
    ? `<table class="bedragen"><tbody>${posten
        .map((p) => `<tr><td>${escH(p.naam)}</td><td class="num">${escH(eur(p.bedrag))}</td></tr>`)
        .join('')}</tbody><tfoot><tr><td>Totaal inclusief btw</td><td class="num">${escH(eur(brief.totaal))}</td></tr></tfoot></table>`
    : '';

  const bijlagen = (brief.bijlagen || []).length
    ? `<div class="bijlagen"><div class="kop">Meegestuurd \u2014 ${brief.bijlagen.length} ${
        brief.bijlagen.length === 1 ? 'document' : 'documenten'
      }</div><ul>${brief.bijlagen
        .map((b) => {
          const naam = typeof b === 'string' ? b : b.naam;
          const uitleg = typeof b === 'string' ? '' : b.toelichting;
          return `<li><span class="vk"><svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="nm">${escH(naam)}</span>${
            uitleg ? `<span class="tl">${escH(uitleg)}</span>` : ''
          }</li>`;
        })
        .join('')}</ul></div>`
    : '';

  const ICONEN = {
    loep: '<circle cx="11" cy="11" r="6.2" stroke="currentColor" stroke-width="1.9"/><path d="M15.6 15.6L20 20" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
    bel: '<path d="M18 15V10a6 6 0 10-12 0v5l-1.5 2.5h15L18 15z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 20.5a2.2 2.2 0 004 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    kalender: '<rect x="3.5" y="5.5" width="17" height="15" rx="2.4" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 10h17M8.5 3.5v4M15.5 3.5v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    vink: '<circle cx="12" cy="12" r="8.6" stroke="currentColor" stroke-width="1.8"/><path d="M8.4 12.2l2.5 2.5 4.7-5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  };

  const labels = (brief.labels || []).length
    ? `<div class="labels">${brief.labels
        .map((l) => `<span class="lb ${l.kleur || 'neutraal'}">${l.vink ? '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}${escH(l.tekst)}</span>`)
        .join('')}</div>`
    : '';

  const stappen = (brief.stappen || []).length
    ? `<div class="stappen">
        <div class="kop">Hoe gaat het nu verder?</div>
        ${brief.stappen
          .map(
            (st, i) => `<div class="stap">
              <div class="zij">
                <div class="bol"><svg viewBox="0 0 24 24" fill="none">${ICONEN[st.ico] || ICONEN.vink}</svg></div>
                ${i < brief.stappen.length - 1 ? '<div class="lijn"></div>' : ''}
              </div>
              <div class="inh">
                <div class="tit">${escH(st.titel)}</div>
                <div class="txt">${escH(st.tekst)}</div>
              </div>
            </div>`
          )
          .join('')}
      </div>`
    : '';

  const pb = brief.portaalblok;
  const portaal = pb
    ? `<div class="portaal">
        <div class="pk">${escH(pb.titel)}</div>
        <div class="pt">${escH(pb.tekst)}</div>
        <div class="pl">${escH(pb.link)}</div>
        <div class="pi">${escH(pb.inlog)}</div>
      </div>`
    : '';

  const betaalblok = brief.betaling
    ? `<div class="betaling"><div class="bk">Uitkering</div><div class="bt">${escH(brief.betaling)}</div></div>`
    : '';

  const contact = brief.contact
    ? `<div class="contact"><span class="ck">Vragen over dit dossier?</span> ${escH(brief.contact)}</div>`
    : '';

  const slotTekst = String(brief.slot || '')
    .split(/\n\s*\n/).map((a) => a.trim()).filter(Boolean)
    .map((a) => `<p>${escH(a)}</p>`).join('');

  const alineas = String(brief.body || '')
    .split(/\n\s*\n/)
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => `<p>${escH(a).replace(/\n/g, '<br>')}</p>`)
    .join('');

  return `<!doctype html>
<html lang="nl"><head><meta charset="utf-8">
<title>${escH(brief.onderwerp)}</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600;700&family=Inter:wght@400;450;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{--navy:#151F35;--teal:#009BA8;--text:#16202F;--muted:#677589;--muted-2:#97A2B2;--line:#E4E9EF}
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{background:#EDF1F4;font-family:'Inter',system-ui,sans-serif;color:var(--text);
    -webkit-font-smoothing:antialiased;line-height:1.55;font-size:10pt;font-feature-settings:"kern","liga"}

  .vel{width:210mm;min-height:297mm;margin:18px auto;background:#fff;
    padding:18mm 20mm 28mm;position:relative;box-shadow:0 10px 34px rgba(21,31,53,.11)}

  .hoofd{display:flex;justify-content:space-between;align-items:flex-start;gap:20mm;margin-bottom:14mm}
  .hoofd .logo{width:46mm;flex:none}
  .hoofd .logo svg{width:100%;height:auto;display:block}
  .fwd-logo .cls-1{fill:#009BA8}
  .fwd-logo .cls-2{fill:#151F35}
  .fwd-logo .cls-3{fill:none;stroke:#009BA8;stroke-miterlimit:10;stroke-width:1.4}
  .afzender{font-size:8pt;color:var(--muted-2);line-height:1.7;text-align:right;padding-top:1mm}
  .afzender .naam{color:var(--navy);font-weight:600;font-size:8.5pt}
  .afzender .blok{margin-top:6px}

  .adresrij{display:flex;justify-content:space-between;align-items:flex-end;gap:20mm;margin-bottom:12mm}
  .ontvanger{line-height:1.65;font-size:10pt}
  .ontvanger .naam{font-weight:600;color:var(--navy)}
  .datum{color:var(--muted);font-size:9.5pt;white-space:nowrap;text-align:right}

  .titelblok{margin-bottom:8mm}
  .eyebrow{font-size:8pt;font-weight:600;color:var(--teal);letter-spacing:.09em;
    text-transform:uppercase;margin-bottom:2.5mm}
  h1{font-family:'Poppins',sans-serif;font-weight:600;font-size:15pt;color:var(--navy);
    margin:0;line-height:1.3;letter-spacing:-.01em}

  .kenmerken{display:flex;flex-wrap:wrap;border-top:1px solid var(--line);
    border-bottom:1px solid var(--line);padding:4mm 0;margin-bottom:9mm}
  .kenmerken .k{flex:1 1 38mm;min-width:34mm;padding-right:6mm}
  .kenmerken .lab{font-size:7.5pt;color:var(--muted-2);letter-spacing:.06em;
    text-transform:uppercase;margin-bottom:1mm}
  .kenmerken .val{font-size:9.5pt;color:var(--navy);font-weight:500}
  .kenmerken .val.mono{font-family:'JetBrains Mono',monospace;font-size:9pt;letter-spacing:-.02em}

  /* ── labels ── */
  .labels{display:flex;flex-wrap:wrap;gap:2mm;margin:-4mm 0 7mm}
  .lb{display:inline-flex;align-items:center;gap:1.4mm;font-size:8.5pt;font-weight:500;
    padding:1.3mm 3mm;border-radius:20mm;line-height:1.2}
  .lb svg{width:3.4mm;height:3.4mm}
  .lb.groen{background:#E1F4EA;color:#12704A}
  .lb.amber{background:#FAF0DA;color:#8A5A0B}
  .lb.teal{background:#E0F4F6;color:#006670}
  .lb.neutraal{background:#F1F4F7;color:#4A5568}

  p{margin:0 0 4mm}
  .aanhef{margin-bottom:4.5mm}

  table.bedragen{width:100%;border-collapse:collapse;margin:7mm 0;font-size:9.5pt}
  table.bedragen td{padding:2.8mm 0;border-bottom:1px solid var(--line);vertical-align:baseline}
  table.bedragen td.num{text-align:right;white-space:nowrap;padding-left:10mm;
    font-variant-numeric:tabular-nums;font-feature-settings:"tnum";color:var(--navy)}
  table.bedragen tfoot td{border-bottom:none;border-top:1.6pt solid var(--navy);
    font-weight:600;color:var(--navy);padding-top:3mm;font-size:10.5pt}

  .bijlagen{border-left:2.5pt solid var(--teal);padding:1mm 0 1mm 5mm;margin:7mm 0}
  .bijlagen .kop{font-size:7.5pt;font-weight:600;color:var(--muted-2);
    letter-spacing:.06em;text-transform:uppercase;margin-bottom:2mm}
  .bijlagen ul{margin:0;padding:0;list-style:none;font-size:9.5pt;line-height:1.5}
  .bijlagen li{padding:1.4mm 0 1.4mm 7mm;position:relative}
  .bijlagen .vk{position:absolute;left:0;top:1.8mm;width:4.4mm;height:4.4mm;border-radius:50%;
    background:var(--teal);color:#fff;display:flex;align-items:center;justify-content:center}
  .bijlagen .vk svg{width:2.8mm;height:2.8mm}
  .bijlagen .nm{display:block;font-weight:500;color:var(--navy)}
  .bijlagen .tl{display:block;font-size:8.5pt;color:var(--muted);margin-top:.3mm}

  /* ── stappen ── */
  .stappen{margin:8mm 0 7mm}
  .stappen .kop{font-family:'Poppins',sans-serif;font-weight:600;font-size:11pt;color:var(--navy);
    margin-bottom:5mm}
  .stap{display:flex;gap:4mm;align-items:stretch}
  .stap .zij{display:flex;flex-direction:column;align-items:center;flex:none;width:9mm}
  .stap .bol{width:9mm;height:9mm;border-radius:50%;background:#E0F4F6;color:var(--teal);
    display:flex;align-items:center;justify-content:center;flex:none}
  .stap .bol svg{width:5mm;height:5mm}
  .stap .lijn{width:1.2pt;flex:1;background:#CFE9EC;margin:1mm 0}
  .stap .inh{padding-bottom:5mm;padding-top:.6mm}
  .stap .tit{font-weight:600;color:var(--navy);font-size:10pt;margin-bottom:.8mm}
  .stap .txt{font-size:9.5pt;color:var(--muted);line-height:1.5}

  /* ── portaalblok ── */
  .portaal{background:#F4FAFB;border:1px solid #D4EDF0;border-radius:3.5mm;
    padding:5mm 6mm;margin:7mm 0}
  .portaal .pk{font-family:'Poppins',sans-serif;font-weight:600;font-size:10pt;color:var(--navy);
    margin-bottom:1.5mm}
  .portaal .pt{font-size:9.5pt;color:var(--muted);line-height:1.5;margin-bottom:2.5mm}
  .portaal .pl{font-family:'JetBrains Mono',monospace;font-size:9.5pt;color:var(--teal);
    letter-spacing:-.02em;word-break:break-all}
  .portaal .pi{font-size:8.5pt;color:var(--muted-2);margin-top:1.5mm}

  /* ── uitkering ── */
  .betaling{border-left:2.5pt solid var(--navy);padding:1mm 0 1mm 5mm;margin:7mm 0}
  .betaling .bk{font-size:7.5pt;font-weight:600;color:var(--muted-2);letter-spacing:.06em;
    text-transform:uppercase;margin-bottom:1.5mm}
  .betaling .bt{font-size:9.5pt;line-height:1.5}

  /* ── contact ── */
  .contact{font-size:9pt;color:var(--muted);margin-top:6mm;padding-top:3mm;
    border-top:1px solid var(--line)}
  .contact .ck{color:var(--navy);font-weight:500}

  .groet{margin-top:9mm}
  .ruimte{height:16mm}
  .krabbel{height:17mm;display:flex;align-items:flex-end;padding-bottom:1mm}
  .krabbel img{max-height:16mm;max-width:62mm;width:auto;display:block}
  .ondertekenaar{padding-top:2mm;border-top:1px solid var(--line);display:inline-block;min-width:60mm}
  .ondertekenaar .naam{font-weight:600;color:var(--navy);font-size:10pt}
  .ondertekenaar .functie{color:var(--muted);font-size:9pt;margin-top:.5mm}

  .voet{position:absolute;left:20mm;right:20mm;bottom:13mm;padding-top:3.5mm;
    border-top:1px solid var(--line);font-size:7.2pt;color:var(--muted-2);
    display:flex;justify-content:space-between;gap:10mm}

  .knoppen{width:210mm;margin:0 auto 14px;display:flex;gap:8px;justify-content:flex-end}
  .knoppen button{font-family:'Inter',sans-serif;font-size:13px;padding:10px 18px;border-radius:10px;
    border:none;cursor:pointer;background:var(--teal);color:#fff;font-weight:500}
  .knoppen button.licht{background:#fff;color:var(--text);border:1px solid var(--line)}

  @media print{
    body{background:#fff}
    .vel{margin:0;box-shadow:none;width:auto;min-height:auto;padding:16mm 18mm 24mm}
    .knoppen{display:none}
    @page{size:A4;margin:0}
  }
</style></head>
<body>
  <div class="knoppen">
    <button class="licht" onclick="window.close()">Sluiten</button>
    <button onclick="window.print()">Opslaan als pdf</button>
  </div>

  <div class="vel">
    <div class="hoofd">
      <div class="logo"><svg class="fwd-logo" viewBox="0 0 239.41 89.51" xmlns="http://www.w3.org/2000/svg">${LOGO}</svg></div>
      <div class="afzender">
        <div class="naam">${escH(B.naam)}</div>
        ${escH(B.adres)}<br>${escH(B.postcode)} ${escH(B.plaats)}
        <div class="blok">${escH(B.email)}<br>${escH(B.web)}</div>
        <div class="blok">KvK ${escH(B.kvk)}<br>Btw ${escH(B.btw)}</div>
      </div>
    </div>

    <div class="adresrij">
      <div class="ontvanger">${(brief.ontvanger || [])
        .map((r, i) => (i === 0 ? `<span class="naam">${escH(r)}</span>` : escH(r))).join('<br>')}</div>
      <div class="datum">${escH(brief.plaatsdatum)}</div>
    </div>

    <div class="titelblok">
      <div class="eyebrow">${escH(brief.eyebrow || '')}</div>
      <h1>${escH(brief.titel || brief.onderwerp)}</h1>
    </div>

    ${kenm}
    ${labels}

    <p class="aanhef">${escH(brief.aanhef)}</p>
    ${alineas}
    ${tabel}
    ${stappen}
    ${portaal}
    ${bijlagen}
    ${betaalblok}
    ${slotTekst}
    ${contact}

    <div class="groet">
      <p>${escH(brief.afsluiting)}</p>
      ${handtekening
        ? `<div class="krabbel"><img src="${escH(handtekening)}" alt=""></div>`
        : '<div class="ruimte"></div>'}
      <div class="ondertekenaar">
        <div class="naam">${escH(afzender || '')}</div>
        <div class="functie">${escH(functie || B.handelsnaam)}</div>
      </div>
    </div>

    <div class="voet">
      <span>${escH(B.naam)} &middot; ${escH(B.adres)} &middot; ${escH(B.postcode)} ${escH(B.plaats)} &middot; ${escH(B.web)}</span>
      <span>KvK ${escH(B.kvk)} &middot; ${escH(B.iban)}</span>
    </div>
  </div>
</body></html>`;
}

module.exports = { BEDRIJF, SOORTEN, POLISVORMEN, soortenVoor, AANLEIDINGEN, PORTAAL, BIJLAGE_NAAM, AANHEF, kenmerken, stukken, stelOp, alsTekst, briefHtml, adresblok, betreft, eur, datumNL };
