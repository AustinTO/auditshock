import {it,expect} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const enabled=process.env.AUDITSHOCK_WORKER_RUNTIME==='1';
it.skipIf(!enabled)('runs the bundled Worker API and real workflow from upload through reviewed findings',async()=>{
 const {Miniflare,convertV4MiniflareOptions}=await import('miniflare');
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'dist/index.js',compatibilityDate:'2026-10-06',d1Databases:['AUDITSHOCK_DB'],r2Buckets:['AUDITSHOCK_DOCS'],workflows:{AUDIT_WORKFLOW:{name:'auditshock-local-analysis',className:'AuditWorkflow'}},bindings:{CORS_ORIGIN:'https://auditshock.example'}}));
 try{
  const db=await mf.getD1Database('AUDITSHOCK_DB');
  for(const file of readdirSync('migrations').sort())await db.batch(readFileSync(`migrations/${file}`,'utf8').replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
  const token='ashk_'+'b'.repeat(64);
  await db.batch([db.prepare("INSERT INTO users(id,email) VALUES('runtime-user','runtime@example.org')"),db.prepare('INSERT INTO sessions(id,token_hash,user_id,expires_at) VALUES(?,?,?,?)').bind('runtime-session',createHash('sha256').update(token).digest('hex'),'runtime-user',new Date(Date.now()+86400000).toISOString())]);
  const call=(path,body,method='POST')=>mf.dispatchFetch('https://auditshock.test'+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  expect((await mf.dispatchFetch('https://auditshock.test/health')).status).toBe(200);
  const create=await call('/v1/audits',{name:'Actual runtime'});expect(create.status).toBe(200);
  const {auditId}=await create.json();
  const form=new FormData();form.set('file',new File([readFileSync('../fixtures/public/south-gate-payments-2025-08-06.csv')],'public-payments.csv',{type:'text/csv'}));
  const multipart=new Request('https://serialization.test',{method:'POST',body:form});
  const upload=await mf.dispatchFetch(`https://auditshock.test/v1/audits/${auditId}/documents`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':multipart.headers.get('Content-Type')},body:await multipart.arrayBuffer()});
  expect(upload.status,await upload.text()).toBe(200);
  const waitForResults=async()=>{const stop=Date.now()+20000;while(Date.now()<stop){const result=await(await call(`/v1/audits/${auditId}/results`,undefined,'GET')).json();if(result.audit.status!=='PROCESSING')return result;await new Promise(r=>setTimeout(r,100));}throw new Error('Workflow did not reach terminal audit state');};
  expect((await call(`/v1/audits/${auditId}/analyze`)).status).toBe(200);
  let result=await waitForResults();expect(result.audit.status).toBe('NEEDS_INPUT');expect(result.payments).toHaveLength(4);
  expect(result.payments.reduce((s,p)=>s+p.amount_cents,0)).toBe(8959400);
  expect(result.findings.every(f=>f.amount_cents===null)).toBe(true);
  expect((await call(`/v1/audits/${auditId}`,{policy_period_start:'2025-01-01',policy_period_end:'2025-12-31',exposure_basis:'FULL_VENDOR_PAYMENTS',wc_rate_micros_per_100:5000000,assumptions_confirmed:true},'PATCH')).status).toBe(200);
  // Explicit synthetic work-date/rate labels test calculations; they are not facts from the public register.
  for(const p of result.payments)expect((await call(`/v1/audits/${auditId}/payments/${p.id}`,{work_start_date:'2025-08-06',work_end_date:'2025-08-06'},'PATCH')).status).toBe(200);
  expect((await call(`/v1/audits/${auditId}/analyze`)).status).toBe(200);
  result=await waitForResults();expect(result.audit.status).toBe('COMPLETE');
  expect(result.findings.reduce((s,f)=>s+f.amount_cents,0)).toBe(8959400);
  expect(result.findings.reduce((s,f)=>s+JSON.parse(f.data_json).estimate.estimatedPremiumImpactCents,0)).toBe(447970);
  expect((await call(`/v1/audits/${auditId}`,undefined,'DELETE')).status).toBe(200);
  expect((await call(`/v1/audits/${auditId}`,undefined,'GET')).status).toBe(404);
  await db.prepare("INSERT INTO audits(id,user_id,status) VALUES('legacy-runtime','runtime-user','PROCESSING')").run();
  const bindings=await mf.getBindings();
  await bindings.AUDIT_WORKFLOW.create({id:'legacy-runtime-instance',params:{auditId:'legacy-runtime'}});
  const deadline=Date.now()+10000;let legacy;
  do {legacy=await db.prepare("SELECT status FROM audits WHERE id='legacy-runtime'").first();if(legacy.status==='FAILED')break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
  expect(legacy.status).toBe('FAILED');
 }finally{await mf.dispose();}
},60000);
