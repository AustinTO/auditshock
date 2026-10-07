# Reproducible evaluation

The fixture manifest distinguishes actual public payments, an official published insurance sample, and invented ledger transactions. A small factual payment snapshot is available as a derived CSV; no real customer policy was obtained; the original public warrant register PDF was downloaded and verified. Do not report synthetic results as real document accuracy.

## Available evidence

The [Erie County Water Authority contract appendix](https://www.ecwa.org/files/pdf/item_4_professional_services_contract_no__ghd-009.pdf) supplies a filled historical certificate. Original binary download, text extraction and visual inspection of PDF page 32 confirm the identity, carrier and WC policy dates in `fixtures/public/ecwa-coi-2020.expected.json`. The manifest records original SHA-256 and byte count. Evaluate page 32 alone using `/tmp/auditshock-ecwa-coi-page.txt`; other pages include contract clauses and different insurance types. The appendix is described as a sample, but this page has specific business details rather than placeholder identities. It does not establish current coverage or a relationship to the payment fixture. Source PDF remains outside version control because no redistribution license was verified.

`fixtures/public/south-gate-payments-2025-08-06.csv` contains four actual municipal checks, transcribed from the indexed table of the [City of South Gate warrant register](https://d3n9y02raazwpg.cloudfront.net/cityofsouthgate/d7780323-625b-11f0-b7f5-005056a89546-4f39a4e4-22ed-438f-9977-57609c5627e5-1755813272.pdf). The source is Part I, page labeled 1 (agenda page 198), for the August 26, 2025 council meeting. Its published subtotal independently reconciles to the four check totals: **$89,594.00 (8959400 cents)**. Dates are normalized to ISO and vendor-number prefixes removed. The final check combines two invoice payments; the fixture uses each check total once. Expected per-row amounts, count, and date are stored in the companion `.expected.json` file. The manifest records a SHA-256 of the derived CSV.

This is a transcription of public payment facts, not a copy of the original PDF or a synthetic ledger. The original 25 MB PDF was subsequently downloaded to `/tmp/auditshock-south-gate.pdf`. Poppler text extraction and rendered visual inspection of PDF page 198 independently confirm the check numbers, vendor names, dates, individual amounts and subtotal. The manifest records the original binary SHA-256 and byte count; it is not redistributed. These four checks are a limited slice of municipal spending and have no accompanying coverage documents. Their payment dates cannot establish work periods. The expected premium calculation is a controlled scenario with an invented $5-per-$100 rate, explicitly labeled synthetic.

[NYC DYCD's insurance sample package](https://www.nyc.gov/assets/dycd/downloads/pdf/Insurance-Sample-Package26.pdf) was readable through browser text extraction. Page 10 contains a workers compensation certificate sample; expected fields are in `fixtures/public/manifest.json`. The package has placeholder identities and multiple unrelated insurance forms. Visual inspection and PDF binary retrieval remain outstanding. Copyright notices are present; the PDF is deliberately not redistributed.

[Chicago Payments](https://catalog.data.gov/dataset/payments) is an actual municipal vendor payment dataset. The publisher describes daily updates and aggregation of older payments. A bounded API download URL is recorded in the manifest. Shell retrieval failed with DNS resolution error and the browser could not access the API endpoint. No rows, sums, or successful parsing results are asserted for this source.

## Fetch and freeze sources

Run from the repository root on a network-enabled machine:

```sh
curl --fail --location --max-time 60 'https://www.nyc.gov/assets/dycd/downloads/pdf/Insurance-Sample-Package26.pdf' -o /tmp/auditshock-insurance-samples.pdf
curl --fail --location --max-time 60 'https://data.cityofchicago.org/resource/s4vu-giwb.csv?$limit=25' -o /tmp/auditshock-chicago-payments.csv
sha256sum /tmp/auditshock-insurance-samples.pdf /tmp/auditshock-chicago-payments.csv
```

Record the hashes, retrieval timestamp, actual response headers, row count, and column names with each run. Keep source binaries outside version control until reuse terms are confirmed. Inspect the PDF visually and select page 10 before conversion; the complete package is a mixed document, not a single certificate. For payments, map the actual vendor, amount, and payment-date headers; independently calculate expected cents using decimal arithmetic before uploading. Preserve the original downloaded bytes and record any derived CSV transformation.

## Measurements and release gates

| Stage | Measurement | Required result |
| --- | --- | --- |
| Synthetic ledger | Parsed rows and sum | 4 rows, 820000 cents; punctuation in the quoted final vendor survives |
| Available South Gate public CSV | Four per-check amounts, ISO payment dates and sum | 4 rows, 8959400 cents; per-row equality with companion expected JSON |
| Actual payment snapshot | Parsed rows, vendor names, per-row amounts and total against independent labels | Exact reconciliation, zero dropped rows, zero cent differences |
| PDF conversion | Page selection, nonempty text, preservation of identifiers and dates | All labeled fields remain visible; retain conversion output |
| COI extraction | Exact match on the six labeled identity/date fields in the manifest | 6/6 with source excerpts; placeholder document routed to human review |
| Missing-field behavior | Absent or ambiguous values | Null with review; zero invented fields |
| Coverage rules | Controlled date boundary cases | Exact agreement with independent labels; public sample cannot document a real vendor |
| End-to-end upload | Accepted upload reaches terminal success or explicit failure | No stuck jobs; errors visible; repeat upload does not duplicate ledger exposure |

For each live run record application commit, model/version, source hashes, conversion output, expected and actual values, elapsed time, requests/cost, terminal status, and manual-review outcome. Run extraction at least three times to reveal model variation. Report field accuracy as correct supported fields / labeled fields and separately report invented fields and unhandled failures. Unit tests and local schema checks do not measure hosted AI accuracy or deployment health.

The official sample tests supported-field extraction and safe handling of placeholders. It cannot measure real vendor matching or insurance validity. The transcribed public CSV supplies real payment amounts for parsing and arithmetic evaluation, but cannot establish coverage or labor exposure. A production accuracy claim additionally requires consented, representative real policies and COIs, independent human labels, negative examples, scans, expired dates, and a held-out set. Choose sample size and acceptable error rates before evaluating; a single public sample provides a smoke check only.

## Observed live results, 2026-10-07

The full runtime suite passed 60 tests. Its compiled Worker/Workflow imported the public payment CSV through actual local D1 and R2, reconciled all four rows, and returned NEEDS_INPUT until explicit synthetic work-date/rate labels were entered. The controlled scenario then produced $4,479.70. These labels test calculations and are not facts about the public payments' labor or insurance.

Workers AI conversion/classification/extraction was exercised on the verified ECWA page. Direct structured extraction got 6/9 critical fields correct after calendar-date normalization; insured/holder were swapped and carrier was wrong. The converted text flattened the form. Final production code now gates the observed low-readability/manual-review scores before extraction: the live pipeline returned NEEDS_REVIEW, stored zero facts/coverage, and left the audit NEEDS_INPUT. This is the safe outcome; the sample did not pass an automatic-extraction accuracy gate.

The opt-in public-data scripts under `worker/scripts/` use Workers AI directly by default. Run only with `AUDITSHOCK_LIVE_AI=1`; optionally set `AUDITSHOCK_AI_GATEWAY_ID` for a configured gateway. Document scripts verify the original source SHA-256 and require the source in `/tmp`, plus Poppler. Bundle the TypeScript script with the installed esbuild before running. Usage is billed to the Cloudflare account; these scripts never send email or write production D1/R2. See `docs/validation-results.json` for timings, artifacts and current deployment limits.
