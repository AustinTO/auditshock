import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { askClef } from '../src/ai/clef';
import { runStructuredExtraction, saveExtractedFacts } from '../src/ai/extraction';
function setup(answers: unknown) {
 const run = vi.fn(); const bind = vi.fn().mockReturnValue({ run });
 const ai = vi.fn().mockResolvedValue({ answers });
 return { env: { AI: { run: ai }, AUDITSHOCK_DB: { prepare: () => ({ bind }) } } as any, run, bind, ai };
}
describe('AI contracts', () => {
 it('uses typed Clef questions and normalizes probabilities', async () => {
  const {env, ai, run} = setup({same_business: 0.97, match_strength: 4, primary_reason: { probabilities: { exact_or_format: 1 } }});
  const result = await askClef(env, 'audit', null, 'VENDOR_MATCH', {name:'Example'});
  expect(ai.mock.calls[0]![1]).toMatchObject({model:'clef-flash',state:{name:'Example'},questions:{same_business:{type:'noul'}}});
  expect(result.same_business).toEqual({p_yes:0.97}); expect(run).toHaveBeenCalledOnce();
 });
 it('uses Workers AI directly unless a gateway is explicitly configured', async () => {
  const {env,ai}=setup({same_business:{noul:0.9},match_strength:4,primary_reason:{probabilities:{exact_or_format:1}}});
  await askClef(env,'audit',null,'VENDOR_MATCH',{});
  expect(ai.mock.calls[0]![2]).toEqual({});
  env.AI_GATEWAY_ID='optional-gateway';
  await askClef(env,'audit',null,'VENDOR_MATCH',{});
  expect(ai.mock.calls[1]![2]).toMatchObject({gateway:{id:'optional-gateway',collectLog:false,skipCache:true}});
 });
 it('accepts the observed hosted Clef noul response', async () => {
  const {env}=setup({same_business:{type:'noul',noul:0.9251},match_strength:4,primary_reason:{probabilities:{exact_or_format:1}}});
  expect((await askClef(env,'audit',null,'VENDOR_MATCH',{})).same_business).toEqual({p_yes:0.9251});
 });
 it('rejects invalid probabilities before persisting', async () => {
  const {env,run}=setup({same_business:2});
  await expect(askClef(env,'audit',null,'VENDOR_MATCH',{})).rejects.toThrow('Invalid Clef'); expect(run).not.toHaveBeenCalled();
 });
 it('supplies extraction schema and rejects invalid output', async () => {
  const run=vi.fn().mockResolvedValue({response:'{"name":42}'});
  await expect(runStructuredExtraction({AI:{run}} as any,'Example',z.object({name:z.string()}))).rejects.toThrow();
  expect(run.mock.calls[0]![1]).toMatchObject({max_tokens:4096,temperature:0});
  expect(run.mock.calls[0]![1].prompt).toContain('"name"');
 });
 it('validates structured provider JSON responses as well as text JSON', async () => {
  const schema=z.object({name:z.string()});
  for(const response of [{response:{name:'Example'}},{name:'Example'}]) {
   await expect(runStructuredExtraction({AI:{run:vi.fn().mockResolvedValue(response)}} as any,'Example',schema)).resolves.toEqual({name:'Example'});
  }
 });
 it('requires source excerpts to occur in the supplied document', async () => {
  const field = z.object({ value: z.string().nullable(), source_excerpt: z.string().nullable() });
  const run = vi.fn().mockResolvedValue({ response: JSON.stringify({ name: { value: 'Example', source_excerpt: 'Invented' } }) });
  await expect(runStructuredExtraction({ AI: { run } } as any, 'Example', z.object({ name: field }))).rejects.toThrow('supporting source excerpt');
  run.mockResolvedValue({ response: JSON.stringify({ name: { value: 'Example', source_excerpt: 'Example' } }) });
  await expect(runStructuredExtraction({ AI: { run } } as any, 'Example', z.object({ name: field }))).resolves.toMatchObject({ name: { value: 'Example' } });
 });
 it('does not fabricate confidence' , async () => {
  const {env,bind}=setup({}); await saveExtractedFacts(env,'doc','COI',{}); expect(bind.mock.calls[0]!.at(-1)).toBeNull();
 });
});
