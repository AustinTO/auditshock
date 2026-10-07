import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { sqliteDatabase, memoryBucket } from './helpers/sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { drainObjectCleanup } from '../src/storage/cleanup';
import { processDocument, analyzeAudit } from '../src/analysis/audit';
import { api } from '../src/api/index';
let directory, db, env, token, emailMessage, runtime;
async function request(path, body, auth = token, method = 'POST') {
  return api.request(path, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
}
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'auditshock-test-'));
  let bucket;
  if (process.env.AUDITSHOCK_WORKER_RUNTIME === '1') {
    const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
    runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2026-10-06', d1Databases: ['DB'], r2Buckets: ['DOCS'] }));
    db = await runtime.getD1Database('DB'); bucket = await runtime.getR2Bucket('DOCS');
  } else { db = sqliteDatabase(join(directory, 'test.sqlite')); bucket = memoryBucket(); }
  for (const file of readdirSync('migrations').sort()) {
    const sql = readFileSync(`migrations/${file}`, 'utf8').replace(/--[^\n]*/g, '');
    await db.batch(sql.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    if (file.startsWith('0001')) await db.batch([db.prepare("INSERT INTO installations (id, token_hash) VALUES ('legacy', 'legacy-token')"), db.prepare("INSERT INTO audits (id, installation_id, status) VALUES ('legacy-audit', 'legacy', 'DRAFT')"), db.prepare("INSERT INTO documents (id, audit_id, object_key, original_filename, mime_type, sha256, size_bytes, document_type, processing_status) VALUES ('legacy-doc','legacy-audit','legacy-key','legacy.csv','text/csv','legacy-sha',1,'VENDOR_LEDGER','UPLOADED')")]);
  }
  env = { AUDITSHOCK_DB: db, AUDITSHOCK_DOCS: bucket, EMAIL_FROM: 'test@example.org', EMAIL: { async send(message) { emailMessage = message; } }, AUDIT_WORKFLOW: { async create() { return {}; } } };
}, 30000);
afterAll(async () => { db?.close?.(); await runtime?.dispose(); if (directory) rmSync(directory, { recursive: true, force: true }); });
describe(process.env.AUDITSHOCK_WORKER_RUNTIME === '1' ? 'API with actual local D1 and R2' : 'API with real SQLite and in-memory document storage', () => {
  it('preserves pre-auth audit documents across migrations', async () => {
    expect((await db.prepare("SELECT user_id FROM audits WHERE id = 'legacy-audit'").first()).user_id).toBe('legacy');
    expect((await db.prepare("SELECT audit_id FROM documents WHERE id = 'legacy-doc'").first()).audit_id).toBe('legacy-audit');
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
  it('validates malformed requests and consumes hashed OTP only once', async () => {
    expect((await request('/auth/request-otp', { email: 'bad' })).status).toBe(400);
    expect((await request('/auth/request-otp', { email: ' Alice@Example.org ' })).status).toBe(200);
    expect(emailMessage.to).toBe('alice@example.org');
    const code = /\d{6}/.exec(emailMessage.text)[0];
    const stored = await db.prepare('SELECT code FROM otp_codes').first();
    expect(stored.code).not.toBe(code);
    expect((await request('/auth/request-otp', { email: 'alice@example.org' })).status).toBe(429);
    const response = await request('/auth/verify-otp', { email: 'alice@example.org', code });
    expect(response.status).toBe(200); token = (await response.json()).token;
    expect((await request('/auth/verify-otp', { email: 'alice@example.org', code })).status).toBe(400);
  });
  it('enforces ownership, validates periods, rejects empty analysis and supports settings', async () => {
    expect((await request('/audits', { name: 'Invalid', policy_period_start: '2026-02-30' })).status).toBe(400);
    const response = await request('/audits', { name: 'Regression' }); expect(response.status).toBe(200);
    const { auditId } = await response.json();
    expect((await request(`/audits/${auditId}/analyze`)).status).toBe(400);
    expect((await request(`/audits/${auditId}`, { name: 'Renamed without dates' }, token, 'PATCH')).status).toBe(200);
    expect((await request(`/audits/${auditId}`, undefined, 'ashk_' + '0'.repeat(64), 'GET')).status).toBe(401);
    expect((await request(`/audits/${auditId}`, { policy_period_start: '2026-01-01', policy_period_end: '2026-12-31', exposure_basis: 'FULL_VENDOR_PAYMENTS', wc_rate_micros_per_100: 5000000, assumptions_confirmed: true }, token, 'PATCH')).status).toBe(200);
    expect((await request(`/audits/${auditId}/results`, undefined, token, 'GET')).status).toBe(200);
    expect((await request(`/audits/${auditId}`, undefined, token, 'DELETE')).status).toBe(200);
  });
  it('reconciles a real SQL ledger workflow, deduplicates uploads, and clears stale estimates', async () => {
    const { auditId } = await (await request('/audits', { name: 'Measured fixture' })).json();
    const form = () => { const value = new FormData(); value.set('file', new File([readFileSync('../fixtures/synthetic/ledger.csv')], 'ledger.csv', { type: 'text/csv' })); return value; };
    const upload = () => api.request(`/audits/${auditId}/documents`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form() }, env);
    const original = await upload(); expect(original.status).toBe(200);
    const { docId } = await original.json();
    expect((await (await upload()).json()).docId).toBe(docId);
    const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').bind(docId).first();
    await processDocument(env, auditId, doc);
    await processDocument(env, auditId, doc);
    let summary = await analyzeAudit(env, auditId); expect(summary).toMatchObject({ status: 'NEEDS_INPUT', payments: 4, vendors: 3 });
    const payments = (await db.prepare('SELECT * FROM payments WHERE audit_id = ?').bind(auditId).all()).results;
    expect(payments.reduce((sum, p) => sum + p.amount_cents, 0)).toBe(820000);
    await request(`/audits/${auditId}`, { policy_period_start: '2026-01-01', policy_period_end: '2026-12-31', exposure_basis: 'FULL_VENDOR_PAYMENTS', wc_rate_micros_per_100: 5000000, assumptions_confirmed: true }, token, 'PATCH');
    for (const payment of payments) expect((await request(`/audits/${auditId}/payments/${payment.id}`, { work_start_date: payment.payment_date, work_end_date: payment.payment_date }, token, 'PATCH')).status).toBe(200);
    summary = await analyzeAudit(env, auditId); expect(summary.status).toBe('COMPLETE');
    const findings = (await db.prepare('SELECT * FROM findings WHERE audit_id = ?').bind(auditId).all()).results;
    expect(findings.reduce((sum, f) => sum + f.amount_cents, 0)).toBe(820000);
    expect(findings.reduce((sum, f) => sum + JSON.parse(f.data_json).estimate.estimatedPremiumImpactCents, 0)).toBe(41000);
    // The work dates above are synthetic human labels, never inferred from payment dates by the application.
    await request(`/audits/${auditId}/payments/${payments[0].id}`, { work_start_date: '2026-01-01', work_end_date: '2026-01-02' }, token, 'PATCH');
    expect((await db.prepare('SELECT status FROM audits WHERE id = ?').bind(auditId).first()).status).toBe('NEEDS_INPUT');
    expect((await db.prepare('SELECT * FROM findings WHERE audit_id = ?').bind(auditId).all()).results).toHaveLength(0);
  });
  it('only applies human-confirmed coverage and prevents another user from reading or editing it', async () => {
    const audit = await db.prepare("SELECT id FROM audits WHERE name = 'Measured fixture'").first();
    const vendor = await db.prepare("SELECT id FROM vendors WHERE audit_id = ? AND normalized_name = 'smith roofing'").bind(audit.id).first();
    await db.batch([
      db.prepare("INSERT INTO documents (id,audit_id,object_key,original_filename,mime_type,sha256,size_bytes,document_type,processing_status,markdown_object_key) VALUES ('review-doc',?,'review-key','certificate.pdf','application/pdf','review-fixture',1,'coi','NEEDS_REVIEW','review-markdown')").bind(audit.id),
      db.prepare("INSERT INTO coverage_records (id,audit_id,source_document_id,named_insured,normalized_named_insured,review_status) VALUES ('review-coverage',?,'review-doc','Smith Roofing LLC','smith roofing','NEEDS_REVIEW')").bind(audit.id)
    ]);
    expect((await analyzeAudit(env, audit.id)).status).toBe('NEEDS_INPUT');
    const confirmed = await request(`/audits/${audit.id}/coverage/review-coverage/confirm`, { vendor_id: vendor.id, named_insured: 'Smith Roofing LLC', effective_date: '2026-01-01', expiration_date: '2026-12-31', wc_section_present: true, wc_coverage_indicated: true });
    expect(confirmed.status).toBe(200);
    expect((await analyzeAudit(env, audit.id)).status).toBe('COMPLETE');
    const coveredFinding = await db.prepare('SELECT amount_cents,kind FROM findings WHERE audit_id = ? AND vendor_id = ?').bind(audit.id,vendor.id).first();
    expect(coveredFinding).toMatchObject({ amount_cents: 0, kind: 'DOCUMENTED_FOR_PERIOD' });
    const otherToken = 'ashk_' + 'a'.repeat(64);
    const tokenHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(otherToken))), b => b.toString(16).padStart(2,'0')).join('');
    await db.batch([db.prepare("INSERT INTO users (id,email) VALUES ('other','other@example.org')"), db.prepare("INSERT INTO sessions (id,token_hash,user_id,expires_at) VALUES ('other-session',?,'other',?)").bind(tokenHash,new Date(Date.now()+86400000).toISOString())]);
    expect((await request(`/audits/${audit.id}/results`, undefined, otherToken, 'GET')).status).toBe(404);
    expect((await request(`/audits/${audit.id}/payments/any`, { work_start_date:'2026-01-01',work_end_date:'2026-01-01' }, otherToken,'PATCH')).status).toBe(404);
    expect((await request('/auth/logout', {}, otherToken)).status).toBe(200);
    expect((await request('/audits', undefined, otherToken, 'GET')).status).toBe(401);
  });
  it('rejects null/array auth roots and atomically throttles concurrent OTP requests', async () => {
    for (const body of [null, [], 1, 'text']) {
      expect((await request('/auth/request-otp',body)).status).toBe(400);
      expect((await request('/auth/verify-otp',body)).status).toBe(400);
    }
    const requests = await Promise.all([request('/auth/request-otp',{email:'concurrent@example.org'}),request('/auth/request-otp',{email:'concurrent@example.org'})]);
    expect(requests.map(r => r.status).sort()).toEqual([200,429]);
    const active = await db.prepare('SELECT COUNT(*) AS count FROM otp_codes WHERE email = ? AND used = 0').bind('concurrent@example.org').first();
    expect(active.count).toBe(1);
  });
  it('blocks analysis during an upload and rejects a lost edit lease without partial DB writes', async () => {
    const audit = await db.prepare("SELECT id FROM audits WHERE name = 'Measured fixture'").first();
    const originalBucket = env.AUDITSHOCK_DOCS;
    const originalPut = originalBucket.put.bind(originalBucket);
    let begin, release;
    const started = new Promise(resolve => {begin=resolve;});
    const barrier = new Promise(resolve => {release=resolve;});
    env.AUDITSHOCK_DOCS = { put: async (...args) => {begin();await barrier;return originalPut(...args);}, get: originalBucket.get.bind(originalBucket), delete: originalBucket.delete.bind(originalBucket) };
    const form = new FormData();form.set('file',new File(['Vendor,Amount\nAdditional,1.00\n'],'concurrent.csv',{type:'text/csv'}));
    const uploading = api.request(`/audits/${audit.id}/documents`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:form},env);
    await started;
    expect((await request(`/audits/${audit.id}/analyze`)).status).toBe(409);
    // Simulate the old lease expiring and another edit obtaining ownership.
    await db.prepare("UPDATE audits SET mutation_lease_id = 'replacement', mutation_expires_at = ? WHERE id = ?").bind(Date.now()+60000,audit.id).run();
    release();expect((await uploading).status).toBe(409);
    env.AUDITSHOCK_DOCS = originalBucket;
    expect((await db.prepare("SELECT COUNT(*) AS count FROM documents WHERE audit_id = ? AND original_filename = 'concurrent.csv'").bind(audit.id).first()).count).toBe(0);
    await db.prepare("UPDATE audits SET status = 'NEEDS_INPUT',mutation_lease_id=NULL,mutation_expires_at=NULL WHERE id = ?").bind(audit.id).run();
  });
  it('requires explicit source-based manual coverage after extraction failure', async () => {
    const audit = await db.prepare("SELECT id FROM audits WHERE name = 'Measured fixture'").first();
    const vendor = await db.prepare('SELECT id FROM vendors WHERE audit_id = ? LIMIT 1').bind(audit.id).first();
    await db.prepare("INSERT INTO documents (id,audit_id,object_key,original_filename,mime_type,sha256,size_bytes,document_type,processing_status,markdown_object_key,review_error) VALUES ('manual-doc',?,'manual-key','manual.pdf','application/pdf','manual-sha',1,'coi','NEEDS_REVIEW','manual-markdown','AI_EXTRACTION_REQUIRES_REVIEW')").bind(audit.id).run();
    expect((await request(`/audits/${audit.id}/documents/manual-doc/confirm`,{confirmed:true})).status).toBe(400);
    expect((await request(`/audits/${audit.id}/documents/manual-doc/coverage`,{vendor_id:vendor.id,named_insured:'Reviewed Company',effective_date:'2026-01-01',expiration_date:'2026-12-31',wc_section_present:true,wc_coverage_indicated:true})).status).toBe(200);
    const doc = await db.prepare("SELECT processing_status,review_error FROM documents WHERE id = 'manual-doc'").first();
    expect(doc).toMatchObject({processing_status:'PROCESSED',review_error:null});
    expect((await db.prepare("SELECT review_status FROM coverage_records WHERE source_document_id = 'manual-doc'").first()).review_status).toBe('CONFIRMED');
  });
  it('clears findings at analysis dispatch and keeps a failed dispatch explicit', async () => {
    const audit = await db.prepare("SELECT id FROM audits WHERE name = 'Measured fixture'").first();
    await analyzeAudit(env,audit.id);
    const original = env.AUDIT_WORKFLOW.create;
    env.AUDIT_WORKFLOW.create = async () => {throw new Error('TEST_DISPATCH_FAILURE');};
    expect((await request(`/audits/${audit.id}/analyze`)).status).toBe(500);
    env.AUDIT_WORKFLOW.create = original;
    const results = await (await request(`/audits/${audit.id}/results`,undefined,token,'GET')).json();
    expect(results.audit.status).toBe('FAILED');expect(results.findings).toEqual([]);
    expect(results.audit.workflow_id).toBeTruthy();
  });
  it('rejects malformed multipart data, misleading binary extensions, and binary CSV', async () => {
    const audit = await db.prepare("SELECT id FROM audits WHERE name = 'Measured fixture'").first();
    const upload = async (name,content) => {const form=new FormData();form.set('file',new File([content],name));return api.request(`/audits/${audit.id}/documents`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:form},env);};
    expect((await upload('false.pdf','not a PDF')).status).toBe(415);
    expect((await upload('bad.csv',new Uint8Array([255,0]))).status).toBe(415);
    expect((await upload('../bad.csv','Vendor,Amount\nA,1.00')).status).toBe(400);
    expect((await api.request(`/audits/${audit.id}/documents`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'multipart/form-data'},body:'broken'},env)).status).toBe(400);
  });
  it('commits audit removal before retryable object deletion', async () => {
    const {auditId}=await(await request('/audits',{name:'Cleanup failure'})).json();
    const form=new FormData();form.set('file',new File(['Vendor,Amount\nCleanup,1.00\n'],'cleanup.csv',{type:'text/csv'}));
    const {docId}=await(await api.request(`/audits/${auditId}/documents`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:form},env)).json();
    const doc=await db.prepare('SELECT object_key FROM documents WHERE id = ?').bind(docId).first();
    const original=env.AUDITSHOCK_DOCS;
    env.AUDITSHOCK_DOCS={put:original.put.bind(original),get:original.get.bind(original),delete:async()=>{throw new Error('TEST_STORAGE_FAILURE');}};
    const deleted=await request(`/audits/${auditId}`,undefined,token,'DELETE');expect(deleted.status).toBe(202);expect(await deleted.json()).toMatchObject({success:true,cleanupPending:true});
    expect(await db.prepare('SELECT id FROM audits WHERE id = ?').bind(auditId).first()).toBeNull();
    expect(await original.get(doc.object_key)).not.toBeNull();
    expect((await db.prepare('SELECT COUNT(*) AS count FROM object_cleanup WHERE object_key = ?').bind(doc.object_key).first()).count).toBe(1);
    env.AUDITSHOCK_DOCS=original;await drainObjectCleanup(env);
    expect(await original.get(doc.object_key)).toBeNull();
    expect((await db.prepare('SELECT COUNT(*) AS count FROM object_cleanup').first()).count).toBe(0);
  });
  it('reclaims an expired edit for analysis without allowing its old finally block to unlock the run', async () => {
    const {auditId}=await(await request('/audits',{name:'Expired edit'})).json();
    const form=new FormData();form.set('file',new File(['Vendor,Amount\nLease,1.00\n'],'lease.csv',{type:'text/csv'}));
    await api.request(`/audits/${auditId}/documents`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:form},env);
    await db.prepare("UPDATE audits SET status='EDITING',mutation_lease_id='stale-lease',mutation_expires_at=? WHERE id=?").bind(Date.now()-1000,auditId).run();
    expect((await request(`/audits/${auditId}/analyze`)).status).toBe(200);
    const state=await db.prepare('SELECT status,mutation_lease_id FROM audits WHERE id=?').bind(auditId).first();
    expect(state).toMatchObject({status:'PROCESSING',mutation_lease_id:null});
    await db.prepare("UPDATE audits SET status='NEEDS_INPUT' WHERE id=? AND mutation_lease_id='stale-lease'").bind(auditId).run();
    expect((await db.prepare('SELECT status FROM audits WHERE id=?').bind(auditId).first()).status).toBe('PROCESSING');
    await db.prepare("UPDATE audits SET status='FAILED' WHERE id=?").bind(auditId).run();
  });
  it('locks a code after five wrong attempts', async () => {
    await request('/auth/request-otp', { email: 'locked@example.org' });
    const code = /\d{6}/.exec(emailMessage.text)[0];
    const wrong = code === '000000' ? '999999' : '000000';
    for (let i = 0; i < 5; i++) expect((await request('/auth/verify-otp', { email: 'locked@example.org', code: wrong })).status).toBe(400);
    expect((await request('/auth/verify-otp', { email: 'locked@example.org', code })).status).toBe(400);
  });
});
