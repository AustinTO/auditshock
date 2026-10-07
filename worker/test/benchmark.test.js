import { it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { sqliteDatabase, memoryBucket } from './helpers/sqlite';
import { parseCsvLedger } from '../src/parsers/csv';
import { ledgerMapping, processDocument, analyzeAudit } from '../src/analysis/audit';
it('reconciles published South Gate checks exactly and requires actual work-date evidence', async () => {
  const started = performance.now();
  const source = '../fixtures/public/south-gate-payments-2025-08-06';
  const content = readFileSync(source + '.csv', 'utf8');
  const expected = JSON.parse(readFileSync(source + '.expected.json', 'utf8'));
  const manifest = JSON.parse(readFileSync('../fixtures/public/manifest.json', 'utf8'));
  expect(createHash('sha256').update(content).digest('hex')).toBe(manifest.sources[0].sha256);
  const parsed = parseCsvLedger(content, ledgerMapping(content));
  expect(parsed).toHaveLength(expected.rows);
  expect(parsed.map(p => p.amountCents)).toEqual(expected.amounts_cents);
  expect(parsed.reduce((sum, p) => sum + p.amountCents, 0)).toBe(expected.total_cents);
  expect(parsed.every(p => p.paymentDate === expected.payment_date)).toBe(true);
  const db = sqliteDatabase(':memory:');
  try {
    for (const file of readdirSync('migrations').sort()) await db.batch(readFileSync(`migrations/${file}`, 'utf8').replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    await db.batch([
      db.prepare("INSERT INTO users (id,email) VALUES ('public-user','public@example.org')"),
      db.prepare("INSERT INTO audits (id,user_id,status,policy_period_start,policy_period_end) VALUES ('public-audit','public-user','DRAFT','2025-01-01','2025-12-31')"),
      db.prepare("INSERT INTO documents (id,audit_id,object_key,original_filename,mime_type,sha256,size_bytes,document_type,processing_status) VALUES ('public-doc','public-audit','public-key','payments.csv','text/csv','fixture',1,'VENDOR_LEDGER','UPLOADED')")
    ]);
    const bucket = memoryBucket(); await bucket.put('public-key', content);
    const env = { AUDITSHOCK_DB: db, AUDITSHOCK_DOCS: bucket };
    const doc = await db.prepare("SELECT * FROM documents WHERE id = 'public-doc'").first();
    await processDocument(env, 'public-audit', doc); await processDocument(env, 'public-audit', doc);
    expect(await analyzeAudit(env, 'public-audit')).toEqual({ status: 'NEEDS_INPUT', payments: 4, vendors: 4 });
    const stored = await db.prepare("SELECT COUNT(*) AS count,SUM(amount_cents) AS total FROM payments WHERE audit_id = 'public-audit'").first();
    expect(stored).toMatchObject({ count: expected.rows, total: expected.total_cents });
    const findings = (await db.prepare("SELECT * FROM findings WHERE audit_id = 'public-audit'").all()).results;
    expect(findings.every(f => f.kind === 'WORK_DATE_UNKNOWN' && f.amount_cents === null && JSON.parse(f.data_json).estimate === null)).toBe(true);
    console.info(JSON.stringify({ benchmark: 'south-gate-checks', rows: stored.count, totalCents: stored.total, centDifference: 0, duplicatePayments: 0, status: 'NEEDS_INPUT', elapsedMs: Math.round(performance.now() - started) }));
  } finally { db.close(); }
});
