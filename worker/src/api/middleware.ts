import { Context, Next } from 'hono';
import { Bindings, Variables } from '../types/env';

export const authMiddleware = async (c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const token = authHeader.slice(7);
  if (!/^ashk_[a-f0-9]{64}$/.test(token)) return c.json({ error: 'Unauthorized' }, 401);

  // Hash the token to compare with DB
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const tokenHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  const stmt = c.env.AUDITSHOCK_DB.prepare(
    'SELECT user_id, expires_at FROM sessions WHERE token_hash = ?'
  ).bind(tokenHash);
  const result = await stmt.first<{ user_id: string; expires_at: string }>();

  if (!result) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) <= Date.now()) {
    await c.env.AUDITSHOCK_DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return c.json({ error: 'Session expired' }, 401);
  }

  c.set('userId', result.user_id);

  await next();
};
