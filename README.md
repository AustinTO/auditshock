# AuditShock

Workers' compensation audit preparation: reconcile vendor payments with reviewed coverage documents and calculate potential exposure under explicit, user-confirmed assumptions. Results describe documentary support; they do not establish legal insurance coverage or a carrier's assessed premium.

## Run locally

Requirements: Node.js 22.22 or later, npm, Flutter 3.44 / Dart 3.12 or compatible later SDKs. Node's built-in SQLite powers the API integration tests.

```sh
cd worker
npm ci
npx wrangler d1 migrations apply AUDITSHOCK_DB --local
npx wrangler dev
```

In another terminal:

```sh
cd mobile
flutter pub get
flutter run --dart-define=AUDITSHOCK_API_URL=http://localhost:8787/v1
```

Use the host address reachable by your emulator/device. Android release builds require HTTPS; local development on a device needs appropriate development networking. For web, configure `CORS_ORIGIN` in the Worker to the exact client origin.

## Workflow

1. Sign in using an emailed, single-use code. Codes expire after 15 minutes; attempts and requests are limited. Sessions expire after 30 days.
2. Create an audit and upload a CSV ledger, PDFs, images, or text documents. Uploads remain private; duplicate bytes within an audit are deduplicated. The app accepts files up to 10 MB; the API caps each file at 15 MB, each audit at 50 documents/100 MB, and reconciliation at 1,000 payments/200 normalized vendors.
3. Run analysis. CSV headers support vendor/payee/supplier, amount/payment amount, payment date/date, and memo/description. Monetary values must be exact cents; CSV dates must be `YYYY-MM-DD`. XLSX is unsupported: export a CSV first.
4. In the dashboard, set policy dates and a rate per $100, confirm full-payment exposure assumptions, enter actual work dates, and inspect original documents before confirming coverage fields and vendor identity. Payment dates are never automatically treated as work dates.
5. Run analysis again. Missing inputs produce `NEEDS_INPUT`; infrastructure errors produce `FAILED`. Estimates appear only when required evidence and assumptions are confirmed. Changes invalidate older findings. Audits can be reopened from the home screen.

Ambiguous or low-readability conversion is routed to source-based manual entry before any structured coverage facts are accepted. Only `FULL_VENDOR_PAYMENTS` exposure is implemented. Labor-only/custom exposure is explicitly rejected. Work crossing a policy boundary requires review rather than automatic allocation. AI output requires human confirmation and cannot independently establish coverage.

## Checks and evaluation

```sh
cd worker
npm run check
npm run test:runtime # actual local Workerd, D1, R2 and workflow; requires local sockets
npm audit
npm run build # bundle only; does not deploy
```

```sh
cd mobile
flutter analyze
flutter test
```

The public payment benchmark uses [four actual South Gate checks](fixtures/public/south-gate-payments-2025-08-06.csv), totaling $89,594.00. Source provenance, expected values, hashes, and limitations are in [the fixture manifest](fixtures/public/manifest.json) and [evaluation guide](docs/benchmark.md). The synthetic ledger independently totals $8,200.00. Default tests use SQLite and in-memory object storage; the runtime suite executes the compiled Worker and real workflow with actual local D1/R2. Separate opt-in public-data diagnostics exercised hosted AI, and the signed APK was installed/launched on a OnePlus 6T. The verified Worker and migrations are deployed; the user confirms OTP login. No extra test email was sent. The authenticated Android home and hosted API workflow were verified.

See [validation results and release blockers](docs/production-readiness.md). Local passing tests are not a claim that a production deployment or signed app has been verified.

## Production configuration

Configure D1, private R2, the workflow binding, Workers AI, and Email Service in `worker/wrangler.jsonc`. `EMAIL_FROM` must use an authorized sender. Workers AI runs directly by default; no AI Gateway is required. Set `AI_GATEWAY_ID` only if you want an existing gateway; gateway requests explicitly disable logging/cache. See Cloudflare's Workers AI data policy and check account retention settings separately. Apply migrations to a backed-up staging database before production.

Migration 0002 now preserves pre-auth audit data. Legacy installation owners receive placeholder `@legacy.invalid` accounts and need a verified ownership recovery process before accessing their old audits. If the original destructive migration already ran, this code cannot restore deleted data; recover from database backups. Migration 0003 invalidates older plaintext OTP codes.

Android ID: `com.puphr.auditshock`. Release signing reuses the authorized Shrinkflation/PadReset key through ignored `mobile/android/key.properties`; secrets and keystores must remain outside version control. See [client release instructions](mobile/README.md).
