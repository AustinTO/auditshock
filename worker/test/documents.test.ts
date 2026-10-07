import { describe,it,expect,vi } from 'vitest';
import { convertToMarkdown } from '../src/documents/convert';
function setup(response:unknown) {
 const put=vi.fn(),run=vi.fn(),toMarkdown=vi.fn().mockResolvedValue(response);
 return {env:{AI:{toMarkdown},AUDITSHOCK_DOCS:{get:async()=>({arrayBuffer:async()=>new TextEncoder().encode('content').buffer}),put},AUDITSHOCK_DB:{prepare:()=>({bind:()=>({run})})}} as any,put,run,toMarkdown};
}
describe('Document conversion',()=>{
 it('passes Blob and persists real provider content',async()=>{
 const {env,put,run,toMarkdown}=setup({format:'markdown',data:'# Real content'});
 await convertToMarkdown(env,'audit','doc','key','file.pdf');
 expect(toMarkdown.mock.calls[0]![0].name).toBe('file.pdf');expect(toMarkdown.mock.calls[0]![0].blob).toBeInstanceOf(Blob);
 expect(put.mock.calls[0]![1]).toBe('# Real content');expect(run).toHaveBeenCalledOnce();
 });
 it.each([{format:'error',error:'Unreadable'},{format:'markdown',data:' '}])('rejects failed or empty conversion %j',async response=>{
 const {env,put,run}=setup(response);await expect(convertToMarkdown(env,'audit','doc','key','file.pdf')).rejects.toThrow();
 expect(put).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
 });
});
