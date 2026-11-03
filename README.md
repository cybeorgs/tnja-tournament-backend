# Tournament API

Standalone backend for the tournament module: organiser login, tournaments, student and
referee registration, draws and scoring, certificates, and publishing. It has its own
database and no approval workflow — a logged-in admin controls everything.

Stack: Node 22, Express 5, TypeScript, Prisma 6, PostgreSQL, pdf-lib, Razorpay.

## Setup

```bash
cp .env.example .env          # then fill in DATABASE_URL, JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD
npm install
npx prisma migrate deploy     # creates the tables (first time: `npx prisma migrate dev --name init`)
npm run dev                   # http://localhost:9100
```

On first start, if no admin exists, one is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
To add an admin or reset a password later:

```bash
npm run admin:create -- <username> <password>
```

Run the engine tests (no database needed): `npm test`.

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string for this app's own database |
| `PORT` | API port (default 9100) |
| `CORS_ORIGINS` | Comma-separated frontend origins |
| `JWT_SECRET` | At least 32 random characters |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | First admin account |
| `PUBLIC_SITE_URL` | Printed on certificates as the verification address |

## Workflow and endpoints

All routes are under `/api`. Everything except `/auth/login` and `/public/*` needs
`Authorization: Bearer <token>`.

1. **Login** — `POST /auth/login`, `GET /auth/me`, `POST /auth/change-password`
2. **Tournaments** — `GET/POST /tournaments`, `GET/PUT/DELETE /tournaments/:id`
3. **Students** — master list `GET/POST/PUT/DELETE /students`; entries `GET/POST/PUT/DELETE /tournaments/:id/registrations`.
   Age group is checked from the birth year (tournament year − birth year) and the weight class is worked out from the weight.
4. **Payments** — `POST .../registrations/:regId/payment/order` + `.../payment/verify` (Razorpay), or `PATCH .../payment` for cash / UPI / waived
5. **Referees** — master list `/referees`; assignments `GET/POST/PUT/DELETE /tournaments/:id/officials`
6. **Draws** — `GET /tournaments/:id/categories`, `POST /tournaments/:id/draws` (one category), `POST /tournaments/:id/draws/generate-all`.
   Five or fewer entrants → round robin, otherwise IJF elimination with seeding, BYEs and a bronze match.
7. **Scoring** — `POST /draws/:drawId/matches/:matchId/result`, `DELETE` to undo. Winners advance automatically; semi-final losers go to the bronze match.
8. **Conclude** — `POST /draws/:drawId/conclude` (optionally with placement overrides), `POST /draws/:drawId/reopen`
9. **Certificates** — `GET /tournaments/:id/registrations/:regId/certificate`, `GET /tournaments/:id/officials/:officialId/certificate`,
   bulk `GET /tournaments/:id/certificates?kind=students|officials&drawId=`. Add `download=0` to open inline. Organisers can print at any time.
10. **Publish** — `POST /tournaments/:id/status` with `action`: `publish`, `unpublish`, `publishResults`, `hideResults`, `complete`, `reopen`

Public (no login): `/public/tournaments`, `/public/tournaments/:slug`, `/public/tournaments/:slug/certificate-lookup`
(name + date of birth, or name + phone for officials), `/public/verify/:certificateNo`, `/public/certificates/:certificateNo`,
`/public/settings`, `/public/logo`, `/public/meta`.

White-label settings (organisation name, logo, signatories) are edited at `PUT /settings` and `PUT /settings/logo`.
