import { DatabaseSync } from 'node:sqlite';
// Real SQLite engine with a small D1 interface adapter; no network listener required.
export function sqliteDatabase(path) {
  const connection = new DatabaseSync(path);
  connection.exec('PRAGMA foreign_keys=ON');
  const execute = (query) => {
    const statement = connection.prepare(query.sql);
    if (statement.columns().length) return { results: statement.all(...query.values), success: true, meta: {} };
    const result = statement.run(...query.values);
    return { results: [], success: true, meta: { changes: Number(result.changes) } };
  };
  const prepare = (sql) => {
    let values = [];
    return { sql, get values() { return values; }, bind(...args) { values = args; return this; }, async run() { return execute({ sql, values }); }, async all() { return this.run(); }, async first() { return (await this.run()).results[0] ?? null; } };
  };
  return { prepare, close() { connection.close(); }, async batch(statements) {
    connection.exec('BEGIN');
    try { const results = statements.map(execute); connection.exec('COMMIT'); return results; }
    catch (error) { connection.exec('ROLLBACK'); throw error; }
  } };
}
export function memoryBucket() {
  const values = new Map();
  return { async put(key, body) { values.set(key, typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body)); }, async get(key) { const bytes = values.get(key); return bytes ? { async text() { return new TextDecoder().decode(bytes); }, async arrayBuffer() { return bytes.slice().buffer; } } : null; }, async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); } };
}
