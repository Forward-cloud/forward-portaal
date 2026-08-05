const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

const DEFAULT_PASSWORD = 'Welkom123!';

const users = [
  { naam: 'Tarish Navaratnam', email: 'tarish@forwardschadeherstel.nl', role: 'DIRECTIE' },
  { naam: 'Abdullah',          email: 'abdullah@forwardschadeherstel.nl', role: 'DIRECTIE' },
];

async function main() {
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 12);
  for (const u of users) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: { naam: u.naam, role: u.role },
      create: { ...u, passwordHash },
    });
  }
  console.log('Seed klaar.');
  console.log(`Wachtwoord voor beide accounts: ${DEFAULT_PASSWORD}`);
  for (const u of users) console.log(`  ${u.role}: ${u.email}`);
}

main().then(() => prisma.$disconnect()).catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
