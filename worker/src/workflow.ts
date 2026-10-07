import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { Bindings } from './types/env';
import { processDocument, analyzeAudit, assertWorkflowCurrent, MAX_AUDIT_DOCUMENTS } from './analysis/audit';
export class AuditWorkflow extends WorkflowEntrypoint<Bindings, { auditId: string; runId: string }> {
  async run(event: WorkflowEvent<{ auditId: string; runId: string }>, step: WorkflowStep) {
    const { auditId, runId } = event.payload;
    if (!runId) {
      await this.env.AUDITSHOCK_DB.prepare("UPDATE audits SET status = 'FAILED', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workflow_id IS NULL AND status = 'PROCESSING'").bind(auditId).run();
      throw new Error('Legacy workflow requires a new analysis run');
    }
    try {
      await assertWorkflowCurrent(this.env, auditId, runId);
      const docs = await step.do('INVENTORY_DOCUMENTS', async () => (await this.env.AUDITSHOCK_DB.prepare('SELECT * FROM documents WHERE audit_id = ?').bind(auditId).all()).results as {id:string; original_filename:string; mime_type:string; object_key:string; processing_status:string; markdown_object_key:string | null}[]);
      if (docs.length > MAX_AUDIT_DOCUMENTS) throw new Error('Audit exceeds 50 document limit');
      for (const doc of docs) await step.do(`PROCESS_${doc.id}`, () => processDocument(this.env, auditId, doc, runId));
      return await step.do('ANALYZE_AUDIT', () => analyzeAudit(this.env, auditId, runId));
    } catch (error) {
      await this.env.AUDITSHOCK_DB.prepare("UPDATE audits SET status = 'FAILED', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workflow_id = ? AND status = 'PROCESSING'").bind(auditId,runId).run();
      throw error;
    }
  }
}
