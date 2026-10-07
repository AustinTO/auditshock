# Validation and release status

Validation date: 2026-10-07. This workspace is not a Git repository; no commit-based provenance is available. Signed Android artifacts were generated and the APK was installed on the connected OnePlus 6T. The user-approved production migrations and Worker deployment completed.

## Verified results

| Check | Result |
| --- | --- |
| Worker TypeScript and deployment bundle | Passed |
| Full backend/runtime suite | 62 tests passed in 9 files |
| Actual local Workerd, D1, R2 and Workflow | Public CSV upload, processing, source review, calculations, rerun and deletion passed |
| Flutter static analysis and regressions | Clean; 16 tests passed |
| Signed Android APK and AAB | Built successfully; signatures match the authorized existing key |
| Final APK installation and launch | OnePlus 6T; successful cold launch; no app errors in inspected runtime log |
| Full npm advisory audit | Zero advisories after patching existing Sharp to 0.35.5 |
| Public municipal reconciliation | 4 payments, 4 vendors, $89,594.00, zero cent discrepancy, no duplicate imports |
| Missing evidence behavior | Actual payments remain NEEDS_INPUT until work dates and assumptions are supplied |
| Synthetic rate/work-date scenario in real runtime | $89,594.00 exposure at an invented $5/$100 produces $4,479.70 |
| Live Workers AI production pipeline | Real historical certificate converted/classified; ambiguous layout routed to NEEDS_REVIEW; zero facts/coverage accepted |
| Original public PDF provenance | South Gate page 198 and ECWA page 32 text-extracted and visually verified against independent expected labels |
| Production D1/schema | Migrations 0003–0006 applied; no pending migrations |

Single-run timings: public CSV SQLite benchmark 21 ms; full Workerd workflow test 1,514 ms; live public-certificate ambiguity pipeline 1,492 ms. These are individual local/diagnostic measurements, not load tests or hosted-service latency guarantees. Artifact hashes and detailed results are in `validation-results.json`.

## Corrections and simplifications

- Edits acquire an exclusive, expiring audit lease; each D1 batch checks that lease inside the transaction. Lost leases roll back writes. Analysis cannot run through an active edit. Results from PROCESSING/FAILED audits are withheld.
- Workflow publication requires its current run ID. Legacy instances without run IDs fail safely and require a fresh analysis. Previously processed ledgers preserve human-entered work dates. Failed imports cannot publish successful findings.
- CSV imports validate every row before persistence, reuse a prefetched vendor map, bulk-insert ten payments per statement, and bound batches. Limits: 50 documents/100 MB per audit, 1,000 payments and 200 normalized vendors, and 100,000 characters of extraction text.
- Audit deletion queues object cleanup and removes database references in one guarded transaction before touching R2. Storage failures retry hourly; API returns cleanupPending. Unique upload object keys prevent stale cleanup from deleting replacement uploads.
- Authentication validates complete JSON roots, throttles concurrent code requests atomically, rejects malformed dates/tokens, and consumes codes once. Files reject unsafe filenames, binary text, mismatched binary extensions and malformed multipart requests. Unreferenced failed uploads are removed.
- Clef handles the observed hosted `noul` response. Structured extraction accepts text or structured JSON, has an explicit output budget, and requires schema/source evidence. Unreadable or ambiguous classification stops before facts are persisted.
- Workers AI runs directly by default. `AI_GATEWAY_ID` is optional; explicitly configured gateways disable logging/cache and remain mandatory for that configuration. There is no silent gateway fallback. See Cloudflare's [Workers AI data policy](https://developers.cloudflare.com/workers-ai/platform/data-usage/).
- Source-based manual coverage entry can recover failed extraction without silently accepting or discarding it. Mobile review/save and analysis submissions are protected against repetition and dismissal. Delayed 401 responses cannot erase a newer session. Small-screen/large-text layouts and authentication routing are tested.
- Android secure-storage automatic backup is disabled to prevent invalid restored encryption keys. Gradle memory/workers are bounded; release builds require real signing. The package is `com.puphr.auditshock`.
- The Sharp override fixes [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) in the existing toolchain without downgrading Wrangler or adding a new dependency.

## Real document limitations

The direct extraction diagnostic on the ECWA historical certificate got 6 of 9 critical fields correct after date normalization. It swapped the named insured and certificate holder and chose the wrong carrier because conversion flattened the form layout. This is evidence against automatic acceptance. The final production pipeline now rejects that document's readability/manual-review scores before extraction and persists zero structured facts or coverage records; the user must inspect the original source and enter coverage manually.

This single historical sample does not establish general extraction accuracy. Its policy expired in 2020, it has no relationship to the municipal payment vendors, and it cannot establish current insurance. Broader scans, adversarial layouts, held-out documents and independently labeled data are still needed for a production accuracy claim. Original PDFs remain in `/tmp`; expected labels/provenance are in the repository.

## Completed production rollout

The user explicitly approved the private backup and the rollout. The backup at `/tmp/auditshock-pre-hardening-backup.sql` has user-only 0600 permissions; a memory-only SQLite restore reports integrity `ok` and zero foreign-key errors. Backup SHA-256 is recorded in the results JSON. Automatic review initially required explicit authorization for the private export and production changes; both approvals were obtained before execution.

Migrations 0003–0006 applied successfully. Worker version `cf030cc0-0740-4120-aeab-fd4ccc67f539` is deployed at `https://auditshock-api.austintaylorodell.workers.dev` with the `auditshock-analysis` workflow and hourly object-cleanup cron. Health returns 200; unauthenticated audit access returns 401. No migrations remain pending.

The live API test used a dedicated temporary QA identity/session and public fixtures, without sending email or accessing existing customer audits. It exercised upload, actual hosted Workflow/D1/R2 processing, missing-input handling, explicit synthetic assumptions/work dates, reconciliation/estimation, historical PDF conversion/classification, manual-review routing, and deletion. The hosted public-data scenario took 23,539 ms before final cleanup. All four payments reconciled to $89,594.00; the controlled rate scenario produced $4,479.70. The historical certificate was not accepted as confirmed coverage.

QA data and objects were removed. Post-rollout aggregate checks match the original one audit/zero documents and show zero QA users, zero cleanup backlog, and zero active analyses. No existing customer audit was changed by validation.

## Remaining practical limits

- The user confirms the app is already signed in through email OTP, providing user-reported delivery/login evidence. No additional test email was sent, as requested; a fresh automated inbox check was not performed.
- The final signed APK installed and cold-launched on the OnePlus 6T. After rollout, its authenticated audit home was observed with no load error; the user confirms email OTP login. A complete physical-device file-picker/review flow was not exercised, while its widget/API regressions and hosted API workflow passed.
- A single historical certificate and four-payment sample do not establish broad extraction accuracy, current coverage, or production load/latency guarantees. Ambiguous documents require original-source review; do not auto-accept the demonstrated incorrect associations.
- Failed-upload cleanup failures can leave unreferenced blobs for maintenance, although unique keys prevent live-document corruption. Monitor storage and cleanup retries. Object deletion can be deferred during R2 failures and is reported as cleanupPending.
- Migration 0002 was already applied before this work. Editing that historical file cannot restore any previously deleted records. Legacy ownership recovery must verify account ownership and use appropriate historical backups.
- Apple/native platforms beyond the tested Android device are not release-verified. Keep signing material and the private database backup out of version control.
