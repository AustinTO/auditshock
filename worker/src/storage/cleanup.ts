import type { Bindings } from '../types/env';
// Deletion is queued in the same transaction that removes its database references.
export async function drainObjectCleanup(env: Bindings, limit = 100): Promise<number> {
  const { results } = await env.AUDITSHOCK_DB.prepare('SELECT object_key FROM object_cleanup ORDER BY created_at LIMIT ?').bind(Math.min(100,Math.max(1,limit))).all<{ object_key: string }>();
  for (const row of results) {
    try {
      await env.AUDITSHOCK_DOCS.delete(row.object_key);
      await env.AUDITSHOCK_DB.prepare('DELETE FROM object_cleanup WHERE object_key = ?').bind(row.object_key).run();
    } catch {
      await env.AUDITSHOCK_DB.prepare('UPDATE object_cleanup SET attempts = attempts + 1 WHERE object_key = ?').bind(row.object_key).run();
    }
  }
  const pending = await env.AUDITSHOCK_DB.prepare('SELECT COUNT(*) AS count FROM object_cleanup').first<{ count: number }>();
  return pending?.count ?? 0;
}
