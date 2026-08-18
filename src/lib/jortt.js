// Koppeling met jortt. Wij houden het dossier bij, jortt houdt de boekhouding bij.
//
// Afspraken die hierin verwerkt zitten:
//   - jortt verstuurt de factuur, dus jortt maakt ook het factuurnummer
//   - versturen gebeurt vanuit het portaal, in één handeling
//   - btw wordt alleen verlegd als wij onderaannemer zijn, niet bij een VvE
//   - standaard betaaltermijn is veertien dagen
//
// Nodig in Coolify: JORTT_CLIENT_ID, JORTT_CLIENT_SECRET en JORTT_TRADENAME_ID.

const TOKEN_URL = 'https://app.jortt.nl/oauth-provider/oauth/token';
const API = 'https://api.jortt.nl';

const SCOPES = [
  'invoices:read',
  'invoices:write',
  'customers:read',
  'customers:write',
  'organizations:read',
].join(' ');

const BETAALTERMIJN = 14;

// De handelsnaam waaraan jortt het factuursjabloon hangt -- daar zit het
// briefpapier van Forward aan vast. Leeg laten kan; jortt pakt dan de standaard.
const TRADENAME = process.env.JORTT_TRADENAME_ID || null;

function aan() {
  return !!(process.env.JORTT_CLIENT_ID && process.env.JORTT_CLIENT_SECRET);
}

/* ── token ──
   Een token is twee uur geldig. Wij houden hem in het geheugen en halen een
   nieuwe zodra hij bijna verloopt. Bij een herstart gebeurt dat vanzelf. */
let token = null;
let tokenTot = 0;

// Twee manieren om in te loggen: met de sleutels in de kopregel, en met de
// sleutels in de body. Welke jortt wil verschilt per omgeving, dus we
// proberen ze allebei voordat we een fout melden.
async function probeerToken(inBody) {
  const id = process.env.JORTT_CLIENT_ID;
  const geheim = process.env.JORTT_CLIENT_SECRET;

  const kop = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  const body = { grant_type: 'client_credentials', scope: SCOPES };

  if (inBody) {
    body.client_id = id;
    body.client_secret = geheim;
  } else {
    kop.Authorization = `Basic ${Buffer.from(`${id}:${geheim}`).toString('base64')}`;
  }

  const res = await fetch(TOKEN_URL, { method: 'POST', headers: kop, body: new URLSearchParams(body) });
  const tekst = await res.text();
  let data = {};
  try { data = JSON.parse(tekst); } catch (e) { data = { rauw: tekst.slice(0, 200) }; }

  return { ok: res.ok, status: res.status, data };
}

async function haalToken() {
  if (!aan()) throw new Error('Jortt is niet gekoppeld. Zet JORTT_CLIENT_ID en JORTT_CLIENT_SECRET in Coolify.');
  if (token && Date.now() < tokenTot - 60000) return token;

  const pogingen = [];
  for (const inBody of [false, true]) {
    const uit = await probeerToken(inBody);
    if (uit.ok && uit.data.access_token) {
      token = uit.data.access_token;
      tokenTot = Date.now() + (Number(uit.data.expires_in || 7200) * 1000);
      return token;
    }
    pogingen.push(`${inBody ? 'sleutels in body' : 'sleutels in kopregel'}: ` + fout(uit.data, `HTTP ${uit.status}`));
  }

  throw new Error(`Inloggen bij jortt mislukte. ${pogingen.join(' | ')}`);
}

function fout(data, val) {
  const e = data && data.error;
  if (!e) {
    if (data && data.rauw) return `${val} \u2014 jortt antwoordde: ${data.rauw}`;
    return val;
  }

  // Bij het inloggen gebruikt jortt het standaard oauth-formaat: een korte
  // code als tekst, met een uitleg ernaast.
  if (typeof e === 'string') {
    const uitleg = data.error_description || data.message || '';
    if (e === 'invalid_client') {
      return `${val} \u2014 client ID of secret klopt niet. Controleer of ze zonder aanhalingstekens en zonder spaties in Coolify staan.`;
    }
    if (e === 'invalid_scope') {
      return `${val} \u2014 een van de rechten is niet aangevinkt bij de koppeling in jortt.`;
    }
    return `${val} \u2014 ${e}${uitleg ? `: ${uitleg}` : ''}`;
  }

  if (e.key === 'organization.requires_mkb_plan') {
    return 'Deze jortt-administratie heeft geen MKB- of Plus-abonnement, dus de API werkt niet.';
  }
  if (e.key === 'scopes.insufficient') {
    return 'De koppeling mist rechten. Vink in jortt de scopes voor facturen, klanten en organisatie aan.';
  }
  const detail = (e.details || []).map((d) => `${d.param} ${d.message}`).join(', ');
  return `${val}: ${e.message || e.key}${detail ? ` (${detail})` : ''}`;
}

async function vraag(pad, opties = {}) {
  const t = await haalToken();
  const res = await fetch(`${API}${pad}`, {
    ...opties,
    headers: {
      Authorization: `Bearer ${t}`,
      Accept: 'application/json',
      ...(opties.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opties.headers || {}),
    },
  });

  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(fout(data, `Jortt gaf een fout op ${pad}`));
  return data.data;
}

/* ── bedrijfsgegevens ──
   Hiermee hoeven KvK, btw-nummer en adres nergens in het portaal te staan.
   Jortt heeft dit endpoint in de loop van de tijd hernoemd, dus we proberen
   de varianten en onthouden welke werkte. */
const ORG_PADEN = ['/v3/organizations', '/v3/organization', '/v3/tradenames'];
let orgPad = null;

async function bedrijf() {
  if (!aan()) return null;

  const paden = orgPad ? [orgPad] : ORG_PADEN;
  const fouten = [];
  let data = null;

  for (const pad of paden) {
    try {
      data = await vraag(pad);
      orgPad = pad;
      break;
    } catch (e) {
      fouten.push(`${pad}: ${e.message}`);
    }
  }

  // Niets gelukt? Dan geven we de echte foutmeldingen door, anders sta je
  // te raden of het aan de sleutels, de rechten of het abonnement ligt.
  if (!data) throw new Error(fouten.join(' | '));

  const o = Array.isArray(data) ? data[0] : data;
  if (!o) throw new Error(`Jortt gaf een lege lijst terug op ${orgPad}.`);
  return {
    naam: o.company_name || o.name || '',
    kvk: o.coc_number || '',
    btw: o.vat_number || '',
    adres: o.address_street || '',
    postcode: o.address_postal_code || '',
    plaats: o.address_city || '',
    iban: o.iban || o.bank_account || '',
    email: o.email || '',
    telefoon: o.phonenumber || '',
  };
}

/* ── klanten ──
   Een factuur hangt in jortt aan een klant. Wij zoeken op naam en maken hem
   aan als hij er nog niet is. Het dossiernummer gaat mee als referentie, zodat
   je in jortt terugziet waar een klant vandaan komt. */
function zoekbaar(naam) {
  return String(naam || '').trim();
}

async function zoekKlant(naam) {
  const q = zoekbaar(naam);
  if (q.length < 3) return null;
  const lijst = await vraag(`/v3/customers?query=${encodeURIComponent(q)}`);
  if (!Array.isArray(lijst)) return null;
  const gelijk = lijst.find(
    (k) => String(k.customer_name || '').toLowerCase() === q.toLowerCase()
  );
  return gelijk || lijst[0] || null;
}

async function maakKlant(gegevens) {
  const zakelijk = gegevens.soort !== 'particulier';
  const body = {
    is_private: !zakelijk,
    customer_name: gegevens.naam,
    email: gegevens.email || undefined,
    phonenumber: gegevens.telefoon || undefined,
    payment_term: BETAALTERMIJN,
    invoice_language: 'nl',
    reference: gegevens.referentie || undefined,
    attn: gegevens.contactpersoon || undefined,
  };
  if (zakelijk) {
    body.address_street = gegevens.adres || '';
    body.address_postal_code = gegevens.postcode || '';
    body.address_city = gegevens.plaats || '';
    body.address_country_code = 'NL';
    if (gegevens.btwVerlegd && gegevens.btwNummer) {
      body.shift_vat = true;
      body.vat_number = gegevens.btwNummer;
    }
  }
  const res = await vraag('/v3/customers', { method: 'POST', body: JSON.stringify(body) });
  return res && res.id ? { id: res.id } : null;
}

async function klantVoor(gegevens) {
  const gevonden = await zoekKlant(gegevens.naam);
  if (gevonden) return gevonden.id;
  const nieuw = await maakKlant(gegevens);
  if (!nieuw) throw new Error(`Kon de klant ${gegevens.naam} niet aanmaken in jortt.`);
  return nieuw.id;
}

/* ── facturen ──
   Bedragen staan bij ons in centen, jortt wil een bedrag met twee decimalen.
   Zonder verzendmethode blijft de factuur een concept in jortt; dat is de stand
   waarin Tarish hem eerst nakijkt. */
function bedrag(centen) {
  return { amount: (Number(centen || 0) / 100).toFixed(2), currency: 'EUR' };
}

function regelsVoorJortt(regels, btwVerlegd) {
  return (regels || []).map((r) => ({
    description: r.omschrijving || r.oms || 'Werkzaamheden',
    quantity: String(r.aantal || 1),
    amount: bedrag(r.prijs),
    vat: { value: btwVerlegd ? '0' : String((Number(r.btw || 21) / 100).toFixed(2)) },
  }));
}

/**
 * Zet een factuur uit het portaal in jortt.
 *
 * @param {object} f       De factuur uit onze database
 * @param {object} klant   { naam, soort, email, adres, postcode, plaats, telefoon, contactpersoon, btwNummer }
 * @param {boolean} versturen  false = concept in jortt, true = jortt mailt hem
 */
async function zetFactuur(f, klant, versturen = false) {
  const customerId = await klantVoor({ ...klant, referentie: f.schadeNummer, btwVerlegd: f.btwVerlegd });

  const body = {
    customer_id: customerId,
    ...(TRADENAME ? { tradename_id: TRADENAME } : {}),
    invoice_date: new Date(f.datum || Date.now()).toISOString().slice(0, 10),
    payment_term: Number(f.termijn || BETAALTERMIJN),

    // Leverdatum is een maand, geen dag. Duurde het werk langer dan een maand,
    // dan stuurt jortt een periode mee.
    delivery_period_start: f.leverMaand || undefined,
    delivery_period_end: f.leverLang ? (f.leverTot || undefined) : undefined,
    payment_method: 'pay_later',
    // Onze regelprijzen zijn exclusief btw. Staat dit op false, dan rekent jortt
    // ze als inclusief en klopt het totaal niet meer.
    net_amounts: !f.bedragenIncl,
    line_items: regelsVoorJortt(f.regels, f.btwVerlegd),

    // Jortt kent twee referenties. De verkooporder is van ons -- daar zetten wij
    // het dossiernummer in. De inkooporder is van de klant, bijvoorbeeld het
    // opdrachtnummer van de VvE-beheerder.
    reference: f.verkooporder || f.schadeNummer || undefined,
    purchase_order: f.inkooporder || undefined,

    // Twee vrije teksten: introduction staat boven de regels, remarks eronder.
    introduction: f.intro || undefined,
    remarks: f.notitie || undefined,
  };
  if (versturen) body.send_method = 'email';

  const res = await vraag('/v3/invoices', { method: 'POST', body: JSON.stringify(body) });
  if (!res || !res.id) throw new Error('Jortt gaf geen factuur terug.');
  return { jorttId: res.id, customerId };
}

/** Haalt nummer en status op. Het nummer bestaat pas zodra de factuur verstuurd is. */
async function leesFactuur(jorttId) {
  const f = await vraag(`/v3/invoices/${jorttId}`);
  if (!f) return null;
  return {
    nummer: f.invoice_number || null,
    status: f.invoice_status || null,
    verstuurdAt: f.invoice_date_sent || null,
    vervaltAt: f.invoice_due_date || null,
    openstaand: f.invoice_due_amount ? Math.round(Number(f.invoice_due_amount.amount) * 100) : null,
    totaal: f.invoice_total_incl_vat ? Math.round(Number(f.invoice_total_incl_vat.amount) * 100) : null,
  };
}

/** Alle facturen die nog niet betaald zijn, voor de bewaking op het dashboard. */
async function openstaand() {
  const lijst = await vraag('/v3/invoices?invoice_status=unpaid');
  if (!Array.isArray(lijst)) return [];
  return lijst.map((f) => ({
    jorttId: f.id,
    nummer: f.invoice_number,
    naam: f.customer_company_name,
    referentie: f.reference || null,
    vervaltAt: f.invoice_due_date,
    openstaand: f.invoice_due_amount ? Math.round(Number(f.invoice_due_amount.amount) * 100) : 0,
    herinneringen: f.number_of_reminders_sent || 0,
  }));
}

// Alleen om te testen: haalt een token op en vertelt of dat lukte.
// Het token zelf geven we nooit terug.
async function tokenTest() {
  const t = await haalToken();
  return { ok: true, geldigTot: new Date(tokenTot).toISOString(), lengte: String(t).length };
}

module.exports = {
  aan, BETAALTERMIJN, TRADENAME, tokenTest,
  bedrijf, zoekKlant, maakKlant, klantVoor,
  zetFactuur, leesFactuur, openstaand,
};
