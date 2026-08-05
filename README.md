# Forward Schadeherstel — backend (fundament)

Echte backend met **database, inloggen en server-side rechten**. Dit is de minimale
live-kern (medewerkers + rollen, schades met financiële afscherming, documenten per
klant, logboek). We breiden dit module voor module uit.

## Wat je één keer installeert
- **Node.js 20+** — https://nodejs.org (kies de LTS-versie)
- **Docker Desktop** — https://www.docker.com/products/docker-desktop (draait de database lokaal)
- **Git** — https://git-scm.com

Controleer daarna in een terminal:
```
node -v
docker -v
git -v
```

## Lokaal draaien (stap voor stap)

1. **Instellingen klaarzetten**
   ```
   cp .env.example .env
   ```
   Open `.env` en zet bij `JWT_SECRET` een lange willekeurige tekst. Genereer er één met:
   ```
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

2. **Database starten** (PostgreSQL in Docker)
   ```
   docker compose up -d
   ```

3. **Pakketten installeren**
   ```
   npm install
   ```

4. **Tabellen aanmaken**
   ```
   npx prisma migrate dev --name init
   ```

5. **Demo-gegevens laden** (4 medewerkers + 2 schades)
   ```
   npm run db:seed
   ```

6. **Server starten**
   ```
   npm run dev
   ```
   Je ziet: `Forward-backend luistert op http://localhost:4000`

## Testen dat het werkt
Open een tweede terminal:
```
# leeft de server?
curl http://localhost:4000/api/health

# inloggen als directie (bewaart de cookie in cookies.txt)
curl -c cookies.txt -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"rick@forwardschadeherstel.nl","password":"Welkom123!"}'

# schades ophalen — directie ziet ook omzet/winst
curl -b cookies.txt http://localhost:4000/api/schades
```
Log daarna in als `sanne@...` (behandelaar) en haal opnieuw de schades op: de
velden `fin` en `profit` ontbreken dan — dat is de server-side afscherming.

## Inloggegevens (seed)
Wachtwoord voor iedereen: **Welkom123!**
- Directie: `rick@forwardschadeherstel.nl`
- Financiële administratie: `petra@forwardschadeherstel.nl`
- Schadebehandelaar: `sanne@forwardschadeherstel.nl`
- Planner: `youssef@forwardschadeherstel.nl`

## API in het kort
- `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me`
- `GET /api/schades` · `GET /api/schades/:nummer` · `POST /api/schades` · `PATCH /api/schades/:nummer`
- `PATCH /api/schades/:nummer/documents` (document delen/verbergen voor klant)
- `GET/POST/PATCH/DELETE /api/users` + `POST /api/users/:id/reset-password` (alleen directie)
- `POST /api/portal/schade` (klant: schadenummer + e-mail → eigen dossier)

## Handige commando's
- `npm run db:studio` — grafische database-verkenner (Prisma Studio)
- `docker compose down` — database stoppen
- `npm run db:seed` — demo-gegevens opnieuw laden
