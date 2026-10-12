// Deterministic test of the REAL fence hook (no model involved).
import { fenceHook, tmSetupLine } from './server.mjs';
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
  ['Bash', { command: 'gh pr list' }, 'allow'],                      // her eyes: read-only looks
  ['Agent', { description: 'check PRs', subagent_type: 'reader' }, 'allow'],
  ['Agent', { description: 'x', run_in_background: false }, 'deny'], // never blocks on a worker
  ['Read', { file_path: `${hub}/mind/workload.md` }, 'allow'],
  ['Edit', { file_path: `${hub}/mind/workload.md` }, 'allow'],
  ['Write', { file_path: '/home/x/code/some-repo/src/x.ts' }, 'deny'],
  ['Write', { file_path: '/tmp/../tmp/sahar-escape.md' }, 'deny'],
  ['NotebookEdit', {}, 'deny'],
];
let bad = 0;
// TrueMemory is required: not connected is a setup item with a one-line fix.
if (!/not connected/.test(tmSetupLine(false)) || !/Connect TrueMemory/.test(tmSetupLine(false)) || !/connected/.test(tmSetupLine(true))) { bad++; console.log('MISMATCH tm setup line'); }
// Her eyes (main thread Bash): read-only allowlist.
const looks = [
  'git log --oneline -5', 'git -C /x diff HEAD~1', 'git status', 'git branch -a', 'git show abc123 --stat',
  'git remote -v', 'git ls-remote origin', 'gh pr view 174', 'gh pr checks 174', 'gh run list --limit 5',
  'gh api repos/o/r/pulls/1', 'gh api -X GET repos/o/r/pulls', 'ls -la /tmp', 'cat /tmp/a.log | tail -50',
  'grep -rn "a|b" src', 'rg foo | wc -l', 'find . -name "*.png"', 'curl -s https://example.com/health', 'lsof -i :4747',
  'ps aux | grep node', 'git log --oneline | head -3', 'date', 'git rev-parse HEAD', 'stat x', 'pwd',
];
const notLooks = [
  'git push', 'git push origin feat-x', 'gh pr merge 174', 'gh pr create --fill', 'gh api -X POST repos/o/r/issues',
  'gh api repos/o/r/issues -f title=x', 'gh api --method PATCH repos/o/r', 'curl -d a=b https://x', 'curl -X POST https://x',
  'curl -o out.txt https://x', 'cat x > y', 'cat x >> y', 'ls; rm -rf /', 'ls && rm x', 'ls || rm x', 'find . -delete',
  'find . -exec rm {} +', 'git log | sh', 'cat x | tee y', 'echo hi', 'FOO=1 ls', 'cd /tmp && ls', 'ls `whoami`', 'ls $(whoami)',
  'cat <(ls)', 'git commit -m x', 'git branch -D x', 'git checkout main', 'git -c core.pager=sh log', 'sudo ls', 'rm x', 'kill 123',
  'ls | xargs rm', 'sort -o out.txt in.txt', 'git diff --output=x', 'tail -f x.log', 'npm test', 'node x.js', 'git stash',
];
for (const c of looks) { const got = await main('Bash', { command: c }); if (got !== 'allow') { bad++; console.log(`MISMATCH eyes ${c} got=${got} expected=allow`); } }
for (const c of notLooks) { const got = await main('Bash', { command: c }); if (got !== 'deny') { bad++; console.log(`MISMATCH eyes ${c} got=${got} expected=deny`); } }
for (const [tool, input, exp] of mainCases) {
  const got = await main(tool, input);
  if (got !== exp) { bad++; console.log(`MISMATCH main ${tool} ${JSON.stringify(input)} got=${got} expected=${exp}`); }
}
for (const [msg, cmd, exp] of cases) {
  const got = await run(msg, cmd);
  if (got !== exp) { bad++; console.log(`MISMATCH  msg=${JSON.stringify(msg)}  cmd=${JSON.stringify(cmd)}  got=${got} expected=${exp}`); }
}
console.log(bad ? `FAILED (${bad})` : `fence: all ${cases.length + mainCases.length + looks.length + notLooks.length + 1} cases ok`);
process.exit(bad ? 1 : 0);
