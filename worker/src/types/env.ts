import { D1Database, R2Bucket, Ai, Workflow, SendEmail } from '@cloudflare/workers-types';

export type Bindings = {
  AUDITSHOCK_DB: D1Database;
  AUDITSHOCK_DOCS: R2Bucket;
  AI: Ai;
  AUDIT_WORKFLOW: Workflow;
  EMAIL: SendEmail;
  EMAIL_FROM: string;
  CORS_ORIGIN?: string;
  AI_GATEWAY_ID?: string;
};

export type Variables = {
  userId: string;
  mutationId?: string;
  mutationAuditId?: string;
};
