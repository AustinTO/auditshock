import {getPlatformProxy} from 'wrangler';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {sqliteDatabase,memoryBucket} from '../test/helpers/sqlite.js';
import {processDocument,analyzeAudit} from '../src/analysis/audit';
if(process.env.AUDITSHOCK_LIVE_AI!=='1')throw new Error('Explicit hosted public-data opt-in required');
const source=readFileSync('/tmp/auditshock-ecwa-certificate.pdf');
if(createHash('sha256').update(source).digest('hex')!=='67e2e046c49fe47228aa107a9fd20c2303e621103a881a1ef610932fb682a2ad')throw new Error('Public source hash mismatch');
execFileSync('pdfseparate',['-f','32','-l','32','/tmp/auditshock-ecwa-certificate.pdf','/tmp/auditshock-ecwa-page-%d.pdf']);
writeFileSync('/tmp/auditshock-live-ai.jsonc',JSON.stringify({name:'auditshock-ai-validation',compatibility_date:'2026-10-06',ai:{binding:'AI',remote:true}}));
const platform=await getPlatformProxy({configPath:'/tmp/auditshock-live-ai.jsonc',persist:false});
const db=sqliteDatabase(':memory:');
try{
 for(const file of readdirSync('migrations').sort())await db.batch(readFileSync(`migrations/${file}`,'utf8').replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
 await db.batch([db.prepare("INSERT INTO users(id,email) VALUES('public','public@example.org')"),db.prepare("INSERT INTO audits(id,user_id,status) VALUES('public','public','DRAFT')"),db.prepare("INSERT INTO documents(id,audit_id,object_key,original_filename,mime_type,sha256,size_bytes,document_type,processing_status) VALUES('public','public','public-key','ecwa-coi-page-32.pdf','application/pdf','public',1,'UNKNOWN','UPLOADED')")]);
 const bucket=memoryBucket();await bucket.put('public-key',readFileSync('/tmp/auditshock-ecwa-page-32.pdf'));
 const env={AI:platform.env.AI,AUDITSHOCK_DB:db,AUDITSHOCK_DOCS:bucket} as any;
 const doc=await db.prepare("SELECT * FROM documents WHERE id='public'").first();
 const started=performance.now();await processDocument(env,'public',doc);const audit=await analyzeAudit(env,'public');
 const state=await db.prepare("SELECT processing_status,review_error,document_type FROM documents WHERE id='public'").first();
 const counts=await db.prepare("SELECT (SELECT COUNT(*) FROM document_facts) AS facts,(SELECT COUNT(*) FROM coverage_records) AS coverages,(SELECT COUNT(*) FROM coverage_records WHERE review_status='CONFIRMED') AS confirmed_coverages").first();
 if(state.processing_status!=='NEEDS_REVIEW'||audit.status!=='NEEDS_INPUT'||counts.confirmed_coverages!==0)throw new Error('Unsafe public sample acceptance');
 const result={kind:'live-public-certificate-production-pipeline',workers_ai_direct:true,elapsedMs:Math.round(performance.now()-started),document:state,counts,audit};
 writeFileSync('/tmp/auditshock-live-pipeline-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{db.close();await platform.dispose();}
