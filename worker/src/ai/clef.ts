import { Bindings } from '../types/env';
import { v4 as uuidv4 } from 'uuid';

export const CLEF_PACKS = {
  DOCUMENT_CLASSIFICATION: {
    version: '1.0',
    model: '@cf/cloudflare/clef-flash',
    questions: {
      document_type: {
        type: 'choice',
        instructions: 'Classify this uploaded document by its primary business purpose. Do not infer beyond the document contents.',
        criteria: {
          coi: 'Certificate of insurance or evidence of insurance, including ACORD-style certificates.',
          wc_policy: 'Workers compensation insurance policy, declaration page, endorsement, or policy schedule.',
          audit_notice: 'Premium audit request, audit instructions, audit questionnaire, or audit notice.',
          vendor_ledger: 'Vendor, subcontractor, accounts-payable, or payment ledger containing multiple transaction records.',
          payroll_report: 'Payroll report or employee wage report.',
          invoice: 'A single vendor invoice, bill, or statement.',
          other: 'None of the listed categories fit reliably.'
        }
      },
      readable_enough: {
        type: 'noul',
        instructions: 'Is there enough legible information in this representation to perform reliable structured extraction?'
      },
      needs_manual_review: {
        type: 'noul',
        instructions: 'Is the document type or readable content sufficiently ambiguous that a human should review it before relying on extracted facts?'
      }
    }
  },
  COI_INTERPRETATION: {
    version: '1.0',
    model: '@cf/cloudflare/clef',
    questions: {
      is_insurance_certificate: {
        type: 'noul',
        instructions: 'Does this document appear to be an insurance certificate or equivalent evidence-of-insurance document?'
      },
      wc_section_present: {
        type: 'noul',
        instructions: 'Does the document contain an identifiable Workers Compensation / Employers Liability coverage section or equivalent?'
      },
      wc_coverage_indicated: {
        type: 'noul',
        instructions: 'Based only on explicit markings and text in the document, does it indicate Workers Compensation coverage is included? Do not infer coverage from other policy types.'
      },
      named_insured_clear: {
        type: 'noul',
        instructions: 'Is the named insured identity clear enough to use for entity matching?'
      },
      coverage_dates_clear: {
        type: 'noul',
        instructions: 'Are effective and expiration dates for the relevant Workers Compensation coverage explicit and sufficiently legible?'
      },
      coi_quality: {
        type: 'score',
        instructions: 'Rate how safely the document can be used as evidence for extracting the named insured, Workers Compensation indication, and dates.',
        criteria: [
          'Unreadable or missing essential information',
          'Major ambiguity',
          'Usable but requires human review',
          'Clear with minor uncertainty',
          'Very clear and internally consistent'
        ]
      },
      manual_review_required: {
        type: 'noul',
        instructions: 'Should a human review this document before AuditShock treats its extracted Workers Compensation facts as reliable?'
      }
    }
  },
  VENDOR_MATCH: {
    version: '1.0',
    model: '@cf/cloudflare/clef-flash', // Fallback to Flash for MVP cost
    questions: {
      same_business: {
        type: 'noul',
        instructions: 'Based only on the supplied business identity evidence, are these likely the same legal/business entity or an obvious spelling/format variation of the same entity? Do not treat certificate-holder identity as proof that the named insured is the vendor.'
      },
      match_strength: {
        type: 'score',
        instructions: 'Rate the strength of the evidence that these records represent the same business.',
        criteria: [
          'No credible evidence',
          'Weak evidence',
          'Plausible but ambiguous',
          'Strong evidence',
          'Near-certain identity match'
        ]
      },
      primary_reason: {
        type: 'choice',
        instructions: 'What best describes the identity evidence?',
        criteria: {
          exact_or_format: 'Names differ only by punctuation, spacing, corporate suffix, or obvious formatting.',
          dba_or_alias: 'Evidence indicates a DBA, trade-name, or alias relationship.',
          address_support: 'Address or other independent business information strongly supports the match.',
          name_only: 'The possible match rests mainly on similar names.',
          conflicting: 'The records contain conflicting identity information.',
          insufficient: 'There is not enough information to decide.'
        }
      }
    }
  },
  DOCUMENTATION_RISK: {
    version: '1.0',
    model: '@cf/cloudflare/clef',
    questions: {
      human_review_required: {
        type: 'noul',
        instructions: 'Given these structured records, is there material ambiguity in the documentation such that a human should review this vendor before AuditShock displays the result as high-confidence?'
      },
      documentation_quality: {
        type: 'score',
        instructions: 'Rate the documentary support for this vendor during the relevant audit period. This is a document-quality assessment, not a legal coverage determination.',
        criteria: [
          'No useful documentation',
          'Major documentation gaps',
          'Partial documentation',
          'Strong documentation with minor gaps',
          'Strong documentation across the relevant period'
        ]
      }
    }
  }
};

export async function askClef(
  env: Bindings,
  auditId: string,
  documentId: string | null,
  packName: keyof typeof CLEF_PACKS,
  state: any
): Promise<any> {
  const pack = CLEF_PACKS[packName];

  const response = await env.AI.run(pack.model, {
    model: pack.model.endsWith('clef-flash') ? 'clef-flash' : 'clef',
    state,
    questions: pack.questions
  }, env.AI_GATEWAY_ID?.trim() ? { gateway: { id: env.AI_GATEWAY_ID.trim(), collectLog: false, skipCache: true, requestTimeoutMs: 60000 } } : {});
  const rawAnswers = response.answers;
  if (!rawAnswers || typeof rawAnswers !== 'object') throw new Error('Clef returned no answers');
  const answers: Record<string, unknown> = {};
  const probability = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
  for (const [key, question] of Object.entries(pack.questions)) {
    const answer = (rawAnswers as Record<string, any>)[key];
    if (question.type === 'noul') {
      const yes = typeof answer === 'number' ? answer : answer?.noul ?? answer?.p_yes;
      if (!probability(yes)) throw new Error(`Invalid Clef probability: ${key}`);
      answers[key] = { p_yes: yes };
    } else {
      // Keep provider details, but never accept missing or malformed decisions.
      if (answer === null || answer === undefined ||
          (typeof answer !== 'object' && typeof answer !== 'number')) {
        throw new Error(`Invalid Clef answer: ${key}`);
      }
      if (typeof answer === 'number' && !Number.isFinite(answer)) throw new Error(`Invalid Clef score: ${key}`);
      answers[key] = answer;
    }
  }

  // Calculate safe state sha
  const encoder = new TextEncoder();
  const stateStr = JSON.stringify(state);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(stateStr));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const stateSha = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  await env.AUDITSHOCK_DB.prepare(
    `INSERT INTO model_decisions (id, audit_id, document_id, question_pack, question_pack_version, model, state_sha256, answers_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    uuidv4(),
    auditId,
    documentId,
    packName,
    pack.version,
    pack.model,
    stateSha,
    JSON.stringify(answers)
  ).run();

  return answers;
}
