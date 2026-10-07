import { Bindings } from '../types/env';
import { parseCsvLedger } from '../parsers/csv';
import { normalizeName } from '../matching/normalize-name';
import { convertToMarkdown } from '../documents/convert';
import { askClef } from '../ai/clef';
import { CoiExtractionSchema, PolicyExtractionSchema, runStructuredExtraction } from '../ai/extraction';
import { determineCoverageStatus } from '../rules/coverage';
import { calculatePotentialExposure } from '../rules/exposure';
type Row = Record<string, any>;
export function normalizeDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let date = value.trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date);
  if (us) date = `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === date ? date : undefined;
}
export function ledgerMapping(content: string) {
  const headers = content.replace(/^\uFEFF/, '').split(/\r?\n/,1)[0]!.split(',').map(h => h.trim().replace(/^"|"$/g,'').toLowerCase());
  const pick = (names: string[]) => names.find(name => headers.includes(name));
  const vendor = pick(['vendor','vendor name','payee','supplier','subcontractor','name']);
  const amount = pick(['amount','payment amount','amount paid','total','payment']);
  if (!vendor || !amount) throw new Error('CSV requires vendor and amount columns');
  const date = pick(['date','payment date','payment_date','transaction date']);
  const memo = pick(['memo','description','notes']);
  return {vendor,amount,...(date ? {date} : {}),...(memo ? {memo} : {})};
}
async function id(key: string) {
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join('');
}
async function rows(env: Bindings, sql: string, ...values: any[]): Promise<Row[]> {
  return (await env.AUDITSHOCK_DB.prepare(sql).bind(...values).all()).results as Row[];
}
export const MAX_LEDGER_ROWS = 1000;
export const MAX_AUDIT_PAYMENTS = 1000;
export const MAX_AUDIT_VENDORS = 200;
export const MAX_AUDIT_DOCUMENTS = 50;
export const MAX_DOCUMENT_TEXT = 100000;
// These are conservative routing gates, not measurements of extraction accuracy.
export const MIN_CLASSIFICATION_PROBABILITY = 0.8;
export const MIN_READABILITY_PROBABILITY = 0.9;
export const MANUAL_REVIEW_PROBABILITY_THRESHOLD = 0.1;
const SOURCE_LAYOUT_REVIEW_ERROR = 'Source layout or classification is ambiguous. Review the original document and enter coverage manually from the source.';
export async function assertWorkflowCurrent(env: Bindings, auditId: string, runId?: string) {
  if (!runId) return;
  const current = await rows(env, "SELECT id FROM audits WHERE id = ? AND workflow_id = ? AND status = 'PROCESSING'", auditId, runId);
  if (!current.length) throw new Error('Workflow superseded');
}
const field = (value: any) => value?.value;
const textField = (value: any) => typeof field(value) === 'string' ? field(value) : null;
export async function processDocument(env: Bindings, auditId: string, doc: Row, runId?: string) {
  await assertWorkflowCurrent(env, auditId, runId);
  if (doc.processing_status === 'PROCESSED' || doc.processing_status === 'NEEDS_REVIEW') return;
  if (/\.csv$/i.test(doc.original_filename) || doc.mime_type === 'text/csv') {
    const object = await env.AUDITSHOCK_DOCS.get(doc.object_key);
    if (!object) throw new Error('Ledger object is missing');
    const content = (await object.text()).replace(/^\uFEFF/,'');
    const ledger = parseCsvLedger(content, ledgerMapping(content));
    if (!ledger.length) throw new Error('Ledger has no usable payments');
    if (ledger.length > MAX_LEDGER_ROWS) throw new Error('Ledger exceeds 1000 payment limit');
    const normalizedNames = ledger.map(payment => normalizeName(payment.vendorName).replace(/\s+/g,' ').trim());
    if (normalizedNames.some(name => !name)) throw new Error('Ledger vendor has no usable business name');
    const existingVendors = await rows(env, 'SELECT id, normalized_name FROM vendors WHERE audit_id = ? ORDER BY id', auditId);
    const vendorIds = new Map<string,string>();
    for (const vendor of existingVendors) if (!vendorIds.has(vendor.normalized_name)) vendorIds.set(vendor.normalized_name, vendor.id);
    if (new Set([...vendorIds.keys(), ...normalizedNames]).size > MAX_AUDIT_VENDORS) throw new Error('Audit exceeds 200 vendor limit');
    const otherPayments = await rows(env, 'SELECT COUNT(*) AS count FROM payments WHERE audit_id = ? AND source_document_id <> ?', auditId, doc.id);
    if (Number(otherPayments[0]?.count ?? 0) + ledger.length > MAX_AUDIT_PAYMENTS) throw new Error('Audit exceeds 1000 payment limit');
    const statements = [];
    const paymentValues: any[][] = [];
    for (const [index,payment] of ledger.entries()) {
      const normalized = normalizedNames[index]!;
      let vendorId = vendorIds.get(normalized);
      if (!vendorId) {
        vendorId = await id(`${auditId}:vendor:${normalized}`);
        vendorIds.set(normalized, vendorId);
        statements.push(env.AUDITSHOCK_DB.prepare('INSERT OR IGNORE INTO vendors (id,audit_id,canonical_name,normalized_name) VALUES (?,?,?,?)').bind(vendorId,auditId,payment.vendorName,normalized));
      }
      paymentValues.push([await id(`${doc.id}:payment:${index}`),auditId,vendorId,doc.id,payment.vendorName,payment.amountCents,normalizeDate(payment.paymentDate) ?? null,payment.memo ?? null]);
    }
    for (let offset = 0; offset < paymentValues.length; offset += 10) {
      const values = paymentValues.slice(offset, offset + 10);
      statements.push(env.AUDITSHOCK_DB.prepare(`INSERT OR IGNORE INTO payments (id,audit_id,vendor_id,source_document_id,source_vendor_name,amount_cents,payment_date,memo) VALUES ${values.map(() => '(?,?,?,?,?,?,?,?)').join(',')}`).bind(...values.flat()));
    }
    // Remove only unfinished imports after all validation. Processed documents skip above.
    await assertWorkflowCurrent(env, auditId, runId);
    await env.AUDITSHOCK_DB.prepare('DELETE FROM payments WHERE source_document_id = ? AND audit_id = ?').bind(doc.id, auditId).run();
    for (let offset = 0; offset < statements.length; offset += 100) {
      await assertWorkflowCurrent(env, auditId, runId);
      await env.AUDITSHOCK_DB.batch(statements.slice(offset, offset + 100));
    }
    await assertWorkflowCurrent(env, auditId, runId);
    await env.AUDITSHOCK_DB.prepare("UPDATE documents SET document_type = 'vendor_ledger', processing_status = 'PROCESSED', review_error = NULL WHERE id = ?").bind(doc.id).run();
    return;
  }
  const markdownKey = doc.markdown_object_key ?? await convertToMarkdown(env,auditId,doc.id,doc.object_key,doc.original_filename);
  const markdown = await env.AUDITSHOCK_DOCS.get(markdownKey);
  if (!markdown) throw new Error('Converted document is missing');
  const content = await markdown.text();
  if (!content.trim() || content.startsWith('[Mocked Markdown')) throw new Error('Conversion did not produce real document content');
  let kind = 'other';
  let reviewError = 'Automatic extraction failed. Review the original document and enter coverage manually when applicable.';
  try {
  if (content.length > MAX_DOCUMENT_TEXT) throw new Error('Document exceeds 100000 character extraction limit');
  const classification = await askClef(env,auditId,doc.id,'DOCUMENT_CLASSIFICATION',{content});
  const probabilities = classification?.document_type?.probabilities;
  const candidates = probabilities && typeof probabilities === 'object' ? Object.entries(probabilities).filter((entry): entry is [string,number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0 && entry[1] <= 1).sort((a,b) => b[1]-a[1]) : [];
  kind = (candidates[0]?.[1] ?? 0) >= MIN_CLASSIFICATION_PROBABILITY ? candidates[0]![0] : 'other';
  const readable = classification?.readable_enough?.p_yes;
  const manualReview = classification?.needs_manual_review?.p_yes;
  if (kind === 'other' || typeof readable !== 'number' || !Number.isFinite(readable) ||
      readable < MIN_READABILITY_PROBABILITY || typeof manualReview !== 'number' ||
      !Number.isFinite(manualReview) || manualReview >= MANUAL_REVIEW_PROBABILITY_THRESHOLD) {
    reviewError = SOURCE_LAYOUT_REVIEW_ERROR;
    throw new Error('Source requires manual review');
  }
  if (kind === 'coi' || kind === 'wc_policy') {
    const extraction = await runStructuredExtraction(env,content,kind === 'coi' ? CoiExtractionSchema : PolicyExtractionSchema);
    await assertWorkflowCurrent(env, auditId, runId);
    await env.AUDITSHOCK_DB.prepare('INSERT OR IGNORE INTO document_facts (id,document_id,fact_type,value_json,extractor,confidence,confirmed_by_user) VALUES (?,?,?,?,?,NULL,0)').bind(await id(`${doc.id}:extraction`),doc.id,kind,JSON.stringify(extraction),'workers-ai').run();
    if (kind === 'coi' && !extraction._validation_failed) {
      const wc = extraction.workers_comp, insured = textField(extraction.named_insured);
      await env.AUDITSHOCK_DB.prepare('INSERT OR IGNORE INTO coverage_records (id,audit_id,source_document_id,named_insured,normalized_named_insured,carrier,policy_number,effective_date,expiration_date,wc_section_present,wc_coverage_indicated,certificate_issue_date,extraction_confidence,review_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)').bind(await id(`${doc.id}:coverage`),auditId,doc.id,insured,normalizeName(insured),textField(wc.insurer_name),textField(wc.policy_number),normalizeDate(field(wc.effective_date)) ?? null,normalizeDate(field(wc.expiration_date)) ?? null,field(wc.section_present) === true ? 1 : 0,field(wc.indicated) === true ? 1 : 0,normalizeDate(field(extraction.certificate_issue_date)) ?? null,'NEEDS_REVIEW').run();
    }
  }
  await assertWorkflowCurrent(env, auditId, runId);
  await env.AUDITSHOCK_DB.prepare("UPDATE documents SET document_type = ?, processing_status = 'NEEDS_REVIEW', review_error = NULL WHERE id = ?").bind(kind,doc.id).run();
  } catch (error) {
    await assertWorkflowCurrent(env, auditId, runId);
    await env.AUDITSHOCK_DB.prepare("UPDATE documents SET document_type = ?, processing_status = 'NEEDS_REVIEW', review_error = ? WHERE id = ?").bind(kind, reviewError, doc.id).run();
  }
}
export async function analyzeAudit(env: Bindings, auditId: string, runId?: string) {
  await assertWorkflowCurrent(env, auditId, runId);
  const audit = (await rows(env,'SELECT * FROM audits WHERE id = ?',auditId))[0];
  if (!audit) throw new Error('Audit is missing');
  const payments = await rows(env,'SELECT * FROM payments WHERE audit_id = ?',auditId);
  const vendors = (await rows(env,'SELECT * FROM vendors WHERE audit_id = ?',auditId)).filter(vendor => payments.some(payment => payment.vendor_id === vendor.id));
  const coverage = await rows(env,"SELECT c.*, m.vendor_id FROM coverage_records c JOIN vendor_matches m ON m.coverage_record_id = c.id WHERE c.audit_id = ? AND m.audit_id = ? AND m.status = 'CONFIRMED' AND c.review_status = 'CONFIRMED' AND c.wc_coverage_indicated = 1 AND c.wc_section_present = 1",auditId,auditId);
  const candidates = await rows(env,'SELECT * FROM coverage_records WHERE audit_id = ?',auditId);
  for (const vendor of vendors) {
    for (const candidate of candidates) {
      if (!vendor.normalized_name || vendor.normalized_name !== candidate.normalized_named_insured) continue;
      const existing = await rows(env,'SELECT id FROM vendor_matches WHERE audit_id = ? AND vendor_id = ? AND coverage_record_id = ?',auditId,vendor.id,candidate.id);
      if (existing.length) continue;
      await env.AUDITSHOCK_DB.prepare('INSERT OR IGNORE INTO vendor_matches (id,audit_id,vendor_id,coverage_record_id,deterministic_score,status,reason_json) VALUES (?,?,?,?,1,?,?)').bind(await id(`${auditId}:match:${vendor.id}:${candidate.id}`),auditId,vendor.id,candidate.id,'NEEDS_REVIEW',JSON.stringify({rule:'NORMALIZED_NAME_EQUAL',requiresHumanConfirmation:true})).run();
    }
  }
  const pending = await rows(env,"SELECT id FROM documents WHERE audit_id = ? AND processing_status <> 'PROCESSED'",auditId);
  const pendingCoverage = candidates.some(c => c.review_status !== 'CONFIRMED' && c.review_status !== 'REJECTED');
  const reviewRequired = pending.length > 0 || pendingCoverage;
  const start = normalizeDate(audit.policy_period_start), end = normalizeDate(audit.policy_period_end);
  const assumptionsReady = Boolean(audit.assumptions_confirmed_at && audit.exposure_basis === 'FULL_VENDOR_PAYMENTS' && Number.isSafeInteger(audit.wc_rate_micros_per_100) && audit.wc_rate_micros_per_100 >= 0);
  let needsInput = !payments.length || !start || !end || start > end || !assumptionsReady || reviewRequired;
  const statements = [];
  for (const vendor of vendors) {
    const ranges = coverage.filter(c => c.vendor_id === vendor.id && normalizeDate(c.effective_date) && normalizeDate(c.expiration_date) && c.effective_date <= c.expiration_date).map(c => ({start:c.effective_date,end:c.expiration_date}));
    const evaluated = payments.filter(p => p.vendor_id === vendor.id).map(payment => {
      const workStart = normalizeDate(payment.work_start_date), workEnd = normalizeDate(payment.work_end_date);
      if (!workStart || !workEnd || workStart > workEnd) { needsInput = true; return {amountCents:payment.amount_cents,coverageStatus:'WORK_DATE_UNKNOWN'}; }
      if (start && end && (workEnd < start || workStart > end)) return {amountCents:payment.amount_cents,coverageStatus:'OUTSIDE_AUDIT_PERIOD',userExcluded:true};
      if (!start || !end || start > end || workStart < start || workEnd > end) { needsInput = true; return {amountCents:payment.amount_cents,coverageStatus:'WORK_DATE_UNKNOWN'}; }
      return {amountCents:payment.amount_cents,coverageStatus:determineCoverageStatus({start:workStart,end:workEnd},ranges)};
    });
    const estimate = Boolean(start && end && start <= end) && assumptionsReady && evaluated.every(p => p.coverageStatus !== 'WORK_DATE_UNKNOWN') && !reviewRequired ? calculatePotentialExposure(evaluated,{basis:'FULL_VENDOR_PAYMENTS',wcRateMicrosPer100:audit.wc_rate_micros_per_100}) : null;
    const status = evaluated.length > 0 && evaluated.every(p => p.coverageStatus === 'OUTSIDE_AUDIT_PERIOD') ? 'OUTSIDE_AUDIT_PERIOD' : evaluated.some(p => p.coverageStatus === 'WORK_DATE_UNKNOWN') ? 'WORK_DATE_UNKNOWN' : evaluated.every(p => p.coverageStatus === 'DOCUMENTED_FOR_PERIOD' || p.coverageStatus === 'OUTSIDE_AUDIT_PERIOD') ? 'DOCUMENTED_FOR_PERIOD' : ranges.length ? 'DOCUMENTATION_GAP' : 'NO_MATCHING_COI';
    statements.push(env.AUDITSHOCK_DB.prepare(`INSERT INTO findings (id,audit_id,vendor_id,kind,severity,amount_cents,data_json) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM audits WHERE id = ? AND (? IS NULL OR (workflow_id = ? AND status = 'PROCESSING'))) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,severity=excluded.severity,amount_cents=excluded.amount_cents,data_json=excluded.data_json`).bind(await id(`${auditId}:finding:${vendor.id}`),auditId,vendor.id,status,(status === 'DOCUMENTED_FOR_PERIOD' || status === 'OUTSIDE_AUDIT_PERIOD') ? 'INFO' : 'WARNING',estimate?.totalExposureCents ?? null,JSON.stringify({payments:evaluated,estimate,assumptionsConfirmed:assumptionsReady,reviewRequired}),auditId,runId ?? null,runId ?? null));
  }
  const status = needsInput ? 'NEEDS_INPUT' : 'COMPLETE';
  statements.push(env.AUDITSHOCK_DB.prepare(`UPDATE audits SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND (? IS NULL OR (workflow_id = ? AND status = 'PROCESSING'))`).bind(status,auditId,runId ?? null,runId ?? null));
  await assertWorkflowCurrent(env, auditId, runId);
  for (let offset = 0; offset < statements.length; offset += 100) {
    await assertWorkflowCurrent(env, auditId, runId);
    await env.AUDITSHOCK_DB.batch(statements.slice(offset, offset + 100));
  }
  return {status,payments:payments.length,vendors:vendors.length};
}
