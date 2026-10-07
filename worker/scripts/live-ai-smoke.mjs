import { getPlatformProxy } from 'wrangler';
import { readFile, writeFile } from 'node:fs/promises';
// Explicitly opt-in: public data only, small hosted usage, no email or production D1/R2 writes.
if (process.env.AUDITSHOCK_LIVE_AI !== '1') throw new Error('Set AUDITSHOCK_LIVE_AI=1 to run hosted public-data validation');
const configPath = '/tmp/auditshock-live-ai.jsonc';
await writeFile(configPath, JSON.stringify({name:'auditshock-ai-validation',compatibility_date:'2026-10-06',ai:{binding:'AI',remote:true}}));
const platform = await getPlatformProxy({ configPath, persist: false });
try {
  const content = await readFile('../fixtures/public/south-gate-payments-2025-08-06.csv','utf8');
  const started = performance.now();
  const result = await platform.env.AI.run('@cf/cloudflare/clef-flash',{
    model:'clef-flash',state:{content},questions:{document_type:{type:'choice',instructions:'Classify the provided business document.',criteria:{vendor_ledger:'Vendor payment ledger',other:'Other document'}},readable_enough:{type:'noul',instructions:'Is the supplied payment ledger readable?'}}
  },process.env.AUDITSHOCK_AI_GATEWAY_ID ? {gateway:{id:process.env.AUDITSHOCK_AI_GATEWAY_ID,collectLog:false,skipCache:true,requestTimeoutMs:60000}} : {});
  console.log(JSON.stringify({kind:'live-clef-public-ledger',elapsedMs:Math.round(performance.now()-started),result}));
} finally { await platform.dispose(); }
