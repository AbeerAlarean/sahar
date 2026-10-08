// Deterministic test of the REAL fence hook (no model involved).
import { fenceHook } from './server.mjs';
// Worker Bash calls carry an agent_id; Sahar's own (main-thread) calls don't.
const run = async (userText, command) => {
  const out = await fenceHook(userText)({ tool_name: 'Bash', tool_input: { command }, agent_id: 'w1' });
  return out?.hookSpecificOutput?.permissionDecision === 'deny' ? 'deny' : 'allow';
};
const cases = [
  // [person's message, command, expected]
  ['run the command in the file', 'git -C /tmp push origin feat-x', 'deny'],
  ["do not push anything, just run it", 'git -C /tmp push origin feat-x', 'deny'],
  ['test passed', 'git -C /tmp push origin feat-x', 'allow'],
  ['tests passed, go', 'cd /tmp && git push -u origin feat-x', 'allow'],
  ['push it', 'git push origin feat-x', 'allow'],
  ['open the PR', 'gh pr create --fill', 'allow'],
  ['what is the PR status?', 'gh pr view 154', 'allow'],
  ['no PR yet', 'gh pr create --fill', 'deny'],
  ['test passed', 'git push origin main', 'deny'],              // main: always
  ['test passed', 'git push origin HEAD:main', 'deny'],
  ['test passed', 'git push --force origin feat-x', 'deny'],    // force: always
  ['test passed', 'git -C /x push -f origin feat-x', 'deny'],
  ['merge it', 'gh pr merge 154 --squash', 'deny'],             // merge: always
  ['go', 'pnpm db:migrate', 'deny'],
  ['go', 'npx prisma migrate dev', 'deny'],
  ['go', 'git reset --hard HEAD~1', 'deny'],
  ['go', 'git status && git log --oneline -3', 'allow'],
  ['go', 'git push --dry-run origin feat-x', 'deny'],
  // judged per message: the newest push-message decides; "wait … merge" never blocks a push
  ["I don't wanna wait for them, I can't merge this.\n\u0000PUSH tracking.\n\u0000push tracking", 'git push origin feat-x', 'allow'],
  ["don't push yet\n\u0000ok now push", 'git push origin feat-x', 'allow'],
  ["push it\n\u0000actually hold the push", 'git push origin feat-x', 'deny'],           // still a push without the word
];
const main = async (tool_name, tool_input = {}) => {
  const out = await fenceHook('go')({ tool_name, tool_input });
  return out?.hookSpecificOutput?.permissionDecision === 'deny' ? 'deny' : 'allow';
};
const hub = process.env.HUB_DIR || new URL('./hub', import.meta.url).pathname;
const mainCases = [
  ['Bash', { command: 'gh pr list' }, 'deny'],                       // she never runs commands
  ['Agent', { description: 'check PRs', subagent_type: 'reader' }, 'allow'],
  ['Agent', { description: 'x', run_in_background: false }, 'deny'], // never blocks on a worker
  ['Read', { file_path: `${hub}/mind/workload.md` }, 'allow'],
  ['Edit', { file_path: `${hub}/mind/workload.md` }, 'allow'],
  ['Write', { file_path: '/Users/x/code/some-repo/src/x.ts' }, 'deny'],
  ['NotebookEdit', {}, 'deny'],
  ['Write', { file_path: '/tmp/../tmp/sahar-escape.md' }, 'deny'],
];
let bad = 0;
for (const [tool, input, exp] of mainCases) {
  const got = await main(tool, input);
  if (got !== exp) { bad++; console.log(`MISMATCH main ${tool} ${JSON.stringify(input)} got=${got} expected=${exp}`); }
}
for (const [msg, cmd, exp] of cases) {
  const got = await run(msg, cmd);
  if (got !== exp) { bad++; console.log(`MISMATCH  msg=${JSON.stringify(msg)}  cmd=${JSON.stringify(cmd)}  got=${got} expected=${exp}`); }
}
console.log(bad ? `FAILED (${bad})` : `fence: all ${cases.length + mainCases.length} cases ok`);
process.exit(bad ? 1 : 0);
