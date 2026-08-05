const express = require('express');
const prisma = require('../db');
const { schadeForClient } = require('../lib/serialize');

const router = express.Router();

// Klant "logt in" met schadenummer + e-mail en krijgt alleen zijn eigen,
// klant-veilige dossier terug (nooit financiën, alleen vrijgegeven documenten).
router.post('/schade', async (req, res) => {
  const { nummer, email } = req.body || {};
  if (!nummer || !email) return res.status(400).json({ error: 'Schadenummer en e-mail vereist' });
  const s = await prisma.schade.findUnique({ where: { nummer: String(nummer).trim() } });
  if (!s || !s.email || s.email.toLowerCase().trim() !== String(email).toLowerCase().trim()) {
    return res.status(401).json({ error: 'Geen dossier gevonden bij dit schadenummer en e-mailadres' });
  }
  res.json({ schade: schadeForClient(s) });
});

module.exports = router;
