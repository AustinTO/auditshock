import type { ScheduledController, ExecutionContext } from '@cloudflare/workers-types';
import { drainObjectCleanup } from './storage/cleanup';
import { Hono } from 'hono';
import { Bindings, Variables } from './types/env';
import { cors } from 'hono/cors';
import { api } from './api';

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use('/v1/*', cors({ origin: (origin, c) => (c.env.CORS_ORIGIN && origin === c.env.CORS_ORIGIN) ? origin : undefined, allowHeaders: ['Content-Type', 'Authorization'], allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] }));
app.get('/health', c => c.json({ status: 'ok' }));
app.use('/v1/*', async (c, next) => { await next(); c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff'); });
app.route('/v1', api);

export { AuditWorkflow } from './workflow';

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(drainObjectCleanup(env));
  }
};
