import type { Blob as WorkerBlob } from '@cloudflare/workers-types';
import { Bindings } from '../types/env';

export async function convertToMarkdown(
  env: Bindings,
  auditId: string,
  docId: string,
  objectKey: string,
  filename: string
): Promise<string> {
  // Fetch the file from R2
  const r2Object = await env.AUDITSHOCK_DOCS.get(objectKey);
  if (!r2Object) {
    throw new Error('Document not found in R2');
  }

  const arrayBuffer = await r2Object.arrayBuffer();
  const response = await env.AI.toMarkdown({
    name: filename,
    blob: new Blob([arrayBuffer], { type: r2Object.httpMetadata?.contentType || 'application/octet-stream' }) as unknown as WorkerBlob
  });
  if (response.format === 'error') throw new Error(`Document conversion failed: ${response.error}`);
  if (!response.data?.trim()) throw new Error('Document conversion returned empty content');
  const markdown = response.data;

  // Store the markdown object in R2
  const markdownKey = `audits/${auditId}/docs/${docId}-markdown.md`;
  await env.AUDITSHOCK_DOCS.put(markdownKey, markdown, {
    httpMetadata: { contentType: 'text/markdown' }
  });

  // Update document record in D1
  await env.AUDITSHOCK_DB.prepare(
    `UPDATE documents SET markdown_object_key = ?, processing_status = 'CONVERTED' WHERE id = ?`
  ).bind(markdownKey, docId).run();

  return markdownKey;
}
