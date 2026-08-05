const prisma = require('../db');
const { verifyToken } = require('./jwt');
const { isDirectie, canInvoice } = require('./roles');

// Leest de httpOnly-cookie, verifieert de token en laadt de actuele gebruiker.
async function requireAuth(req, res, next) {
  try {
    const token = req.cookies && req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Niet ingelogd' });
    const payload = verifyToken(token);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.active) return res.status(401).json({ error: 'Account niet actief' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Sessie verlopen of ongeldig' });
  }
}

// Alleen directie (masterkey): omzet/winst, leveranciers toevoegen/verwijderen, gebruikersbeheer
function requireDirectie(req, res, next) {
  if (!req.user || !isDirectie(req.user)) {
    return res.status(403).json({ error: 'Alleen directie mag dit' });
  }
  next();
}

// Factureren: directie of financiële administratie
function requireInvoice(req, res, next) {
  if (!req.user || !canInvoice(req.user)) {
    return res.status(403).json({ error: 'Alleen directie of financiële administratie mag factureren' });
  }
  next();
}

module.exports = { requireAuth, requireDirectie, requireInvoice, isDirectie, canInvoice };
