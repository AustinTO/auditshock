import { Bindings } from '../types/env';
import { normalizeName } from './normalize-name';
import { askClef } from '../ai/clef';
import { v4 as uuidv4 } from 'uuid';

// Compute simple similarity index for normalized strings
export function computeDeterministicSimilarity(normA: string, normB: string): number {
  if (!normA || !normB) return 0.0;
  if (normA === normB) return 1.0;
  if (normA.includes(normB) || normB.includes(normA)) return 0.8;

  // Basic Jaccard similarity of words
  const wordsA = new Set(normA.split(' '));
  const wordsB = new Set(normB.split(' '));
  const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
  const union = new Set([...wordsA, ...wordsB]);

  return intersection.size / union.size;
}

export async function matchVendorToCoverage(
  env: Bindings,
  auditId: string,
  vendorId: string,
  vendorName: string,
  coverageRecords: any[]
): Promise<void> {
  const normVendor = normalizeName(vendorName);

  for (const cov of coverageRecords) {
    const normInsured = cov.normalized_named_insured;
    const similarity = computeDeterministicSimilarity(normVendor, normInsured);

    let status = 'NEEDS_REVIEW';
    let clefProb = 0;
    let reason: any = { similarity, rule: 'DETERMINISTIC' };

    if (similarity >= 0.9) {
      status = 'MATCHED';
    } else if (similarity > 0.4) {
      // Ambiguous - escalate to Clef
      const state = {
        payment_vendor: { name: vendorName },
        certificate_entity: { named_insured: cov.named_insured },
        deterministic_similarity: similarity
      };

      const clefResult = await askClef(env, auditId, cov.source_document_id, 'VENDOR_MATCH', state);

      const p_same = clefResult?.same_business?.p_yes ?? 0;
      clefProb = p_same;

      if (p_same >= 0.95) {
        status = 'MATCHED';
        reason.rule = 'CLEF_AUTO_ACCEPT';
      } else if (p_same <= 0.05) {
        status = 'REJECTED';
        reason.rule = 'CLEF_AUTO_REJECT';
      } else {
        status = 'NEEDS_REVIEW';
        reason.rule = 'CLEF_AMBIGUOUS';
      }
    } else {
      status = 'REJECTED';
    }

    if (status !== 'REJECTED') {
      await env.AUDITSHOCK_DB.prepare(
        `INSERT INTO vendor_matches (id, audit_id, vendor_id, coverage_record_id, deterministic_score, clef_probability, status, reason_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        uuidv4(), auditId, vendorId, cov.id, similarity, clefProb, status, JSON.stringify(reason)
      ).run();
    }
  }
}
