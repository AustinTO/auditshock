import { describe, it, expect, vi } from 'vitest';
import { ledgerMapping, normalizeDate, processDocument, analyzeAudit } from '../src/analysis/audit';
function mockDb(select: (sql: string) => any[] = () => []) {
  const writes: {sql:string; values:any[]}[] = [];
  const db = {prepare: (sql:string) => ({values:[] as any[],bind(...values:any[]) {this.values=values;return this;},all:async () => ({results:select(sql)}),run:async function() {writes.push({sql,values:this.values});return {success:true};}}),batch:async (statements:any[]) => Promise.all(statements.map(s => s.run()))};
  return {db,writes};
}
function paymentWrites(writes: {sql:string;values:any[]}[]) {
  return writes.filter(w => w.sql.includes('INTO payments')).flatMap(w => Array.from({length:w.values.length/8}, (_,index) => ({sql:w.sql,values:w.values.slice(index*8,index*8+8)})));
}
describe('workflow safety', () => {
  it('recognizes conventional headers', () => expect(ledgerMapping('\uFEFFVendor Name,Payment Amount,Payment Date,Description\n')).toEqual({vendor:'vendor name',amount:'payment amount',date:'payment date',memo:'description'}));
  it('rejects missing columns', () => expect(() => ledgerMapping('vendor,memo')).toThrow());
  it('validates actual calendar dates', () => {expect(normalizeDate('2/29/2024')).toBe('2024-02-29');expect(normalizeDate('2025-02-29')).toBeUndefined();expect(normalizeDate('10/7/26')).toBeUndefined();});
  it('bypasses AI for CSV and uses stable retry IDs', async () => {
    const {db,writes}=mockDb();const ai={run:vi.fn(),toMarkdown:vi.fn()};
    const env={AUDITSHOCK_DB:db,AUDITSHOCK_DOCS:{get:async () => ({text:async () => 'vendor,amount,date,memo\nAcme LLC,123.45,2026-10-07,Invoice 1\n'})},AI:ai} as any;
    const doc={id:'doc',original_filename:'ledger.csv',mime_type:'text/csv',object_key:'key',processing_status:'UPLOADED'};
    await processDocument(env,'audit',doc);await processDocument(env,'audit',doc);
    expect(ai.run).not.toHaveBeenCalled();expect(ai.toMarkdown).not.toHaveBeenCalled();
    const payments=paymentWrites(writes);expect(payments).toHaveLength(2);expect(payments[0]!.values).toEqual(payments[1]!.values);expect(payments[0]!.values[5]).toBe(12345);
  });
  it('requires input for empty audit', async () => {
    const {db}=mockDb(sql => sql === 'SELECT * FROM audits WHERE id = ?' ? [{id:'audit'}] : []);
    expect(await analyzeAudit({AUDITSHOCK_DB:db} as any,'audit')).toMatchObject({status:'NEEDS_INPUT'});
  });
  it('does not estimate using payment dates as work dates', async () => {
    const {db,writes}=mockDb(sql => sql === 'SELECT * FROM audits WHERE id = ?' ? [{policy_period_start:'2026-01-01',policy_period_end:'2026-12-31',assumptions_confirmed_at:'today',exposure_basis:'FULL_VENDOR_PAYMENTS',wc_rate_micros_per_100:5000000}] : sql.startsWith('SELECT * FROM payments') ? [{vendor_id:'v',amount_cents:10000,payment_date:'2026-10-07'}] : sql.startsWith('SELECT * FROM vendors') ? [{id:'v'}] : []);
    expect(await analyzeAudit({AUDITSHOCK_DB:db} as any,'audit')).toMatchObject({status:'NEEDS_INPUT'});
    expect(writes.find(w => w.sql.includes('INTO findings'))?.values[5]).toBeNull();
  });
  it('imports the four-row synthetic baseline totaling 820000 cents', async () => {
    const {db,writes}=mockDb();
    const content='Vendor,Payment Date,Amount,Memo\nSmith Roofing LLC,2026-06-01,$1500.00,Inv 101\nABC Construction,2026-06-15,$5000.00,June Draw\nJane Doe,2026-07-01,$200.00,Misc repairs\n"Smith Roofing, L.L.C.",2026-07-05,$1500.00,Inv 102\n';
    await processDocument({AUDITSHOCK_DB:db,AUDITSHOCK_DOCS:{get:async () => ({text:async () => content})}} as any,'audit',{id:'doc',object_key:'key',original_filename:'ledger.csv',mime_type:'text/csv'});
    const payments=paymentWrites(writes);
    expect(payments).toHaveLength(4);
    expect(payments.reduce((sum,p) => sum+p.values[5],0)).toBe(820000);
    expect(payments[0]!.values[2]).toBe(payments[3]!.values[2]);
  });

  it('labels out-of-period work as excluded rather than documented coverage', async () => {
    const {db,writes}=mockDb(sql => sql === 'SELECT * FROM audits WHERE id = ?' ? [{policy_period_start:'2026-01-01',policy_period_end:'2026-12-31',assumptions_confirmed_at:'today',exposure_basis:'FULL_VENDOR_PAYMENTS',wc_rate_micros_per_100:5000000}] : sql.startsWith('SELECT * FROM payments') ? [{vendor_id:'v',amount_cents:10000,work_start_date:'2025-06-01',work_end_date:'2025-06-30'}] : sql.startsWith('SELECT * FROM vendors') ? [{id:'v'}] : []);
    expect(await analyzeAudit({AUDITSHOCK_DB:db} as any,'audit')).toMatchObject({status:'COMPLETE'});
    const finding = writes.find(w => w.sql.includes('INTO findings'));
    expect(finding?.values[3]).toBe('OUTSIDE_AUDIT_PERIOD');
    expect(finding?.values[5]).toBe(0);
  });

  it('rejects an unusable later vendor before persisting any rows', async () => {
    const {db,writes}=mockDb();
    await expect(processDocument({AUDITSHOCK_DB:db,AUDITSHOCK_DOCS:{get:async () => ({text:async () => 'vendor,amount\nAcme,10\nLLC,20\n'})}} as any,'audit',{id:'doc',object_key:'key',original_filename:'ledger.csv'})).rejects.toThrow('usable business name');
    expect(writes).toHaveLength(0);
  });
  it('rejects oversized ledgers before database writes', async () => {
    const {db,writes}=mockDb();
    const content='vendor,amount\n'+Array.from({length:1001}, () => 'Acme,1').join('\n');
    await expect(processDocument({AUDITSHOCK_DB:db,AUDITSHOCK_DOCS:{get:async () => ({text:async () => content})}} as any,'audit',{id:'doc',object_key:'key',original_filename:'ledger.csv'})).rejects.toThrow('1000');
    expect(writes).toHaveLength(0);
  });
  it('skips processed ledgers without resetting human work dates', async () => {
    const {db,writes}=mockDb();const get=vi.fn();
    await processDocument({AUDITSHOCK_DB:db,AUDITSHOCK_DOCS:{get}} as any,'audit',{processing_status:'PROCESSED'});
    expect(get).not.toHaveBeenCalled();expect(writes).toHaveLength(0);
  });
  it('rejects superseded workflows before processing', async () => {
    const {db,writes}=mockDb();
    await expect(processDocument({AUDITSHOCK_DB:db} as any,'audit',{processing_status:'UPLOADED'},'old-run')).rejects.toThrow('superseded');
    expect(writes).toHaveLength(0);
  });
  it('records AI failures as explicit review work without accepting facts', async () => {
    const {db,writes}=mockDb();
    const env={AUDITSHOCK_DB:db,AUDITSHOCK_DOCS:{get:async () => ({text:async () => 'Certificate text'})},AI:{run:vi.fn().mockRejectedValue(new Error('provider error'))}} as any;
    await processDocument(env,'audit',{id:'doc',original_filename:'coi.pdf',object_key:'key',markdown_object_key:'markdown'});
    const update=writes.find(w => w.sql.includes('review_error = ?'));
    expect(update?.values[1]).toContain('Automatic extraction failed');
    expect(writes.some(w => w.sql.includes('INTO coverage_records'))).toBe(false);
  });

  it('bounds database import batches and clears unfinished rows first', async () => {
    const {db,writes}=mockDb();const sizes:number[]=[];const batch=db.batch;
    db.batch=async statements => {sizes.push(statements.length);return batch(statements);};
    await processDocument({AUDITSHOCK_DB:db,AUDITSHOCK_DOCS:{get:async () => ({text:async () => 'vendor,amount\n'+Array.from({length:101}, () => 'Acme,1').join('\n')})}} as any,'audit',{id:'doc',object_key:'key',original_filename:'ledger.csv'});
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
    expect(writes[0]?.sql).toContain('DELETE FROM payments');
    expect(paymentWrites(writes)).toHaveLength(101);
  });

  it.each([
    {readable:0.7724,manual:0.1241,kind:'coi',confidence:0.99},
    {readable:0.99,manual:0.1,kind:'coi',confidence:0.99},
    {readable:0.89,manual:0.01,kind:'coi',confidence:0.99},
    {readable:0.99,manual:0.01,kind:'coi',confidence:0.79},
    {readable:0.99,manual:0.01,kind:'other',confidence:0.99},
  ])('does not persist associations from ambiguous source routing: %j', async fixture => {
    const {db,writes}=mockDb();
    const run=vi.fn().mockResolvedValue({answers:{document_type:{probabilities:{[fixture.kind]:fixture.confidence}},readable_enough:{p_yes:fixture.readable},needs_manual_review:{p_yes:fixture.manual}}});
    // Real-shaped flattened certificate output loses the form's original field relationships.
    const flattened='CERTIFICATE OF LIABILITY INSURANCE\nERIE COUNTY WATER AUTHORITY\nNAMED INSURED\nCONTRACTOR LLC\nCERTIFICATE HOLDER\nINSURER A INSURER B\nWORKERS COMPENSATION';
    await processDocument({AUDITSHOCK_DB:db,AUDITSHOCK_DOCS:{get:async () => ({text:async () => flattened})},AI:{run}} as any,'audit',{id:'doc',original_filename:'ecwa-coi.pdf',markdown_object_key:'markdown'});
    expect(run).toHaveBeenCalledOnce();
    expect(writes.some(w => /INTO (document_facts|coverage_records)/.test(w.sql))).toBe(false);
    const review=writes.find(w => w.sql.includes('review_error = ?'));
    expect(review?.values[1]).toContain('Source layout or classification is ambiguous');
    expect(review?.values[1]).toContain('original document');
  });
  it('routes clear supported policy content to extraction and human review', async () => {
    const {db,writes}=mockDb();
    const extraction=Object.fromEntries(['insured_name','carrier','policy_number','policy_start','policy_end','audit_due_date','auditor_contact','audit_instructions','subcontractor_documentation_language'].map(key => [key,{value:null,confidence:null,source_excerpt:null}]));
    const run=vi.fn().mockResolvedValueOnce({answers:{document_type:{probabilities:{wc_policy:0.99}},readable_enough:{p_yes:0.99},needs_manual_review:{p_yes:0.01}}}).mockResolvedValueOnce({response:JSON.stringify(extraction)});
    await processDocument({AUDITSHOCK_DB:db,AUDITSHOCK_DOCS:{get:async () => ({text:async () => 'Workers compensation policy'})},AI:{run}} as any,'audit',{id:'doc',original_filename:'policy.pdf',markdown_object_key:'markdown'});
    expect(run).toHaveBeenCalledTimes(2);
    expect(writes.some(w => w.sql.includes('INTO document_facts'))).toBe(true);
    expect(writes.find(w => w.sql.includes('review_error = NULL'))?.sql).toContain("processing_status = 'NEEDS_REVIEW'");
  });

  it.each([
    {vendors:[],payments:995,content:'vendor,amount\n'+Array.from({length:6},() => 'Acme,1').join('\n'),limit:'1000 payment'},
    {vendors:Array.from({length:200},(_,index) => ({id:String(index),normalized_name:'existing '+index})),payments:0,content:'vendor,amount\nNew company,1',limit:'200 vendor'},
    {vendors:[],payments:0,content:'vendor,amount\n'+Array.from({length:201},(_,index) => 'Vendor '+index+',1').join('\n'),limit:'200 vendor'},
  ])('rejects aggregate audit limits before clearing or inserting rows: $limit', async fixture => {
    const {db,writes}=mockDb(sql => sql.startsWith('SELECT id, normalized_name FROM vendors') ? fixture.vendors : sql.startsWith('SELECT COUNT(*) AS count FROM payments') ? [{count:fixture.payments}] : []);
    await expect(processDocument({AUDITSHOCK_DB:db,AUDITSHOCK_DOCS:{get:async () => ({text:async () => fixture.content})}} as any,'audit',{id:'doc',original_filename:'ledger.csv',object_key:'key'})).rejects.toThrow(fixture.limit);
    expect(writes).toHaveLength(0);
  });
  it('reuses existing vendor identities and bulk inserts payments with at most 80 parameters', async () => {
    const {db,writes}=mockDb(sql => sql.startsWith('SELECT id, normalized_name FROM vendors') ? [{id:'existing',normalized_name:'acme'}] : []);
    await processDocument({AUDITSHOCK_DB:db,AUDITSHOCK_DOCS:{get:async () => ({text:async () => 'vendor,amount\n'+Array.from({length:101},() => 'Acme,1').join('\n')})}} as any,'audit',{id:'doc',original_filename:'ledger.csv',object_key:'key'});
    const batches=writes.filter(w => w.sql.includes('INTO payments'));
    expect(batches).toHaveLength(11);
    expect(Math.max(...batches.map(batch => batch.values.length))).toBe(80);
    expect(writes.filter(w => w.sql.includes('INTO vendors'))).toHaveLength(0);
    expect(paymentWrites(writes).every(row => row.values[2] === 'existing')).toBe(true);
  });

});
