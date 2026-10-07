import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
if(process.env.AUDITSHOCK_LIVE_API!=='1')throw new Error('Explicit production validation opt-in required');
const userId=randomUUID(),sessionId=randomUUID(),token='ashk_'+randomBytes(32).toString('hex');
const tokenHash=createHash('sha256').update(token).digest('hex');
const sql=value=>"'"+String(value).replaceAll("'","''")+"'";
const runSql=command=>JSON.parse(execFileSync('./node_modules/.bin/wrangler',['d1','execute','AUDITSHOCK_DB','--remote','--command',command,'--json'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_LOG_PATH:'/tmp/auditshock-wrangler-logs',WRANGLER_SEND_METRICS:'false'}}));
const base='https://auditshock-api.austintaylorodell.workers.dev';
let auditId;
const call=async(path,body,method='POST')=>{
 const multipart=body instanceof FormData;
 const response=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,...(!multipart?{'Content-Type':'application/json'}:{})},...(body===undefined?{}:{body:multipart?body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
 const result=await response.json();
 if(!response.ok)throw new Error(`Hosted ${method} ${path} returned ${response.status}: ${result.error??'failure'}`);
 return result;
};
const wait=async()=>{const end=Date.now()+90000;while(Date.now()<end){const data=await call(`/v1/audits/${auditId}/results`,undefined,'GET');if(data.audit.status!=='PROCESSING')return data;await new Promise(r=>setTimeout(r,1000));}throw new Error('Hosted workflow timeout');};
const started=performance.now();
try{
 assert.equal((await fetch(base+'/health')).status,200);
 // Dedicated ephemeral QA identity only; no email is sent or customer account touched.
 runSql(`INSERT INTO users(id,email) VALUES(${sql(userId)},${sql('auditshock-validation-'+userId+'@example.invalid')});INSERT INTO sessions(id,token_hash,user_id,expires_at) VALUES(${sql(sessionId)},${sql(tokenHash)},${sql(userId)},${sql(new Date(Date.now()+10*60000).toISOString())})`);
 auditId=(await call('/v1/audits',{name:'VALIDATION public payments — disposable'})).auditId;
 const form=new FormData();form.set('file',new File([readFileSync('../fixtures/public/south-gate-payments-2025-08-06.csv')],'public-payments.csv',{type:'text/csv'}));
 await call(`/v1/audits/${auditId}/documents`,form);await call(`/v1/audits/${auditId}/analyze`);
 let result=await wait();assert.equal(result.audit.status,'NEEDS_INPUT');assert.equal(result.payments.length,4);assert.equal(result.payments.reduce((s,p)=>s+p.amount_cents,0),8959400);
 await call(`/v1/audits/${auditId}`,{policy_period_start:'2025-01-01',policy_period_end:'2025-12-31',exposure_basis:'FULL_VENDOR_PAYMENTS',wc_rate_micros_per_100:5000000,assumptions_confirmed:true},'PATCH');
 for(const payment of result.payments)await call(`/v1/audits/${auditId}/payments/${payment.id}`,{work_start_date:'2025-08-06',work_end_date:'2025-08-06'},'PATCH');
 await call(`/v1/audits/${auditId}/analyze`);result=await wait();assert.equal(result.audit.status,'COMPLETE');assert.equal(result.findings.reduce((s,f)=>s+f.amount_cents,0),8959400);assert.equal(result.findings.reduce((s,f)=>s+JSON.parse(f.data_json).estimate.estimatedPremiumImpactCents,0),447970);
 const certificate=readFileSync('/tmp/auditshock-ecwa-page-32.pdf');
 assert.equal(createHash('sha256').update(readFileSync('/tmp/auditshock-ecwa-certificate.pdf')).digest('hex'),'67e2e046c49fe47228aa107a9fd20c2303e621103a881a1ef610932fb682a2ad');
 const docForm=new FormData();docForm.set('file',new File([certificate],'public-historical-certificate.pdf',{type:'application/pdf'}));
 await call(`/v1/audits/${auditId}/documents`,docForm);await call(`/v1/audits/${auditId}/analyze`);result=await wait();assert.equal(result.audit.status,'NEEDS_INPUT');assert.equal(result.coverages.filter(c=>c.review_status==='CONFIRMED').length,0);
 const document=result.documents.find(d=>d.original_filename==='public-historical-certificate.pdf');assert.equal(document.processing_status,'NEEDS_REVIEW');
 const report={kind:'production-api-public-data-validation',rows:4,totalCents:8959400,centDifference:0,syntheticRateAndWorkDates:true,syntheticPremiumCents:447970,liveDocumentReview:document.processing_status,confirmedCoverage:0,elapsedMs:Math.round(performance.now()-started),emailSent:false,qaAccountCleanup:false};
 await call(`/v1/audits/${auditId}`,undefined,'DELETE');auditId=undefined;
 runSql(`DELETE FROM sessions WHERE user_id=${sql(userId)};DELETE FROM users WHERE id=${sql(userId)}`);
 report.qaAccountCleanup=true;writeFileSync('/tmp/auditshock-live-api-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{
 if(auditId){try{await call(`/v1/audits/${auditId}`,undefined,'DELETE');auditId=undefined;}catch{console.error('QA audit cleanup requires retry');}}
 // Retain ownership if cleanup failed; never cascade-delete an audit without queueing its objects.
 if(!auditId)runSql(`DELETE FROM sessions WHERE user_id=${sql(userId)};DELETE FROM users WHERE id=${sql(userId)}`);
}
