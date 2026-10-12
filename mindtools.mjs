// Sahar's brain as tools on her main thread: an in-process SDK MCP server named "mind".
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as tm from './tm.mjs';
import { saveKnowledge } from './seed.mjs';

export const MIND_TOOLS = ['mcp__mind__ask_mind', 'mcp__mind__remember', 'mcp__mind__save_knowledge'];

const NOT_CONNECTED = 'TrueMemory not connected — ask the person to Connect TrueMemory (the pill at the top of the window). Meanwhile use the local notes in mind/.';
const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (err) => ({ content: [{ type: 'text', text: err instanceof tm.TmError && /Not connected|expired|Connect/i.test(err.message) ? NOT_CONNECTED : tm.friendlyError(err) }], isError: true });

/** consult() result → compact text: ≤12 facts, ≤6 excerpts of ≤1500 chars. */
export function formatConsult(c, { maxFacts = 12, maxExcerpts = 6, maxChars = 1500 } = {}) {
  const fact = (m) => (typeof m === 'string' ? m : m?.fact || m?.content || m?.text || m?.memory || JSON.stringify(m));
  const facts = (c?.memories || []).slice(0, maxFacts).map((m) => `- ${String(fact(m)).trim()}`);
  const ex = (c?.excerpts || []).slice(0, maxExcerpts).map((e) => `[${e.filename || 'note'}]\n${String(e.content || '').slice(0, maxChars).trim()}`);
  if (!facts.length && !ex.length) return 'Nothing in the mind matched that.';
  return [facts.length ? `FACTS\n${facts.join('\n')}` : '', ex.length ? `EXCERPTS\n${ex.join('\n\n')}` : ''].filter(Boolean).join('\n\n');
}

export const mindServer = createSdkMcpServer({
  name: 'mind',
  version: '1.0.0',
  tools: [
    tool('ask_mind', "Ask your mind (the person's TrueMemory): decisions with reasons, project notes, history, lessons. Call before answering or briefing on any task. Returns facts and note excerpts.", { query: z.string().min(2) }, async ({ query }) => {
      try { return text(formatConsult(await tm.consult(query))); } catch (err) { return fail(err); }
    }),
    tool('remember', 'Write one decision, rule, correction, fact or task outcome into your memory, with the reason, in plain sentences. Also append decisions to mind/decisions.md locally.', { text: z.string().min(3) }, async ({ text: t }) => {
      try { await tm.addMemory(t); return text('Remembered.'); } catch (err) { return fail(err); }
    }),
    tool('save_knowledge', 'Save or replace a project note or document in your mind as markdown. Same filename replaces the earlier one.', { filename: z.string().min(3), markdown: z.string().min(1) }, async ({ filename, markdown }) => {
      try { const r = await saveKnowledge(filename, markdown); return text(`Saved ${r.name} (${r.status}).`); } catch (err) { return fail(err); }
    }),
  ],
});
