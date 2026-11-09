# Email: sending, limits, audit and Brevo credentials

How the tournament backend sends email, how it protects the Brevo plan, and what to do with the
shared Brevo credentials. For whoever deploys or maintains the backend.

## Every email the backend sends

All email goes through one function, `deliverEmail` in `src/lib/emailService.ts`. Nothing else talks to SMTP.

| Email (kind) | Brevo subject | Triggered by | Budget category | Duplicate key |
|---|---|---|---|---|
| Verification code (`OTP`) | `123456 is your email verification code` | Player clicks Send code / Resend | `OTP` | `otp:<challenge>` |
| Registration successful (`REGISTRATION_SUCCESS`) | `Registration successful — TNJA-S-…` | Self-registration (Tamil Nadu), admin adds a player, admin adds a new player to a tournament, bulk import (only if confirmed) | `REGISTRATION` | `registration:<student>` |
| Application received (`APPLICATION_RECEIVED`) | `Application received — TMP-…` | Out-of-state registration or import | `REGISTRATION` | `registration:<student>` |
| Registration approved (`REGISTRATION_APPROVED`) | `Registration approved — …` | Admin approves an application | `ADMIN` | `approval:<student>` |
| Entry pass (`ENTRY_PASS`) | `Tournament Entry Pass(es) — <tournament>` | Online payment, admin marks paid, free event entered | `ENTRY_PASS` | `entry-pass:<entry ids>` |
| Password reset (`PASSWORD_RESET`) | `Reset your password` | Player uses Forgot password | `PASSWORD_RESET` | none (each request is new) |

There are **no cron jobs, schedulers or background workers** that send email. The tournament
`reminderAt` field and the `REMINDER`/`PAYMENT` email-log types are not used by any sending code.

Every message carries the headers `X-Mailin-Tag: tnja-tournament` and
`X-Mailin-custom: tnja-tournament|<kind>|<audit id>`, and a Message-ID of `<audit id>@<sender domain>`.
In Brevo's logs, filter by the tag `tnja-tournament` to separate this app's emails from other systems
on the same Brevo account.

## What happens to each email

1. **Audit row + duplicate guard.** An `EmailMessage` row is created under the email's idempotency key.
   If the key already exists and was sent (or might have been), nothing is sent again. Only
   `FAILED`, `HELD`, `LIMITED` and `SUPPRESSED` emails can be attempted again, and only one caller can
   claim each retry. If the database can't record the email, it is **not** sent.
2. **Development guard.** Outside production, emails go to the server console (see below).
3. **Suppression list.** Addresses that hard-bounced, were blocked or invalid, complained (spam) or
   unsubscribed are never emailed (`EmailSuppression`; filled from SMTP rejections and the Brevo webhook).
4. **Daily budget.** One email is taken from the category's daily limit with an atomic
   `UPDATE … WHERE sent < limit + extra`. That is safe across several server processes.
5. **SMTP**, with the single retry layer (below).
6. **Outcome recorded:** `SENT`, `FAILED`, `SUPPRESSED`, `HELD`, `LIMITED`, `UNCERTAIN` or `LOGGED`.

Never stored or logged in production: email bodies, OTP codes (the OTP's audit subject is the neutral
"Email verification code"), passwords or reset links.

## Development vs production

| Setting | Development machine | Production server |
|---|---|---|
| `EMAIL_TRANSPORT` | leave unset (→ console) | **`smtp`** (set it explicitly) |
| SMTP credentials | none — remove production credentials | this app's own Brevo SMTP key |
| `EMAIL_DEV_ALLOWLIST` | only if testing real delivery: your test mailbox or `@domain` | not used |

- Unset `EMAIL_TRANSPORT` means SMTP only for a production deployment (`NODE_ENV=production`, or
  `PUBLIC_SITE_URL` an https address that isn't localhost). Anywhere else, emails are written to the console.
- Even with `EMAIL_TRANSPORT=smtp` on a development machine, only addresses in `EMAIL_DEV_ALLOWLIST`
  are really emailed; everyone else goes to the console.
- On startup the server logs the transport in use, warns if production SMTP credentials are present on
  a development machine, and errors loudly if production is set to SMTP without credentials.
- The console shows email text (including codes) only in development; in production it logs the
  recipient and the neutral subject only.

## Retries and duplicates

- **One retry layer**, in `sendWithRetry` (`src/lib/emailTransport.ts`). The old second layer in the
  registration email was removed.
- Only **retryable** failures are retried, at most **2 more times**, waiting **1 s then 2 s** (with jitter):
  - the server answered 4xx (it did not accept the message);
  - the connection failed *before* the message was handed over (`CONN`, `EHLO`, `AUTH`, `MAIL FROM`, `RCPT TO`).
- **Never retried:**
  - 550/551/553 recipient rejections (the address is suppressed);
  - other 5xx (bad login, message too large);
  - a timeout or dropped connection *after* the message was handed over. That's recorded as
    **UNCERTAIN**: Brevo may have accepted it, so retrying could send it twice. Its credit stays
    counted, and later requests for the same email see it as already sent.
- A refused (not accepted) email gives its budget credit back.

**Limits of SMTP duplicate prevention**
- SMTP has no idempotency key, and neither does Brevo's SMTP relay. The protection is ours: the database
  key stops a second send, and we never resend after the hand-over. If Brevo accepted a message but the
  connection broke before it confirmed, we record UNCERTAIN instead of retrying. The person may get the
  email or may not, but never twice.
- A `SENDING` row left behind by a crash mid-send is treated as "may have been sent" and is not resent.
- The registration email issues a new temporary password before sending. A second request that arrives
  in the same instant as the first (before the first is recorded) could issue a second password; the
  duplicate guard then stops its email, so the emailed password would be stale. This is extremely
  unlikely (it needs two simultaneous registrations of the same student), and "Forgot password" fixes it.

## Daily budgets

Set in the backend `.env` (no built-in numbers):

```
EMAIL_DAILY_LIMIT_OTP=
EMAIL_DAILY_LIMIT_REGISTRATION=
EMAIL_DAILY_LIMIT_ENTRY_PASS=
EMAIL_DAILY_LIMIT_PASSWORD_RESET=
EMAIL_DAILY_LIMIT_ADMIN=
```

- Empty means no limit (still counted and shown); `0` switches that type off. Days reset at midnight, India time.
- Over the limit:
  - registration, application, approval and entry-pass emails are **HELD**. They appear on
    **Admin → Emails**, where an admin can "Allow more today" (recorded with their username) and
    "Send held emails". Each is regenerated fresh and sent once.
  - Verification codes and password resets are only useful straight away, so they're **refused**
    (`LIMITED`). The person sees "temporarily unavailable, try later". OTP failures don't count
    against their OTP limits.
- Bulk import shows the number of students, the number of emails, and today's remaining registration
  budget. It requires the admin to confirm that number, and sends nothing if more emails would go out
  than were confirmed.
- Example starting point for a 5,000/month plan (≈160/day): decide from your own traffic on
  Admin → Emails before setting limits.

## Brevo credentials: who uses them

Brevo credits belong to the **account**, so every system sending through it uses the same monthly plan.

| System | Uses the Brevo account? | Evidence | Action |
|---|---|---|---|
| Tournament backend (production) | Yes | `SMTP_HOST=smtp-relay.brevo.com` | Give it its own SMTP key |
| Main TNJA website backend | **Yes — the same SMTP login and key** | Fingerprints of `SMTP_USER`/`SMTP_PASS` match the tournament app's (checked on 10 Nov 2026 on a developer PC) | Give it its own SMTP key |
| Developer PC — tournament backend | Had the production key in `.env` | Now ignored (console); remove it | Delete `SMTP_*` from the local `.env` |
| Developer PC — main site backend (Docker `tnja_backend`) | **Yes, and it runs with `NODE_ENV=production`**, so a local copy can send real email | Container environment | Remove or replace its SMTP settings for local use |
| Staging | Unknown | No staging configuration found in the repos | Check, and use a separate key or console |
| Other integrations | Unknown | Check Brevo → SMTP & API → SMTP keys / API keys | Identify each key's owner |

**Plan to separate credentials (don't revoke anything until replacements are tested):**
1. In Brevo → SMTP & API → **SMTP keys**, create one key per production system:
   `tnja-tournament-prod`, `tnja-website-prod`.
2. Put the new key in each production server's `.env`, restart, send one real email from each
   (e.g. register yourself; request a password reset on the main site), and confirm it in Brevo's logs.
3. Development machines get **no** production key: console mode, or a free test SMTP such as Mailtrap.
4. Watch Brevo's logs for a few days, filtering by key and by the `tnja-tournament` tag. Anything still
   using the old shared key will show up there.
5. Only then revoke the old shared key. If anything breaks, its owner has been found.
6. Optionally move the tournament app to its own Brevo account, if you want a separate credit pool and
   separate reports.

## Deployment checklist (tournament backend)

1. Back up the database.
2. Deploy the code; `npm ci`; `npx prisma migrate deploy` (adds `EmailMessage`, `EmailDailyUsage`); `npx prisma generate`; `npm run build`.
3. In the production `.env`: `EMAIL_TRANSPORT=smtp`, and the `EMAIL_DAILY_LIMIT_*` values you chose.
4. Restart. The log should say `Email transport: SMTP (production deployment)`.
5. Deploy the frontend (new Admin → Emails page, import confirmation).
6. Register yourself once; check Admin → Emails shows the code and the registration email as `SENT`.
