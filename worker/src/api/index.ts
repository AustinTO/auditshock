import { Hono } from 'hono';
import { Bindings, Variables } from '../types/env';
import { auditMutationMiddleware, atomicMutation, MutationConflict } from './mutation';
import { authMiddleware } from './middleware';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { bodyLimit } from 'hono/body-limit';
import { normalizeName } from '../matching/normalize-name';
import { drainObjectCleanup } from '../storage/cleanup';
import { createAuditSchema, updateAuditSchema } from '../types/schema';

const coverageReviewSchema = z.object({ vendor_id: z.string().min(1).max(128), named_insured: z.string().trim().min(1).max(500), effective_date: z.string(), expiration_date: z.string(), wc_section_present: z.boolean(), wc_coverage_indicated: z.boolean() });
const emailSchema = z.string().trim().toLowerCase().email().max(254);
async function hash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).map(b => b.toString(16).padStart(2, '0')).join('');
}


export const api = new Hono<{ Bindings: Bindings; Variables: Variables }>();

api.use('/audits', bodyLimit({ maxSize: 4096 }));
api.use('/auth/*', bodyLimit({ maxSize: 4096 }));
api.use('/audits/*', bodyLimit({ maxSize: 16 * 1024 * 1024 }));
api.onError((error, c) => {
  if (error instanceof MutationConflict) return c.json({ error: 'Audit changed during operation. Retry.' }, 409);
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: 'Invalid request' }, 400);
  console.error('Request failed', error.name);
  return c.json({ error: 'Request failed. Please try again.' }, 500);
});

api.post('/auth/request-otp', async (c) => {
  const { email } = z.object({ email: emailSchema }).parse(await c.req.json());
  const now = Date.now();
  const windowEnd = (Math.floor(now / 900000) + 1) * 900000;
  const bucketKey = await hash((c.req.header('CF-Connecting-IP') ?? 'local') + ':' + windowEnd);
  const limit = await c.env.AUDITSHOCK_DB.prepare('INSERT INTO auth_request_limits (bucket_key, requests, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket_key) DO UPDATE SET requests = requests + 1 RETURNING requests').bind(bucketKey, windowEnd).first<{ requests: number }>();
  if (!limit || limit.requests > 10) return c.json({ error: 'Too many login requests. Try again later.' }, 429);
  await c.env.AUDITSHOCK_DB.prepare('DELETE FROM auth_request_limits WHERE expires_at < ?').bind(now).run();
  await c.env.AUDITSHOCK_DB.prepare('DELETE FROM otp_codes WHERE expires_at < ?').bind(new Date(now - 86400000).toISOString()).run();
  const emailLimit = await c.env.AUDITSHOCK_DB.prepare('INSERT INTO auth_email_limits (email, next_request_at) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET next_request_at = excluded.next_request_at WHERE auth_email_limits.next_request_at <= ? RETURNING email').bind(email, now + 60000, now).first();
  if (!emailLimit) return c.json({ error: 'Please wait before requesting another code' }, 429);
  await c.env.AUDITSHOCK_DB.prepare('DELETE FROM auth_email_limits WHERE next_request_at < ?').bind(now - 86400000).run();
  const recent = await c.env.AUDITSHOCK_DB.prepare('SELECT expires_at FROM otp_codes WHERE email = ? ORDER BY expires_at DESC LIMIT 1').bind(email).first<{ expires_at: string }>();
  if (recent && Date.parse(recent.expires_at) > now + 14 * 60 * 1000) return c.json({ error: 'Please wait before requesting another code' }, 429);
  const random = new Uint32Array(1);
  do { crypto.getRandomValues(random); } while (random[0]! >= 4294800000);
  const code = String(100000 + random[0]! % 900000);
  const id = uuidv4();
  await c.env.AUDITSHOCK_DB.batch([
    c.env.AUDITSHOCK_DB.prepare('UPDATE otp_codes SET used = 1 WHERE email = ?').bind(email),
    c.env.AUDITSHOCK_DB.prepare('INSERT INTO otp_codes (id, email, code, expires_at) VALUES (?, ?, ?, ?)').bind(id, email, await hash(id + ':' + code), new Date(now + 15 * 60 * 1000).toISOString())
  ]);
  try {
    await c.env.EMAIL.send({ from: c.env.EMAIL_FROM, to: email, subject: 'Your AuditShock Login Code', text: `Your AuditShock Login Code is: ${code}` });
  } catch {
    await c.env.AUDITSHOCK_DB.prepare('UPDATE otp_codes SET used = 1 WHERE id = ?').bind(id).run();
    return c.json({ error: 'Unable to deliver login code' }, 503);
  }
  return c.json({ success: true });
});

api.post('/auth/verify-otp', async (c) => {
  const { email, code } = z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/) }).parse(await c.req.json());
  const record = await c.env.AUDITSHOCK_DB.prepare('SELECT id, code, expires_at, attempts FROM otp_codes WHERE email = ? AND used = 0 ORDER BY expires_at DESC LIMIT 1').bind(email).first<{ id: string; code: string; expires_at: string; attempts: number }>();
  if (!record || record.attempts >= 5 || !Number.isFinite(Date.parse(record.expires_at)) || Date.parse(record.expires_at) <= Date.now()) return c.json({ error: 'Invalid or expired code' }, 400);
  const attempt = await c.env.AUDITSHOCK_DB.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ? AND used = 0 AND attempts < 5 RETURNING id').bind(record.id).first();
  if (!attempt || await hash(record.id + ':' + code) !== record.code) return c.json({ error: 'Invalid or expired code' }, 400);
  const claimed = await c.env.AUDITSHOCK_DB.prepare('UPDATE otp_codes SET used = 1 WHERE id = ? AND used = 0 RETURNING id').bind(record.id).first();
  if (!claimed) return c.json({ error: 'Invalid or expired code' }, 400);
  await c.env.AUDITSHOCK_DB.prepare('INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT(email) DO NOTHING').bind(uuidv4(), email).run();
  const user = await c.env.AUDITSHOCK_DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
  if (!user) throw new Error('Unable to create user');
  const token = 'ashk_' + (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
  await c.env.AUDITSHOCK_DB.prepare('INSERT INTO sessions (id, token_hash, user_id, expires_at) VALUES (?, ?, ?, ?)').bind(uuidv4(), await hash(token), user.id, new Date(Date.now() + 30 * 86400000).toISOString()).run();
  return c.json({ token });
});

// Protected routes
const protectedApi = new Hono<{ Bindings: Bindings; Variables: Variables }>();
protectedApi.use('*', authMiddleware);
protectedApi.use('*', auditMutationMiddleware);

protectedApi.post('/auth/logout', async (c) => {
  const token = c.req.header('Authorization')!.slice(7);
  await c.env.AUDITSHOCK_DB.prepare('DELETE FROM sessions WHERE token_hash = ? AND user_id = ?').bind(await hash(token), c.get('userId')).run();
  return c.json({ success: true });
});
protectedApi.get('/audits', async (c) => {
  const { results } = await c.env.AUDITSHOCK_DB.prepare('SELECT id, name, status, created_at FROM audits WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100').bind(c.get('userId')).all();
  return c.json({ audits: results });
});

protectedApi.post('/audits', async (c) => {
  const userId = c.get('userId');
  const auditId = uuidv4();
  const body = createAuditSchema.parse(await c.req.json());

  await c.env.AUDITSHOCK_DB.prepare(
    `INSERT INTO audits (id, user_id, status, name, policy_period_start, policy_period_end)
     VALUES (?, ?, 'DRAFT', ?, ?, ?)`
  ).bind(auditId, userId, body.name || null, body.policy_period_start || null, body.policy_period_end || null).run();

  return c.json({ auditId, status: 'DRAFT' });
});

protectedApi.get('/audits/:auditId', async (c) => {
  const auditId = c.req.param('auditId');
  const userId = c.get('userId');

  const result = await c.env.AUDITSHOCK_DB.prepare(
    'SELECT * FROM audits WHERE id = ? AND user_id = ?'
  ).bind(auditId, userId).first();

  if (!result) return c.json({ error: 'Not found' }, 404);
  return c.json({ audit: result });
});

protectedApi.post('/audits/:auditId/documents', async (c) => {
  const auditId = c.req.param('auditId');
  const userId = c.get('userId');

  const audit = await c.env.AUDITSHOCK_DB.prepare('SELECT id, status FROM audits WHERE id = ? AND user_id = ?').bind(auditId, userId).first();
  if (!audit) return c.json({ error: 'Not found' }, 404);
  if (audit.status === 'PROCESSING') return c.json({ error: 'Analysis running' }, 409);

  let body;
  try { body = await c.req.parseBody(); } catch { return c.json({ error: 'Invalid multipart upload' }, 400); }
  const file = body['file'];
  if (!(file instanceof File)) return c.json({ error: 'No file provided' }, 400);
  if (file.name.length > 255 || /[\/\\\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(file.name)) return c.json({ error: 'Invalid filename' }, 400);
  if (file.size === 0) return c.json({ error: 'Empty file' }, 400);
  if (!/\.(csv|pdf|png|jpe?g|webp|txt|md)$/i.test(file.name)) return c.json({ error: 'Unsupported file format' }, 415);
  const inventory = await c.env.AUDITSHOCK_DB.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes),0) AS bytes FROM documents WHERE audit_id = ?').bind(auditId).first<{ count: number; bytes: number }>();
  if (inventory && (inventory.count >= 50 || inventory.bytes + file.size > 100 * 1024 * 1024)) return c.json({ error: 'Audit limit: 50 documents or 100 MB' }, 413);
  if (file.size > 15 * 1024 * 1024) return c.json({ error: 'File exceeds 15MB limit' }, 400);


  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const extension = file.name.split('.').pop()!.toLowerCase();
  const prefix = (...signature: number[]) => signature.every((value,index) => bytes[index] === value);
  if ((extension === 'pdf' && !new TextDecoder().decode(bytes.slice(0,1024)).includes('%PDF-')) ||
      (extension === 'png' && !prefix(137,80,78,71,13,10,26,10)) ||
      (['jpg','jpeg'].includes(extension) && !prefix(255,216,255)) ||
      (extension === 'webp' && (!prefix(82,73,70,70) || new TextDecoder().decode(bytes.slice(8,12)) !== 'WEBP'))) return c.json({ error: 'File content does not match its format' }, 415);
  if (['csv','txt','md'].includes(extension)) {
    try { if (new TextDecoder('utf-8',{fatal:true}).decode(bytes).includes('\0')) throw new Error('Binary text'); }
    catch { return c.json({ error: 'Text and CSV uploads must be UTF-8 text' }, 415); }
  }

  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const sha256 = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  const docId = await hash(auditId + ':' + sha256);
  const objectKey = `audits/${auditId}/docs/${docId}-${crypto.randomUUID()}`;

  const existing = await c.env.AUDITSHOCK_DB.prepare('SELECT id, processing_status FROM documents WHERE audit_id = ? AND sha256 = ?').bind(auditId, sha256).first<{ id: string; processing_status: string }>();
  if (existing) return c.json({ docId: existing.id, status: existing.processing_status });
  await c.env.AUDITSHOCK_DOCS.put(objectKey, arrayBuffer, {
    httpMetadata: { contentType: file.type }
  });

  let documentType = 'UNKNOWN';
  if (file.name.toLowerCase().endsWith('.csv')) documentType = 'VENDOR_LEDGER';

  try {
  await atomicMutation(c, [c.env.AUDITSHOCK_DB.prepare(
    `INSERT OR IGNORE INTO documents (id, audit_id, object_key, original_filename, mime_type, sha256, size_bytes, document_type, processing_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'UPLOADED')`
  ).bind(docId, auditId, objectKey, file.name, file.type, sha256, file.size, documentType)]);

  } catch (error) {
    // Preserve a concurrently accepted duplicate; remove only an unreferenced new object.
    const saved = await c.env.AUDITSHOCK_DB.prepare('SELECT object_key FROM documents WHERE id = ?').bind(docId).first<{ object_key: string }>();
    if (saved?.object_key !== objectKey) await c.env.AUDITSHOCK_DOCS.delete(objectKey);
    throw error;
  }
  const saved = await c.env.AUDITSHOCK_DB.prepare('SELECT object_key, processing_status FROM documents WHERE id = ?').bind(docId).first<{ object_key: string; processing_status: string }>();
  if (saved?.object_key !== objectKey) await c.env.AUDITSHOCK_DOCS.delete(objectKey);
  return c.json({ docId, status: saved?.processing_status ?? 'UPLOADED' });
});

protectedApi.get('/audits/:auditId/documents', async (c) => {
  const auditId = c.req.param('auditId');
  const userId = c.get('userId');

  const audit = await c.env.AUDITSHOCK_DB.prepare('SELECT id, status FROM audits WHERE id = ? AND user_id = ?').bind(auditId, userId).first();
  if (!audit) return c.json({ error: 'Not found' }, 404);

  const { results } = await c.env.AUDITSHOCK_DB.prepare('SELECT * FROM documents WHERE audit_id = ? ORDER BY created_at DESC').bind(auditId).all();
  return c.json({ documents: results });
});

protectedApi.post('/audits/:auditId/analyze', async (c) => {
  const auditId = c.req.param('auditId');
  const userId = c.get('userId');

  const audit = await c.env.AUDITSHOCK_DB.prepare('SELECT id, status FROM audits WHERE id = ? AND user_id = ?').bind(auditId, userId).first();
  if (!audit) return c.json({ error: 'Not found' }, 404);

  const documents = await c.env.AUDITSHOCK_DB.prepare('SELECT COUNT(*) AS count FROM documents WHERE audit_id = ?').bind(auditId).first<{ count: number }>();
  if (!documents?.count) return c.json({ error: 'Upload documents before analysis' }, 400);
  const runId = crypto.randomUUID();
  const claim = await c.env.AUDITSHOCK_DB.batch([c.env.AUDITSHOCK_DB.prepare("UPDATE audits SET status = 'PROCESSING', workflow_id = ?, mutation_lease_id = NULL, mutation_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'PROCESSING' AND (status <> 'EDITING' OR mutation_expires_at <= ?) RETURNING id").bind(runId, auditId, Date.now()), c.env.AUDITSHOCK_DB.prepare('DELETE FROM findings WHERE audit_id = ? AND EXISTS(SELECT id FROM audits WHERE id = ? AND workflow_id = ?)').bind(auditId, auditId, runId)]);
  if (!claim[0]?.results.length) return c.json({ error: 'Analysis already running' }, 409);
  try {
    await c.env.AUDIT_WORKFLOW.create({ id: runId, params: { auditId, runId } });
  } catch (error) {
    await c.env.AUDITSHOCK_DB.prepare("UPDATE audits SET status = 'FAILED' WHERE id = ? AND workflow_id = ?").bind(auditId, runId).run();
    throw error;
  }

  return c.json({ status: 'PROCESSING' });
});

protectedApi.get('/audits/:auditId/status', async (c) => {
  const auditId = c.req.param('auditId');
  const userId = c.get('userId');

  const audit = await c.env.AUDITSHOCK_DB.prepare('SELECT status FROM audits WHERE id = ? AND user_id = ?').bind(auditId, userId).first<{ status: string }>();
  if (!audit) return c.json({ error: 'Not found' }, 404);

  return c.json({ status: audit.status });
});

protectedApi.get('/audits/:auditId/results', async (c) => {
  const auditId = c.req.param('auditId');
  const userId = c.get('userId');

  const audit = await c.env.AUDITSHOCK_DB.prepare('SELECT * FROM audits WHERE id = ? AND user_id = ?').bind(auditId, userId).first();
  if (!audit) return c.json({ error: 'Not found' }, 404);

  const { results: vendors } = await c.env.AUDITSHOCK_DB.prepare('SELECT * FROM vendors WHERE audit_id = ?').bind(auditId).all();
  const { results: payments } = await c.env.AUDITSHOCK_DB.prepare('SELECT * FROM payments WHERE audit_id = ?').bind(auditId).all();
  const { results: findings } = await c.env.AUDITSHOCK_DB.prepare("SELECT * FROM findings WHERE audit_id = ? AND EXISTS(SELECT id FROM audits WHERE id = findings.audit_id AND status IN ('COMPLETE','NEEDS_INPUT'))").bind(auditId).all();
  const { results: matches } = await c.env.AUDITSHOCK_DB.prepare('SELECT * FROM vendor_matches WHERE audit_id = ?').bind(auditId).all();
  const { results: coverages } = await c.env.AUDITSHOCK_DB.prepare('SELECT * FROM coverage_records WHERE audit_id = ?').bind(auditId).all();

  const { results: documents } = await c.env.AUDITSHOCK_DB.prepare('SELECT id, original_filename, processing_status, document_type, review_error FROM documents WHERE audit_id = ?').bind(auditId).all();
  return c.json({
    documents,
    audit,
    vendors,
    payments,
    findings,
    matches,
    coverages
  });
});

protectedApi.patch('/audits/:auditId', async (c) => {
  const body = updateAuditSchema.parse(await c.req.json());
  const auditId = c.req.param('auditId');
  const audit = await c.env.AUDITSHOCK_DB.prepare('SELECT * FROM audits WHERE id = ? AND user_id = ?').bind(auditId, c.get('userId')).first<any>();
  if (!audit) return c.json({ error: 'Not found' }, 404);
  if (audit.status === 'PROCESSING') return c.json({ error: 'Analysis running' }, 409);
  const merged = { ...audit, ...body };
  createAuditSchema.parse({ name: merged.name ?? undefined, policy_period_start: merged.policy_period_start ?? undefined, policy_period_end: merged.policy_period_end ?? undefined });
  if (body.assumptions_confirmed && (merged.exposure_basis !== 'FULL_VENDOR_PAYMENTS' || merged.wc_rate_micros_per_100 == null)) return c.json({ error: 'Set supported exposure basis and rate before confirming' }, 400);
  const changesAssumptions = ['policy_period_start', 'policy_period_end', 'exposure_basis', 'wc_rate_micros_per_100'].some(key => key in body);
  const confirmedAt = body.assumptions_confirmed === true ? new Date().toISOString() : (body.assumptions_confirmed === false || changesAssumptions) ? null : audit.assumptions_confirmed_at;
  await atomicMutation(c, [c.env.AUDITSHOCK_DB.prepare('UPDATE audits SET name = ?, policy_period_start = ?, policy_period_end = ?, exposure_basis = ?, wc_rate_micros_per_100 = ?, assumptions_confirmed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(merged.name ?? null, merged.policy_period_start ?? null, merged.policy_period_end ?? null, merged.exposure_basis ?? null, merged.wc_rate_micros_per_100 ?? null, confirmedAt ?? null, auditId)]);
  return c.json({ success: true });
});

async function editableAudit(c: any) {
  return c.env.AUDITSHOCK_DB.prepare('SELECT id, status FROM audits WHERE id = ? AND user_id = ?').bind(c.req.param('auditId'), c.get('userId')).first();
}
protectedApi.patch('/audits/:auditId/payments/:paymentId', async (c) => {
  const audit = await editableAudit(c);
  if (!audit) return c.json({ error: 'Not found' }, 404);
  if (audit.status === 'PROCESSING') return c.json({ error: 'Analysis running' }, 409);
  const body = z.object({ work_start_date: z.string(), work_end_date: z.string() }).parse(await c.req.json());
  createAuditSchema.parse({ policy_period_start: body.work_start_date, policy_period_end: body.work_end_date });
  const result = await atomicMutation(c, [c.env.AUDITSHOCK_DB.prepare('UPDATE payments SET work_start_date = ?, work_end_date = ? WHERE id = ? AND audit_id = ? RETURNING id').bind(body.work_start_date, body.work_end_date, c.req.param('paymentId'), audit.id)]);
  if (!result[1]?.results.length) return c.json({ error: 'Not found' }, 404);
  return c.json({ success: true });
});
protectedApi.post('/audits/:auditId/coverage/:coverageId/confirm', async (c) => {
  const audit = await editableAudit(c);
  if (!audit) return c.json({ error: 'Not found' }, 404);
  if (audit.status === 'PROCESSING') return c.json({ error: 'Analysis running' }, 409);
  const body = coverageReviewSchema.parse(await c.req.json());
  createAuditSchema.parse({ policy_period_start: body.effective_date, policy_period_end: body.expiration_date });
  const coverage = await c.env.AUDITSHOCK_DB.prepare('SELECT source_document_id FROM coverage_records WHERE id = ? AND audit_id = ?').bind(c.req.param('coverageId'), audit.id).first<{ source_document_id: string }>();
  const vendor = await c.env.AUDITSHOCK_DB.prepare('SELECT id FROM vendors WHERE id = ? AND audit_id = ?').bind(body.vendor_id, audit.id).first();
  if (!coverage || !vendor) return c.json({ error: 'Not found' }, 404);
  await atomicMutation(c, [
    c.env.AUDITSHOCK_DB.prepare("UPDATE coverage_records SET named_insured = ?, normalized_named_insured = ?, effective_date = ?, expiration_date = ?, wc_section_present = ?, wc_coverage_indicated = ?, review_status = 'CONFIRMED' WHERE id = ? AND audit_id = ?").bind(body.named_insured, normalizeName(body.named_insured), body.effective_date, body.expiration_date, Number(body.wc_section_present), Number(body.wc_coverage_indicated), c.req.param('coverageId'), audit.id),
    c.env.AUDITSHOCK_DB.prepare('DELETE FROM vendor_matches WHERE coverage_record_id = ? AND audit_id = ?').bind(c.req.param('coverageId'), audit.id),
    c.env.AUDITSHOCK_DB.prepare("INSERT INTO vendor_matches (id, audit_id, vendor_id, coverage_record_id, status, reason_json) VALUES (?, ?, ?, ?, 'CONFIRMED', ?)").bind(uuidv4(), audit.id, body.vendor_id, c.req.param('coverageId'), JSON.stringify({ rule: 'USER_CONFIRMED' })),
    c.env.AUDITSHOCK_DB.prepare("UPDATE documents SET processing_status = 'PROCESSED', review_error = NULL WHERE id = ? AND audit_id = ?").bind(coverage.source_document_id, audit.id)
  ]);
  return c.json({ success: true });
});
protectedApi.post('/audits/:auditId/documents/:docId/coverage', async (c) => {
  const audit = await editableAudit(c);
  if (!audit) return c.json({ error: 'Not found' }, 404);
  const body = coverageReviewSchema.parse(await c.req.json());
  createAuditSchema.parse({ policy_period_start: body.effective_date, policy_period_end: body.expiration_date });
  const doc = await c.env.AUDITSHOCK_DB.prepare("SELECT id FROM documents WHERE id = ? AND audit_id = ? AND markdown_object_key IS NOT NULL AND processing_status = 'NEEDS_REVIEW'").bind(c.req.param('docId'), audit.id).first();
  const vendor = await c.env.AUDITSHOCK_DB.prepare('SELECT id FROM vendors WHERE id = ? AND audit_id = ?').bind(body.vendor_id, audit.id).first();
  if (!doc || !vendor) return c.json({ error: 'Document and vendor must belong to this audit and be ready for review' }, 400);
  const coverageId = await hash(c.req.param('docId') + ':coverage');
  await atomicMutation(c, [
    c.env.AUDITSHOCK_DB.prepare(`INSERT INTO coverage_records (id,audit_id,source_document_id,named_insured,normalized_named_insured,effective_date,expiration_date,wc_section_present,wc_coverage_indicated,review_status)
      VALUES (?,?,?,?,?,?,?,?,?,'CONFIRMED') ON CONFLICT(id) DO UPDATE SET named_insured=excluded.named_insured,normalized_named_insured=excluded.normalized_named_insured,effective_date=excluded.effective_date,expiration_date=excluded.expiration_date,wc_section_present=excluded.wc_section_present,wc_coverage_indicated=excluded.wc_coverage_indicated,review_status='CONFIRMED'`)
      .bind(coverageId,audit.id,c.req.param('docId'),body.named_insured,normalizeName(body.named_insured),body.effective_date,body.expiration_date,Number(body.wc_section_present),Number(body.wc_coverage_indicated)),
    c.env.AUDITSHOCK_DB.prepare('DELETE FROM vendor_matches WHERE audit_id = ? AND coverage_record_id = ?').bind(audit.id,coverageId),
    c.env.AUDITSHOCK_DB.prepare("INSERT INTO vendor_matches (id,audit_id,vendor_id,coverage_record_id,status,reason_json) VALUES (?,?,?,?,'CONFIRMED',?)").bind(uuidv4(),audit.id,body.vendor_id,coverageId,JSON.stringify({rule:'MANUAL_SOURCE_REVIEW'})),
    c.env.AUDITSHOCK_DB.prepare("UPDATE documents SET document_type = 'coi', processing_status = 'PROCESSED', review_error = NULL WHERE id = ? AND audit_id = ?").bind(c.req.param('docId'),audit.id)
  ]);
  return c.json({ success: true, coverageId });
});

protectedApi.post('/audits/:auditId/documents/:docId/confirm', async (c) => {
  const audit = await editableAudit(c);
  if (!audit) return c.json({ error: 'Not found' }, 404);
  if (audit.status === 'PROCESSING') return c.json({ error: 'Analysis running' }, 409);
  z.object({ confirmed: z.literal(true) }).parse(await c.req.json());
  const coverage = await c.env.AUDITSHOCK_DB.prepare('SELECT id FROM coverage_records WHERE source_document_id = ? AND audit_id = ?').bind(c.req.param('docId'), audit.id).first();
  if (coverage) return c.json({ error: 'Confirm extracted coverage and vendor match instead' }, 400);
  const result = await atomicMutation(c, [c.env.AUDITSHOCK_DB.prepare("UPDATE documents SET processing_status = 'PROCESSED', review_error = NULL WHERE id = ? AND audit_id = ? AND processing_status = 'NEEDS_REVIEW' AND markdown_object_key IS NOT NULL AND review_error IS NULL RETURNING id").bind(c.req.param('docId'), audit.id)]);
  if (!result[1]?.results.length) return c.json({ error: 'Document is not ready for review' }, 400);
  return c.json({ success: true });
});
protectedApi.get('/audits/:auditId/documents/:docId/content', async (c) => {
  const audit = await editableAudit(c);
  if (!audit) return c.json({ error: 'Not found' }, 404);
  const doc = await c.env.AUDITSHOCK_DB.prepare('SELECT object_key, mime_type FROM documents WHERE id = ? AND audit_id = ?').bind(c.req.param('docId'), audit.id).first<{ object_key: string; mime_type: string }>();
  if (!doc) return c.json({ error: 'Not found' }, 404);
  const object = await c.env.AUDITSHOCK_DOCS.get(doc.object_key);
  if (!object) return c.json({ error: 'Document unavailable' }, 404);
  return new Response(await object.arrayBuffer(), { headers: { 'Content-Type': doc.mime_type || 'application/octet-stream', 'Content-Disposition': 'attachment', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
});

protectedApi.delete('/audits/:auditId', async (c) => {
  const auditId = c.req.param('auditId');
  const userId = c.get('userId');

  const audit = await c.env.AUDITSHOCK_DB.prepare('SELECT id, status FROM audits WHERE id = ? AND user_id = ?').bind(auditId, userId).first();
  if (!audit) return c.json({ error: 'Not found' }, 404);

  if (audit.status === 'PROCESSING') return c.json({ error: 'Analysis running' }, 409);
  const { results } = await c.env.AUDITSHOCK_DB.prepare('SELECT object_key, markdown_object_key FROM documents WHERE audit_id = ?').bind(auditId).all();

  const keysToDelete = [...new Set(results.flatMap((r: any) => [r.object_key, r.markdown_object_key]).filter((key): key is string => typeof key === 'string' && key.length > 0))];
  const statements = [];
  for (let offset = 0; offset < keysToDelete.length; offset += 100) {
    const keys = keysToDelete.slice(offset, offset + 100);
    statements.push(c.env.AUDITSHOCK_DB.prepare(`INSERT OR IGNORE INTO object_cleanup (object_key) VALUES ${keys.map(() => '(?)').join(',')}`).bind(...keys));
  }
  statements.push(c.env.AUDITSHOCK_DB.prepare('DELETE FROM audits WHERE id = ?').bind(auditId));
  await atomicMutation(c, statements);
  // Object-store failure cannot leave a live audit referencing deleted originals.
  let pending = true;
  try { pending = (await drainObjectCleanup(c.env)) > 0; } catch { console.error('Object cleanup deferred'); }
  return c.json({ success: true, cleanupPending: pending }, pending ? 202 : 200);
});

api.route('/', protectedApi);
