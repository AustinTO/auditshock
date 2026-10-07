import type { Context, Next } from 'hono';
import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { Bindings, Variables } from '../types/env';
type ApiContext = Context<{ Bindings: Bindings; Variables: Variables }>;
export class MutationConflict extends Error {}
const LEASE_MS = 15 * 60 * 1000;
// The lease spans object-store calls. Every DB mutation verifies ownership again in its transaction.
export async function auditMutationMiddleware(c: ApiContext, next: Next) {
  const match = /(?:^|\/)audits\/([^/]+)(?:\/|$)/.exec(c.req.path);
  if (!match || !['POST', 'PATCH', 'DELETE'].includes(c.req.method) || c.req.path.endsWith('/analyze')) return next();
  const auditId = decodeURIComponent(match[1]!);
  const token = crypto.randomUUID();
  const now = Date.now();
  const acquired = await c.env.AUDITSHOCK_DB.prepare(`UPDATE audits SET status = 'EDITING', mutation_lease_id = ?, mutation_expires_at = ?
    WHERE id = ? AND user_id = ? AND status <> 'PROCESSING'
      AND (status <> 'EDITING' OR mutation_expires_at <= ?) RETURNING id`)
    .bind(token, now + LEASE_MS, auditId, c.get('userId'), now).first();
  if (!acquired) {
    const audit = await c.env.AUDITSHOCK_DB.prepare('SELECT id FROM audits WHERE id = ? AND user_id = ?').bind(auditId, c.get('userId')).first();
    return c.json({ error: audit ? 'Audit is busy. Retry after the current operation finishes.' : 'Not found' }, audit ? 409 : 404);
  }
  c.set('mutationId', token);
  c.set('mutationAuditId', auditId);
  try { await next(); }
  finally {
    // An expired/overwritten lease cannot release the new owner's lock.
    await c.env.AUDITSHOCK_DB.prepare("UPDATE audits SET status = 'NEEDS_INPUT', mutation_lease_id = NULL, mutation_expires_at = NULL WHERE id = ? AND mutation_lease_id = ?")
      .bind(auditId, token).run();
  }
}
export async function atomicMutation(c: ApiContext, statements: D1PreparedStatement[]) {
  const auditId = c.get('mutationAuditId'), token = c.get('mutationId');
  if (!auditId || !token) throw new MutationConflict('Missing mutation lease');
  const checkId = crypto.randomUUID();
  const check = c.env.AUDITSHOCK_DB.prepare(`INSERT INTO audit_mutation_checks (id, valid) SELECT ?, CASE WHEN EXISTS(
    SELECT id FROM audits WHERE id = ? AND user_id = ? AND status = 'EDITING' AND mutation_lease_id = ? AND mutation_expires_at > ?
  ) THEN 1 ELSE 0 END`).bind(checkId, auditId, c.get('userId'), token, Date.now());
  try {
    return await c.env.AUDITSHOCK_DB.batch([
      check, ...statements,
      c.env.AUDITSHOCK_DB.prepare('DELETE FROM findings WHERE audit_id = ?').bind(auditId),
      c.env.AUDITSHOCK_DB.prepare('UPDATE audits SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(auditId),
      c.env.AUDITSHOCK_DB.prepare('DELETE FROM audit_mutation_checks WHERE id = ?').bind(checkId)
    ]);
  } catch (error) {
    const audit = await c.env.AUDITSHOCK_DB.prepare('SELECT mutation_lease_id, mutation_expires_at FROM audits WHERE id = ?').bind(auditId).first<{ mutation_lease_id: string; mutation_expires_at: number }>();
    if (!audit || audit.mutation_lease_id !== token || audit.mutation_expires_at <= Date.now()) throw new MutationConflict('Audit changed during operation');
    throw error;
  }
}
