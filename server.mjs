import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as tm from './tm.mjs';
import { readOnlyBash } from './eyes.mjs';
import { slugOf, taskOfWorker, uncheckedTasks, overlayVerify, uncheckedNote } from './checks.mjs';
import { parseResetTime, looksLikeLimit, isAway, wakeDecision, capMath, weekWindow, createUsageMeter } from './night.mjs';

// Sahar — one continuous conversation about all of a builder's work.
// She never does the work herself: every task goes to a background worker, so she is
// never busy and a message is never queued. One long-lived conversation; messages are
// fed into it the moment they are typed. Nothing here is specific to one person or machine.
const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
// Your own Sahar lives next to the code: hub/ is her brain (her notes), data/ is your
// conversation and dropped files. Both are git-ignored; override with HUB_DIR / DATA_DIR.
const HUB_DIR = process.env.HUB_DIR || path.join(UI_DIR, 'hub');
const DATA_DIR = process.env.DATA_DIR || path.join(UI_DIR, 'data');
const TEMPLATE_DIR = path.join(UI_DIR, 'hub-template');

/** First run: give her an empty brain from the template (never overwrites anything). */
function ensureHub() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(TEMPLATE_DIR)) return;
  const copy = (from, to) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); copy(src, dst); }
      else if (!fs.existsSync(dst) && entry.name !== '.gitkeep') fs.copyFileSync(src, dst);
    }
  };
  fs.mkdirSync(HUB_DIR, { recursive: true });
  copy(TEMPLATE_DIR, HUB_DIR);
}

/** TrueMemory is required for Sahar: the line she is told about it at First Contact. */
export function tmSetupLine(connected) {
  return connected
    ? 'TrueMemory: connected.'
    : 'TrueMemory: not connected — a setup item. Fix: click "Connect TrueMemory" in the window (top right) and sign in with your TrueMemory email and password.';
}
// Whether a saved TrueMemory sign-in exists; refreshed at start and after connecting.
let tmConnected = false;
async function refreshTmSetup() { try { tmConnected = await tm.hasLogin(); } catch { tmConnected = false; } }

/** What she needs on this machine, checked at start — told to her plainly at First Contact. */
function setupCheck(tmConnected) {
  const run = (cmd, args) => {
    try { return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }) }; }
    catch (err) { return { ok: false, out: String(err.stdout || err.stderr || err.message || '') }; }
  };
  const claude = run('claude', ['auth', 'status']);
  let claudeLine = 'Claude Code: could not check (the claude command is not on PATH) — if replies fail, run "claude" once and sign in.';
  if (claude.ok || claude.out) {
    try { claudeLine = JSON.parse(claude.out).loggedIn ? 'Claude Code: signed in.' : 'Claude Code: NOT signed in — run "claude" and sign in.'; }
    catch { claudeLine = claude.ok ? 'Claude Code: signed in.' : 'Claude Code: NOT signed in — run "claude" and sign in.'; }
  }
  const gh = run('gh', ['auth', 'status']);
  const ghLine = gh.ok ? 'GitHub CLI: signed in.' : 'GitHub CLI: not signed in or not installed — PRs and authorship need it ("brew install gh" then "gh auth login").';
  const git = run('git', ['--version']);
  return [claudeLine, ghLine, git.ok ? 'git: installed.' : 'git: NOT installed.', tmSetupLine(tmConnected)].join('\n');
}
const STATE_FILE = path.join(DATA_DIR, '.session.json');
const THREAD_FILE = path.join(DATA_DIR, '.thread.json');
const PORT = Number(process.env.PORT || 4747);
const MAIN_MODEL_DEFAULT = process.env.MAIN_MODEL || 'claude-opus-5-5';
// the model she thinks on — switchable from the window (to save tokens), remembered across restarts
const MODEL_CHOICES = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-1'];
const MODEL_FILE = path.join(DATA_DIR, '.model');
let MAIN_MODEL = (() => { try { const m = fs.readFileSync(MODEL_FILE, 'utf8').trim(); return MODEL_CHOICES.includes(m) ? m : MAIN_MODEL_DEFAULT; } catch { return MAIN_MODEL_DEFAULT; } })();
// Rotate the hidden conversation when its context passes this share of the window OR this
// many tokens, and only while no worker is running (a rotation would end them).
const ROTATE_AT = Number(process.env.ROTATE_AT || 0.55);
const ROTATE_TOKENS = Number(process.env.ROTATE_TOKENS || 100000);
const THREAD_CAP = 3000;
// Files dropped or pasted into the window: kept on this machine so workers can open them.
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
// Images she looks at herself (sent to the model); larger ones are passed by path only.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

// ── her voice in this window (behaviour lives in the hub's CLAUDE.md) ─────────
const SAHAR_STYLE = `You are Sahar, speaking in a visual chat window, not a terminal. The hub's CLAUDE.md is your job description; mind/agreement.md says who you work for and how they like to work. Address the person by the name the agreement gives them.

TRUTH, NOT GUESSES — this outranks speed.
- Never answer a question about code, deploys, jobs, infra, CI or a PR from memory or assumption. If you don't know it from a check made in this conversation, say "checking" and send a reader first; answer only from what it found.
- A status is only what a worker verified: say plainly whether something is not started, in progress, or done. Never say a cause is "found" until the fix is proven by the test that failed first, and never say "ready to merge" for a task with any of its agreed work still open.
- Before you propose or report anything on a main task, re-read that task's lines in mind/decisions.md (each carries its reason) and never act or speak against one. If a new idea conflicts with a decision, name the decision and ask.
- If you notice you said something wrong, correct it in one line straight away.

YOU DECIDE, WORKERS EXECUTE — this is the whole point of you. You are the senior; workers are juniors. Every change, build, test, browser run and write outside the hub goes to a worker with the Agent tool, in the background (the default). But you are not blind: you may LOOK yourself with read-only commands (git log/show/diff/status, gh pr view/list/checks/diff, gh run view/list, gh api GET, ls, cat, head, tail, grep, find, curl GET, ps, lsof -i, and a pipe into head/tail/wc/grep/sort/uniq/cut/jq) and open screenshots with Read. Anything that changes something is refused. Use your eyes to read diffs, PR and CI state, logs and screenshots, and to verify what workers say. Hand off in one short line ("on it — a reader is checking the PRs"), then stay with the person. Several workers may run at once (one builder per repo). You are never busy: the person can always talk to you while workers run.

EVERY BRIEF IS A SPEC YOU DECIDED. A worker brief you write holds the approach, design and constraints you decided, then ends with a "Done means:" checklist of concrete, checkable outcomes. The worker executes; it does not decide.

CHECK BEFORE DONE — day and night. When a worker finishes, YOU judge the real result yourself against the Done-means checklist: read the diff with git or gh, read the test output, open the screenshots. Never take the worker's report as proof, and never send another cheap worker to do the judging. Pass: it counts, and only then do you tell the person. Fail: one retry whose brief names the gap. Second fail: it goes to needs-you with the evidence. No third loop. Write your verdict in mind/checks/<task-slug>.md (task name lowercased, non-letters and digits turned into dashes): what you checked, against which Done-means lines, the evidence (commit, PR, CI, screenshot paths), and pass or fail. The server keeps the task at "verify" and reminds you until that file is newer than the worker's finish, so never report a task done without it.

WHEN A WORKER REPORTS BACK: judge it as above, write the outcome into the mind, and tell the person in one or two lines — at a natural pause, not in the middle of something else they are discussing. If they are mid-topic, finish their topic first.

CARDS = EVERYTHING RUNNING. The strip is every task the person is working on with you, not only big ones. The moment a task is started or agreed, it gets a card (even before any worker); the moment it closes, merges, is dropped or parked, its card is removed — never wait to be reminded. Each card is one task; the server also adds a card by itself if a worker starts on a [tag] that has none — then fill in its title and project.

LIVE MAIN TASKS FILE. Keep mind/main-tasks.json current — the window draws the person's main tasks from it, live. Shape: [{"name":"<main task, their words — the anchor you tag workers with>","title":"<the MAIN task — the overall goal, in plain product words, at most 6 — e.g. 'Finishing the checkout redesign', 'Moving auth to the new provider'>","now":"<what is being done on it RIGHT NOW, at most 8 words — e.g. 'Fixing the failing payment test'>","project":"<the product/repo in human words, e.g. Checkout, Search>","stage":"plan|build|fix|verify|ready|test|pr|checking|safe|merged","state":"moving|needs-you|blocked|waiting","line":"<at most 12 words: where it is>"}]. Rewrite it the moment any main task changes stage or state. Stages, exactly: plan · build · fix (changes after a review or a test failed) · verify (built; a worker is proving it works) · ready (built and proven — waiting for the person to test) · test (the person is testing) · pr (pushed, PR up) · checking (the merge-safety check is running) · safe (the check passed — safe to merge) · merged. Every time a worker starts or finishes on a main task, re-check that task's stage, state and now-line and rewrite the file in the same turn. When a task is safe, its only remaining step is the person's merge — that is good news, not a problem (the window shows it calm and faded). When it is merged, set stage merged; once the merge is confirmed deployed, remove it from the file (it leaves the strip) and record it in mind/done.md. The card must never say a stage that isn't true right now: if a PR gets new commits, it's back to build or fix, and "safe" is lost until the check passes again. FOCUS AND PENDING — nothing is ever lost when priorities shift. main-tasks.json holds EVERY open task, not just today's: keep the array in priority order (most important first) and give each task "focus": true or false. focus:true = what we are really working on now (the cards; keep it to 3 or fewer). focus:false = pending — still open, waiting its turn (the window lists these in a side list, in your order). When the person shifts priority, move tasks between focus and pending and re-order — never delete a task just because it lost focus; a task leaves the file only when merged/closed or the person drops it (then record it in mind/done.md or decisions.md). Pending tasks keep honest stage/state/line too. LOAD: count open tasks. When the person starts something new while 8 or more are open, say so in one line before planning it ("You have N open — want to close X or Y first?") and name the nearest-to-done ones; when a task is close to done (safe, ready for test, one step left), nudge to finish it before picking up new work. Start every worker's description with the main task in brackets — "[Search] fix the white band" — so the window can show which tasks have workers running.

PERSONA. If mind/persona.md exists it is the person's own persona (written with them, or from a persona they already keep elsewhere): take its voice rules and things to avoid as your voice. Your name stays Sahar. Where the persona and the agreement disagree, the agreement wins.

MAIN TASKS ANCHOR EVERYTHING. The person works on a few main tasks at a time (the top-level things they named, in their words — e.g. "Checkout PR", "Search", "Auth migration"). Every feature, fix, question and worker belongs under one of them. Keep them as the "Main tasks" section at the top of mind/workload.md.
- When asked what's next / where are we / what's pending / status: answer with the main tasks ONLY, one line each — "<main task> — <where it is> · <blocker, or 'no blocker'> · <next>". No sub-items, no questions, no detail unless they ask about one task.
- When you report anything smaller (a worker finished, a question, a fix), say first which main task it belongs to.
- Never pull the person into a sub-feature's details unasked; offer depth in one short line at most.

PROGRESS UPDATES — one line each: "<main task>: <where it is>; <what's happening right now>." e.g. "Checkout redesign: proof pass 2 under way; the payment page is building now." Nothing more unless the person asks, or something needs them.

VOICE: few words. Titles, not paragraphs. One short sentence where one will do. Never a report, never a wall.

WORKLOAD VIEW — when the question is about state (how's my workload, what are we on, what's in progress, what's pending on X, what needs me, what else): at most ONE short sentence in your voice, then exactly ONE fenced block tagged "workload" whose body is pure JSON:

\`\`\`workload
{"repo":"<repo in human words>","line":"<one short sentence, your voice>","items":[{"name":"<feature, plain product words, at most 6>","state":"preparing|planned|building|ready to test|testing|PR up|merged|done","needs":"<at most 4 words, ONLY if the person must act>","next":"<at most 10 words, optional>"}],"more":"<at most 8 words about what else exists, optional>"}
\`\`\`

Rules of the view: ONE repo per answer, the most urgent first (what needs the person, deadlines); "what else" moves to the next repo; at most 7 items, fold the rest into "more" (a phrase, not a sentence). Names are product words — never ticket codes, branch names or paths. A deep question about one feature: hand the checking to a reader, then answer in short prose. Write any decision, rule, priority or correction the person gives into the mind files right away.

SESSIONS: the person sees one continuous thread. When a hidden conversation starts, the mind is attached in <mind> and says whether First Contact already happened; afterwards re-read mind/workload.md before any answer about state. Rotations are invisible — never mention sessions, never re-introduce yourself.

TIME: every message carries the local date and time in <now>. Use it.

MODELS — pick the right one for the job, not the cheapest. You keep all judgment on the main model.
- reader (Haiku): lookups and checks — files, branches, PR/CI status, logs. Cheap, but brief it precisely: exactly what to find, where, and what counts as an answer.
- builder (Sonnet): routine, well-briefed changes and mechanical GitHub/Linear actions.
- Opus worker (model: "opus" — say why in the brief): only after a failed retry, or for a security or merge-safety review. A general-purpose worker with no model named is run on Sonnet by the server; never rely on inheriting your own model.
- expert (Fable): when work is stuck or high-stakes. Stuck = the same feature fails after two rounds of fixes, tests keep failing, a reviewer keeps finding the same kind of problem, or a day passes without real progress. Call the expert BEFORE trying a third round on a weaker model: it starts from the first failing test, finds the root cause (the approach, the skill instructions, or the test itself) and proposes the better fix. Tell the person in one progress line, e.g. "Checkout redesign: stuck after two rounds; asking a Fable expert what's really wrong."
One short line says which worker and model, and why.

NIGHT SHIFT — a <night-shift> note means the person is away and you are working alone.
- Work the pending list in main-tasks.json in priority order, focus first. Only local, reversible steps: build on a branch or worktree, run tests, reviews, diagnosis, fixing review findings, PR descriptions. Every fence stands exactly as it is: no push, PR, merge, migration or external write, whatever the note says.
- You may decide a small thing that sits inside an agreed decision in mind/decisions.md (re-read it first) and log it with its reason and how to undo it. Anything else — a product call, a scope change, anything touching or contradicting a decision, a blocker — goes on the "Needs you" list; move on to the next item, never stop on it.
- The standing rule CHECK BEFORE DONE applies unchanged: you check every finished worker's real result yourself. A second fail is parked on "Needs you" with the evidence.
- Save every brief and every check result in the night file the note names (mind/night/<YYYY-MM-DD>.md), under Done / Decided alone / Needs you, as you go.
- Builders are Sonnet and readers Haiku; name the model on every worker.
- If the note says the night's share is used, stop launching workers and note it. If nothing doable is left, reply exactly: night shift: nothing left. Otherwise reply in one line at most; the person is not reading.
- On the person's first message after a night shift, open with ONE short briefing — Done / Decided alone (each with reason and how to undo it) / Needs you (with the evidence) — then update the cards and main-tasks.json to match, then answer them.`;

const ROTATION_PROMPT = `<rotation>This hidden conversation is about to rotate; the person will not see this turn. Write into the mind everything from this conversation that is not there yet: rewrite mind/workload.md in place to the current truth; append new decisions with their reasons to mind/decisions.md, new lessons to mind/lessons.md, finished features to mind/done.md, rules the person gave to mind/agreement.md, repo facts to mind/repos/<repo>.md. Then reply with exactly one word: rotated.</rotation>`;

// ── the crew: cheaper models for routine work; the main model keeps the judgment ──
const AGENTS = {
  reader: {
    description:
      'Read-only researcher. Use for checking state: repos, git log/branches, PR status, Linear, logs, files. Never edits. Cheap and fast.',
    prompt:
      `You are a read-only researcher for the hub at ${HUB_DIR}. Investigate exactly what you are asked, never modify anything (no edits, no commits, no state-changing commands), and report the conclusion in a few plain lines with the evidence.`,
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch'],
    model: 'haiku',
  },
  builder: {
    description:
      'Builder. Use for well-briefed changes in a worktree (a fix or feature with a clear brief, tests, typecheck) and for mechanical actions the person asked for (mark a PR draft/ready, update a Linear ticket, push after "test passed"). Not for design calls.',
    prompt:
      `You are a builder worker for the hub at ${HUB_DIR}. Read ${HUB_DIR}/mind/lessons.md first. Follow the brief and the target repo's CLAUDE.md exactly. Work only in the worktree you are given. Never commit, push, open PRs or merge unless the brief says the person explicitly asked. Never run migrations, seeds or resets; never write to external systems beyond what the brief names; kill only your own exact PIDs; never build inside a worktree whose dev servers are running. Report in product terms: what changed, test results, what the person must do.`,
    model: 'sonnet',
  },
  expert: {
    description:
      'Expert on the strongest model. Use when work is STUCK (same feature failing after two rounds, tests keep failing, a reviewer keeps finding the same kind of problem, or no real progress in a day) or the stakes are high (data, money, security, production). Diagnoses the real cause from the first failure and proposes the better fix; may implement it when briefed to.',
    prompt:
      `You are the expert called in because the work is stuck or high-stakes. Do not continue the previous approach by default. Go back to the FIRST failing test or the first wrong result, read the history of what was tried (commits, worker reports, review findings), and find the root cause — including whether the approach, the skill instructions or the test itself is wrong. Report: what is really wrong (with evidence), why earlier attempts missed it, the better fix, and the risks. Implement only if the brief says so, in the given worktree, following the repo's CLAUDE.md. Never push, merge, migrate or write to external systems.`,
    model: 'fable',
  },
};
const AGENT_MODEL = { reader: 'haiku', builder: 'sonnet', expert: 'fable' };
const ALIAS_LABEL = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' };

// "claude-opus-5-5" → "Opus 5.5"
function modelLabel(id) {
  if (!id) return '';
  const m = String(id).replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[.*\]$/, '');
  const [family, ...ver] = m.split('-');
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${ver.join('.')}`.trim();
}

// ── fences, deterministic — they hold even if the model forgets the rules ─────
// `git` may carry options before its subcommand (git -C dir push, git -c k=v push).
const GIT = String.raw`\bgit(?:\s+-[Cc]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+`;
const ALWAYS_BLOCKED = [
  [/\bgh\s+pr\s+merge\b/, 'merging is always the person\'s click'],
  [new RegExp(GIT + String.raw`push\b[^\n|;&]*\s(HEAD:)?(refs\/heads\/)?(main|master)\b(?![\w\/-])`), 'never push to main'],
  [new RegExp(GIT + String.raw`push\b[^\n|;&]*(--force|\s-f\b|\s\+)`), 'never force-push'],
  [/(prisma\s+migrate|db:migrate|db:reset|db:seed|migrate\s+(deploy|reset|dev))/, 'no database migrations, seeds or resets'],
  [new RegExp(GIT + String.raw`reset\s+--hard\b`), 'no hard resets'],
];
// Push / PR unlock only when the person's own recent words say so — and a negation
// nearby ("don't push yet", "no PR", "hold the push") keeps it locked.
const UNLOCK = /\b(push|pr|tests?\s+passed|passed|good to go|lgtm|ship it)\b/i;
const NEGATED = /\b(don'?t|do not|not|never|no|hold|wait|without|before)\b(?:\s+\S+){0,3}?\s+(push|pr|pushing)\b/i;
// Judge each of the person's recent messages on its own: the newest message that mentions
// pushing decides. An older "don't push" is overridden by a later "push"; a "wait … merge"
// elsewhere never blocks a push.
function unlocked(userText) {
  const messages = String(userText || '').split('\n\u0000');
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (UNLOCK.test(m)) return !NEGATED.test(m);
  }
  return false;
}
const NEEDS_WORD = [
  [new RegExp(GIT + String.raw`push\b`), 'push needs the person to say "push", "PR" or "test passed"'],
  [/\bgh\s+pr\s+create\b/, 'opening a PR needs the person to say "PR" or "test passed"'],
];
// Her own hands (main thread): her notes, delegation, light reads. Everything else is a worker's.
const MAIN_ALLOWED = new Set([
  'Read', 'Grep', 'Glob', 'Write', 'Edit', 'Agent', 'Task', 'TodoWrite', 'SendMessage',
  'TaskStop', 'TaskOutput', 'WebSearch', 'WebFetch', 'ToolSearch',
]);
/** The real location of a path, following symlinks (macOS: /tmp is /private/tmp). The file
 *  itself may not exist yet, so resolve the nearest existing folder above it. */
function realLocation(p) {
  let dir = path.resolve(String(p));
  const rest = [];
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) {
    rest.unshift(path.basename(dir));
    dir = path.dirname(dir);
  }
  try { dir = fs.realpathSync(dir); } catch {}
  return path.join(dir, ...rest);
}
function insideHub(p) {
  if (!p) return false;
  const hub = realLocation(HUB_DIR);
  const abs = realLocation(p);
  return abs === hub || abs.startsWith(hub + path.sep);
}
// A worker launched with no subagent_type is general-purpose and would inherit her Opus;
// the hook gives it Sonnet unless the brief named a model.
export function defaultWorkerModel(toolInput) {
  const t = toolInput?.subagent_type;
  if (toolInput?.model) return toolInput.model;
  if (AGENT_MODEL[t]) return AGENT_MODEL[t];
  return !t || t === 'general-purpose' ? 'sonnet' : '';
}
function withModel(input) {
  if (input.tool_name !== 'Agent' && input.tool_name !== 'Task') return {};
  const ti = input.tool_input || {};
  if (ti.model || (ti.subagent_type && ti.subagent_type !== 'general-purpose')) return {};
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...ti, model: 'sonnet' } } };
}
/** `recentUserText`: a string, or a function returning the person's recent words. `nightBlock`: optional, true once the night's share is used. */
export function fenceHook(recentUserText, nightBlock) {
  const words = () => (typeof recentUserText === 'function' ? recentUserText() : recentUserText);
  return async (input) => {
    const onMainThread = !input.agent_id;
    if (onMainThread) {
      if (input.tool_name === 'Bash') {
        const cmd = String(input.tool_input?.command || '');
        for (const [re, why] of ALWAYS_BLOCKED) if (re.test(cmd)) return deny(why);
        const ro = readOnlyBash(cmd);
        if (!ro.ok) return deny(`Sahar's own commands are read-only looks only (${ro.why}) — hand this "Bash" to a worker (Agent tool, in the background)`);
        return {};
      }
      if (!MAIN_ALLOWED.has(input.tool_name)) {
        return deny(`Sahar never does the work herself — hand "${input.tool_name}" to a worker (Agent tool, in the background)`);
      }
      if ((input.tool_name === 'Write' || input.tool_name === 'Edit') && !insideHub(input.tool_input?.file_path)) {
        return deny(`Sahar only writes her own notes, and they live in ${HUB_DIR} (e.g. ${path.join(HUB_DIR, 'mind', 'workload.md')}) — check the path; anything outside it goes to a builder`);
      }
      if ((input.tool_name === 'Agent' || input.tool_name === 'Task') && input.tool_input?.run_in_background === false) {
        return deny('workers run in the background so Sahar stays available — call it again without run_in_background:false');
      }
      if ((input.tool_name === 'Agent' || input.tool_name === 'Task') && nightBlock?.()) {
        return deny("the night's share of the budget is used — no new workers until the person is back");
      }
      return withModel(input);
    }
    if (input.tool_name !== 'Bash') return withModel(input);
    const cmd = String(input.tool_input?.command || '');
    for (const [re, why] of ALWAYS_BLOCKED) if (re.test(cmd)) return deny(why);
    for (const [re, why] of NEEDS_WORD) if (re.test(cmd) && !unlocked(words())) return deny(why);
    return {};
  };
}
function deny(reason) {
  console.log(`[fence] denied: ${reason}`);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Fenced by the hub: ${reason}.`,
    },
  };
}

// ── persistence: the hidden session id and the visible thread ─────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s));
}
function clearState() {
  try { fs.unlinkSync(STATE_FILE); } catch {}
}
function loadThread() {
  try { return JSON.parse(fs.readFileSync(THREAD_FILE, 'utf8')); } catch { return []; }
}
function appendThread(entry) {
  const t = loadThread();
  const item = { t: Date.now(), ...entry };
  t.push(item);
  fs.writeFileSync(THREAD_FILE, JSON.stringify(t.slice(-THREAD_CAP)));
  return item;
}

// What a fresh hidden conversation reads before its first word.
function mindBoot() {
  const read = (rel) => {
    try { return fs.readFileSync(path.join(HUB_DIR, rel), 'utf8'); } catch { return `(missing: ${rel})`; }
  };
  const list = (rel) => {
    try { return fs.readdirSync(path.join(HUB_DIR, rel)).filter((f) => f.endsWith('.md')).join(', '); } catch { return '(none)'; }
  };
  const spokenBefore = loadThread().some((e) => e.kind === 'tally');
  // A fresh brain ships with starter files; the agreement's first line marks First Contact as pending.
  let agreementText = '';
  try { agreementText = fs.readFileSync(path.join(HUB_DIR, 'mind', 'agreement.md'), 'utf8'); } catch {}
  const blank = !agreementText || agreementText.includes('first-contact: pending');
  const firstContact = spokenBefore
    ? 'ALREADY HAPPENED in this thread — do not re-introduce yourself or redo it; continue the conversation as the same Sahar. If the agreement is still DRAFT or missing, carry on with what is left of First Contact in passing.'
    : blank
      ? 'PENDING, BLANK SLATE — you have never met this person and your notes are empty. Follow "First Contact — blank slate" in CLAUDE.md.'
      : 'PENDING — this is the first time you speak in this thread; your notes already describe their world.';
  return `<mind>
Attached because a hidden conversation is starting. First Contact: ${firstContact}

<setup>
${setupCheck(tmConnected)}
</setup>
Other mind files to read when needed: mind/ → ${list('mind')}; mind/repos/ → ${list('mind/repos')}; history/ → ${list('history')} (recall only).

=== mind/workload.md ===
${read('mind/workload.md')}

=== mind/agreement.md ===
${read('mind/agreement.md')}

=== mind/lessons.md ===
${read('mind/lessons.md')}
${fs.existsSync(path.join(HUB_DIR, 'mind', 'persona.md')) ? `\n=== mind/persona.md ===\n${read('mind/persona.md')}\n` : ''}</mind>`;
}

function nowLine() {
  const now = new Date().toLocaleString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
  return `<now>${now}</now>`;
}

// Plain-English activity lines — the window shows what she's doing, never the machinery.
function activityLine(toolUse) {
  const name = toolUse.name || '';
  const input = toolUse.input || {};
  switch (name) {
    case 'Read': return 'checking my notes';
    case 'Write':
    case 'Edit': return 'writing it down';
    case 'Grep':
    case 'Glob': return 'searching my notes';
    case 'Task':
    case 'Agent': return `handing off: ${input.description || 'a task'}`.toLowerCase();
    case 'TodoWrite': return 'updating the plan';
    case 'WebFetch':
    case 'WebSearch': return 'looking something up';
    default: return 'thinking';
  }
}

// ── main tasks, live: her file + which tasks have workers running right now ──────
const TASKS_FILE = path.join(HUB_DIR, 'mind', 'main-tasks.json');
const CHECKS_DIR = path.join(HUB_DIR, 'mind', 'checks');
const CHECKS_FILE = path.join(DATA_DIR, '.checks.json');
function loadChecks() {
  try { return JSON.parse(fs.readFileSync(CHECKS_FILE, 'utf8')) || {}; } catch { return {}; }
}
/** A worker finished on "[Task] …": the task's result now waits for her own check. */
function recordWorkerDone(description) {
  const slug = slugOf(taskOfWorker(description));
  if (!slug) return;
  const s = loadChecks();
  s[slug] = Date.now();
  try { fs.writeFileSync(CHECKS_FILE, JSON.stringify(s)); } catch {}
}
function checkMtime(slug) {
  try { return fs.statSync(path.join(CHECKS_DIR, `${slug}.md`)).mtimeMs; } catch { return null; }
}
function readTasksRaw() {
  let tasks = [];
  try { tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); } catch {}
  return Array.isArray(tasks) ? tasks : [];
}
/** Raw tasks in a done-ish stage that she has not checked herself yet. */
function uncheckedNow() {
  return uncheckedTasks(readTasksRaw(), loadChecks(), checkMtime);
}
function mainTasks() {
  const tasks = readTasksRaw();
  const running = [...live.workers.values()].filter((w) => w.shown);
  const unchecked = new Set(uncheckedNow().map((t) => slugOf(t.name)));
  return tasks.slice(0, 40).filter((t) => String(t?.stage) !== 'merged').map((t) => {
    const name = String(t?.name || '').slice(0, 60);
    const tag = `[${name.toLowerCase()}]`;
    return overlayVerify({
      name,
      title: String(t?.title || '').slice(0, 70),
      now: String(t?.now || '').slice(0, 90),
      project: String(t?.project || '').slice(0, 40),
      stage: String(t?.stage || 'plan'),
      state: String(t?.state || 'waiting'),
      line: String(t?.line || '').slice(0, 140),
      focus: t?.focus !== false,
      running: running.filter((w) => String(w.task || '').toLowerCase().startsWith(tag)).length,
    }, unchecked.has(slugOf(name)));
  });
}
/** A worker started on "[Task] …" and that task has no card yet → add it, so nothing runs unseen. */
function ensureCard(description) {
  const m = String(description || '').match(/^\s*\[([^\]]{2,60})\]\s*(.*)$/);
  if (!m) return;
  const name = m[1].trim();
  let tasks = [];
  try { tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); } catch {}
  if (!Array.isArray(tasks)) tasks = [];
  if (tasks.some((t) => String(t?.name || '').toLowerCase() === name.toLowerCase())) return;
  tasks.push({ name, title: name, project: '', stage: 'build', state: 'moving', line: '', now: m[2].slice(0, 90) });
  try { fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 1)); console.log(`[cards] added "${name}" (worker started, no card)`); } catch {}
  pushTasks();
}

let lastTasks = '';
function pushTasks(force = false) {
  const tasks = mainTasks();
  const key = JSON.stringify(tasks);
  if (!force && key === lastTasks) return;
  lastTasks = key;
  broadcast({ type: 'tasks', tasks });
}
function watchTasks() {
  fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true });
  try { fs.watch(path.dirname(TASKS_FILE), (_e, f) => { if (f === 'main-tasks.json') setTimeout(() => pushTasks(), 150); }); } catch {}
  fs.mkdirSync(CHECKS_DIR, { recursive: true });
  try { fs.watch(CHECKS_DIR, () => setTimeout(() => pushTasks(), 150)); } catch {}
}

// ── live clients (Server-Sent Events) ─────────────────────────────────────────
const clients = new Set();
function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(line); } catch {}
  }
}

// ── the one long-lived conversation ───────────────────────────────────────────
const live = {
  q: null,             // the SDK query
  push: null,          // feeds a user message into it
  close: null,         // ends its input stream
  turnActive: false,   // she is composing a reply right now
  workers: new Map(),  // task_id → { agent, model, task }
  workerByToolUse: new Map(), // tool_use_id → { agent, model, task }
  mainModel: '',
  lastCtx: 0,
  windowSize: 200000,
  rotating: false,
  heldDuringRotation: [], // messages that arrive while she writes down; delivered to the fresh conversation
  recentWords: [],     // the person's last few messages (push unlock)
};

function recentUserText() {
  return live.recentWords.join('\n\u0000');
}

function makeInput() {
  const pending = [];
  let wake = null;
  let ended = false;
  async function* stream() {
    while (!ended) {
      if (pending.length === 0) {
        await new Promise((r) => { wake = r; });
        wake = null;
        continue;
      }
      yield pending.shift();
    }
  }
  return {
    stream: stream(),
    push(text, extraBlocks = []) {
      pending.push({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }, ...extraBlocks] },
        parent_tool_use_id: null,
        session_id: '',
      });
      if (wake) wake();
    },
    end() {
      ended = true;
      if (wake) wake();
    },
  };
}

function setBusy(on) {
  live.turnActive = on;
  broadcast({ type: 'busy', on });
}

function startConversation({ resume } = {}) {
  const input = makeInput();
  const q = query({
    prompt: input.stream,
    options: {
      cwd: HUB_DIR,
      model: MAIN_MODEL,
      ...(resume ? { resume } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: SAHAR_STYLE },
      // The person's own global Claude Code instructions apply (SAHAR_USER_SETTINGS=off skips them).
      settingSources: process.env.SAHAR_USER_SETTINGS === 'off' ? ['project'] : ['user', 'project'],
      agents: AGENTS,
      permissionMode: 'default',
      canUseTool: async (_name, toolInput) => ({ behavior: 'allow', updatedInput: toolInput }),
      hooks: { PreToolUse: [{ hooks: [fenceHook(recentUserText, nightCapReached)] }] },
    },
  });
  live.q = q;
  live.push = input.push;
  live.close = () => { input.end(); try { q.close(); } catch {} };
  consume(q).catch((err) => {
    console.log(`[conversation] ended with error: ${err?.message}`);
    if (resume && /resume|session|conversation|not found|no such/i.test(String(err?.message))) {
      clearState();
      say('I lost my thread for a moment and rebuilt it from my notes.');
    } else {
      say(`Something broke on my side — not a quiet day: ${err?.message}`);
    }
    live.q = null;
    live.push = null;
    setBusy(false);
  });
  return q;
}

function say(text) {
  const item = appendThread({ kind: 'tally', text, model: modelLabel(live.mainModel) });
  broadcast({ type: 'text', text, model: item.model });
}

async function consume(q) {
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') {
      live.mainModel = m.model;
      saveState({ ...loadState(), sessionId: m.session_id });
      broadcast({ type: 'model', model: modelLabel(m.model) });
    } else if (m.type === 'system' && m.subtype === 'task_started') {
      const meta = live.workerByToolUse.get(m.tool_use_id) || {
        agent: m.subagent_type || 'worker', model: AGENT_MODEL[m.subagent_type] ? ALIAS_LABEL[AGENT_MODEL[m.subagent_type]] : '', task: m.description,
      };
      if (m.ambient) continue;
      // Only real workers (Agent tasks) show in the thread; a worker's own background
      // commands still count as running work, so a restart never cuts them off.
      meta.shown = m.task_type ? m.task_type === 'local_agent' : !!m.subagent_type;
      live.workers.set(m.task_id, meta);
      if (meta.shown) ensureCard(meta.task);
      broadcast({ type: 'workers', count: live.workers.size });
      pushTasks();
    } else if (m.type === 'system' && m.subtype === 'task_notification') {
      const meta = live.workers.get(m.task_id);
      live.workers.delete(m.task_id);
      if (meta && meta.shown && !m.ambient && m.status === 'completed') recordWorkerDone(meta.task);
      broadcast({ type: 'workers', count: live.workers.size });
      pushTasks();
      if (meta && meta.shown && !m.ambient) {
        const item = appendThread({ kind: 'worker', phase: 'done', status: m.status, agent: meta.agent, model: meta.model, task: meta.task });
        broadcast({ type: 'worker', ...item });
      }
    } else if (m.type === 'assistant') {
      if (m.parent_tool_use_id) continue; // a worker's own messages — not Sahar speaking
      if (!live.turnActive) setBusy(true);
      const u = m.message?.usage;
      if (u) live.lastCtx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      for (const block of m.message.content) {
        if (block.type === 'text' && block.text.trim()) {
          if (live.rotating) continue;
          if (night.nightActive) { nightHeard(block.text); continue; }
          say(block.text);
        } else if (block.type === 'tool_use') {
          broadcast({ type: 'status', text: activityLine(block) });
          if (block.name === 'Task' || block.name === 'Agent') {
            const t = block.input?.subagent_type || 'general-purpose';
            const alias = defaultWorkerModel(block.input);
            const meta = {
              agent: t,
              model: alias ? ALIAS_LABEL[alias] || modelLabel(alias) : 'same model',
              task: block.input?.description || '',
            };
            live.workerByToolUse.set(block.id, meta);
            const item = appendThread({ kind: 'worker', phase: 'start', ...meta });
            broadcast({ type: 'worker', ...item });
          }
        }
      }
    } else if (m.type === 'result') {
      // Loud, never quiet: a turn that failed (usage limit, API error) says so.
      if (m.is_error || (m.subtype && m.subtype !== 'success')) {
        const why = (typeof m.result === 'string' && m.result.trim()) || (m.errors || []).join('; ') || m.subtype;
        console.log(`[turn] failed: ${why}`);
        say(`That didn't go through on my side — ${why}`);
        nightTurnFailed(why);
      }
      live.nightTurn = false;
      const mu = m.modelUsage?.[live.mainModel];
      if (mu?.contextWindow) live.windowSize = mu.contextWindow;
      setBusy(false);
      afterTurn();
    }
  }
}

// After each reply: rotate if the hidden conversation got heavy and no worker is running.
function afterTurn() {
  if (live.rotating) {
    console.log('[rotate] written down — the next message starts fresh from the mind');
    live.rotating = false;
    live.close?.();
    live.q = null;
    live.push = null;
    clearState();
    const held = live.heldDuringRotation.splice(0);
    for (const m of held) deliver(m.text, m.attachments, m.opts);
    return;
  }
  const share = live.windowSize ? live.lastCtx / live.windowSize : 0;
  saveState({ ...loadState(), lastCtx: live.lastCtx, share: Number(share.toFixed(3)) });
  if ((share >= ROTATE_AT || live.lastCtx >= ROTATE_TOKENS) && live.workers.size === 0 && live.push) {
    console.log(`[rotate] context ${live.lastCtx}/${live.windowSize} — writing down first`);
    live.rotating = true;
    live.push(ROTATION_PROMPT);
    return;
  }
  nightCapCheck();
}

/** A dropped file, resolved safely inside the upload folder — or null. */
function uploadedFile(name) {
  const safe = path.basename(String(name || ''));
  const full = path.join(UPLOAD_DIR, safe);
  return safe && fs.existsSync(full) ? { name: safe, full } : null;
}

// opts.user: typed by the person (ends a night shift with a briefing). opts.night: the server's own night-shift note.
function deliver(text, attachments = [], opts = {}) {
  // Never feed a message into a conversation that is being written down and closed —
  // it would be answered inside the hidden rotation turn and the reply lost.
  if (live.rotating) {
    live.heldDuringRotation.push({ text, attachments, opts });
    if (!live.turnActive) setBusy(true);
    return;
  }
  // A night-shift note must never count as the person's words (it mentions "push" and "PR").
  if (!opts.night) live.recentWords = [...live.recentWords, text].slice(-3);
  const cards = mainTasks().map((t) => `${t.title || t.name} (${t.stage})`).join(' · ') || 'none';
  let prefix = nowLine() + `\n<cards>Cards now: ${cards}. If this message starts, agrees or names a task with no card, add its card now; if it closes, merges, drops or parks one, remove that card now.</cards>\n`;
  if (opts.user && night.nightActive) {
    prefix += `<briefing>The person is back after your night shift. Open mind/night/${nightDate()}.md and any other file in mind/night from this shift, then start your reply with ONE short briefing: Done (checked and passed) / Decided alone (each with its reason and how to undo it) / Needs you (questions and blockers, with the evidence). Update the cards and main-tasks.json to match, then answer their message.</briefing>\n`;
    night.nightActive = false;
    night.nightIdle = false;
    saveNight();
  }
  prefix += uncheckedNote(uncheckedNow());
  if (!live.q) {
    const { sessionId } = loadState();
    startConversation({ resume: sessionId });
    if (!sessionId) prefix += mindBoot() + '\n';
  }
  // Every file is named with its local path (workers open it from there); images small
  // enough are also attached so she sees them herself.
  const blocks = [];
  const lines = [];
  for (const a of attachments) {
    const f = uploadedFile(a.name);
    if (!f) continue;
    lines.push(`- ${a.label || f.name} → ${f.full}`);
    const size = fs.statSync(f.full).size;
    if (IMAGE_TYPES.has(a.type) && size <= MAX_INLINE_IMAGE_BYTES) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: a.type, data: fs.readFileSync(f.full).toString('base64') } });
    }
  }
  const files = lines.length ? `\n\n<attached>The person attached these files (saved on this machine; hand a worker the path when it needs them):\n${lines.join('\n')}</attached>` : '';
  live.push(prefix + (text || '(see the attached files)') + files, blocks);
  if (!live.turnActive) setBusy(true);
}

// ── the night shift: her own clock ─────────────────────────────────────────────
// A heartbeat plus a single wake after a limit resets. When the person has been away for
// a while she gets ONE hidden instruction turn; nothing here loops while a limit is on.
const NIGHT_HEARTBEAT_MIN = Number(process.env.NIGHT_HEARTBEAT_MIN || 30);
const NIGHT_AWAY_MIN = Number(process.env.NIGHT_AWAY_MIN || 45);
const NIGHT_AFTER_RESET_MS = 3 * 60 * 1000;
const NIGHT_MAX_UNITS = Number(process.env.NIGHT_MAX_UNITS || 30); // flat per-night cap, in estimated units (night.mjs)
const NIGHT_WEEKLY_BUDGET_UNITS = process.env.NIGHT_WEEKLY_BUDGET_UNITS ? Number(process.env.NIGHT_WEEKLY_BUDGET_UNITS) : NaN;
const NIGHT_WEEK = { dow: Number(process.env.NIGHT_WEEK_RESET_DOW ?? 2), hour: Number(process.env.NIGHT_WEEK_RESET_HOUR ?? 1) };
const NIGHT_FILE = path.join(DATA_DIR, '.night.json');
const NIGHT_LOGS = process.env.NIGHT_LOGS_DIR || path.join(os.homedir(), '.claude', 'projects', HUB_DIR.replace(/[^A-Za-z0-9]/g, '-'));
const meter = createUsageMeter(NIGHT_LOGS);
const night = (() => {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(NIGHT_FILE, 'utf8')); } catch {}
  if (!s.lastUserAt) {
    const last = loadThread().filter((e) => e.kind === 'user').pop();
    s.lastUserAt = last?.t || 0;
  }
  return { limitedUntil: 0, lastWakeAt: 0, nightActive: false, nightStartedAt: 0, nightIdle: false, capNoted: false, ...s };
})();
let nextHeartbeatAt = 0;
let limitTimer = null;
function saveNight() {
  try { fs.writeFileSync(NIGHT_FILE, JSON.stringify(night)); } catch {}
}
function touchUser() {
  night.lastUserAt = Date.now();
  night.nightIdle = false;
  saveNight();
}
function nightDate() {
  const d = new Date(night.nightStartedAt || Date.now());
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
// ESTIMATE only: spend is summed from her own session logs with rough price weights; the real
// remaining allowance is not readable anywhere.
function nightCap(now = Date.now()) {
  const week = weekWindow(now, NIGHT_WEEK);
  return {
    ...capMath({
      budget: NIGHT_WEEKLY_BUDGET_UNITS,
      usedThisWeek: Number.isFinite(NIGHT_WEEKLY_BUDGET_UNITS) ? meter.unitsSince(week.start, now) : 0,
      now, nextReset: week.next, maxUnits: NIGHT_MAX_UNITS,
      nightSpent: night.nightActive && night.nightStartedAt ? meter.unitsSince(night.nightStartedAt, now) : 0,
    }),
    weekResetAt: week.next,
  };
}
function nightCapReached() {
  return night.nightActive && !nightCap().ok;
}
function nightHeard(text) {
  if (/night shift:\s*nothing left/i.test(text)) { night.nightIdle = true; saveNight(); }
  try {
    fs.mkdirSync(path.join(HUB_DIR, 'mind', 'night'), { recursive: true });
    fs.appendFileSync(path.join(HUB_DIR, 'mind', 'night', `${nightDate()}.talk.md`), `- ${new Date().toTimeString().slice(0, 5)} ${String(text).replace(/\s+/g, ' ').trim().slice(0, 400)}\n`);
  } catch {}
}
function scheduleLimitWake() {
  clearTimeout(limitTimer);
  limitTimer = null;
  const wait = night.limitedUntil - Date.now();
  if (wait <= 0) return;
  limitTimer = setTimeout(() => (Date.now() >= night.limitedUntil ? nightTick('limit-reset') : scheduleLimitWake()), Math.min(wait + 500, 2 ** 31 - 1));
}
/** A failed turn: a limit message sets ONE wake just after its reset; any other failure of a night turn backs off an hour. */
function nightTurnFailed(why) {
  const now = Date.now();
  if (looksLikeLimit(why)) {
    const reset = parseResetTime(why, now);
    night.limitedUntil = reset ? reset + NIGHT_AFTER_RESET_MS : now + 60 * 60 * 1000;
    console.log(`[night] limit hit — no wakes until ${new Date(night.limitedUntil).toISOString()}${reset ? '' : ' (no reset time in the message; 1h fallback)'}`);
  } else if (live.nightTurn) {
    night.limitedUntil = now + 60 * 60 * 1000;
    console.log('[night] a night turn failed — backing off 1h');
  } else return;
  saveNight();
  scheduleLimitWake();
}
function nightInstruction(cap) {
  const f = `mind/night/${nightDate()}.md`;
  return `${nowLine()}
<night-shift>The person has been away for ${NIGHT_AWAY_MIN}+ minutes. Run the night shift per your rules (hub CLAUDE.md "Night shift"): work the pending list in main-tasks.json in priority order, focus first; local, reversible steps only; every fence unchanged; small calls only inside an agreed decision in mind/decisions.md, logged with reason and undo; everything else to "Needs you". Every worker brief has a "Done means:" checklist and you check the real result yourself against it (one retry, then park). Save every brief and check result in ${f} (${HUB_DIR}/${f}). Estimated night spend so far ${cap.spent.toFixed(1)} of ${cap.cap.toFixed(1)} units. If nothing doable is left, reply exactly: night shift: nothing left.</night-shift>`;
}
/** Heartbeat and limit-reset wakes both come through here. */
function nightTick(source) {
  const now = Date.now();
  if (source === 'heartbeat') nextHeartbeatAt = now + NIGHT_HEARTBEAT_MIN * 60000;
  if (night.limitedUntil && now >= night.limitedUntil) { night.limitedUntil = 0; saveNight(); }
  const cap = nightCap(now);
  const d = wakeDecision({
    now, away: isAway({ now, lastUserAt: night.lastUserAt, awayMs: NIGHT_AWAY_MIN * 60000 }),
    limitedUntil: night.limitedUntil, turnActive: live.turnActive, rotating: live.rotating,
    workers: live.workers.size, nightIdle: night.nightIdle, capOk: cap.ok,
  });
  console.log(`[night] ${source}: ${d.wake ? 'waking her' : d.reason}`);
  if (!d.wake) return d;
  if (!night.nightActive) {
    Object.assign(night, { nightActive: true, nightStartedAt: now, nightIdle: false, capNoted: false });
    try { fs.mkdirSync(path.join(HUB_DIR, 'mind', 'night'), { recursive: true }); } catch {}
  }
  night.lastWakeAt = now;
  saveNight();
  live.nightTurn = true;
  deliver(nightInstruction(nightCap(now)), [], { night: true });
  return d;
}
/** After each turn of a night shift: once the night's share is used, tell her once to stop and note it. */
function nightCapCheck() {
  if (!night.nightActive || night.capNoted || live.rotating) return;
  const cap = nightCap();
  if (cap.ok) return;
  night.capNoted = true;
  night.nightIdle = true;
  saveNight();
  console.log(`[night] share used (${cap.spent.toFixed(1)}/${cap.cap.toFixed(1)} units) — telling her to stop`);
  live.nightTurn = true;
  deliver(`${nowLine()}\n<night-shift>The night's share of the budget is used (about ${cap.spent.toFixed(1)} of ${cap.cap.toFixed(1)} estimated units). Launch no new workers. Let running ones finish, add a line to mind/night/${nightDate()}.md saying the cap stopped the shift and what is still pending, then reply exactly: night shift: nothing left.</night-shift>`, [], { night: true });
}
function nightStatus() {
  const now = Date.now();
  const cap = nightCap(now);
  return {
    now: new Date(now).toISOString(),
    away: isAway({ now, lastUserAt: night.lastUserAt, awayMs: NIGHT_AWAY_MIN * 60000 }),
    awayAfterMin: NIGHT_AWAY_MIN,
    lastUserAt: night.lastUserAt ? new Date(night.lastUserAt).toISOString() : null,
    limitedUntil: night.limitedUntil > now ? new Date(night.limitedUntil).toISOString() : null,
    nextWake: night.limitedUntil > now ? new Date(night.limitedUntil).toISOString() : (nextHeartbeatAt ? new Date(nextHeartbeatAt).toISOString() : null),
    nextWakeKind: night.limitedUntil > now ? 'limit-reset' : 'heartbeat',
    lastWakeAt: night.lastWakeAt ? new Date(night.lastWakeAt).toISOString() : null,
    nightActive: night.nightActive,
    nightIdle: night.nightIdle,
    spend: { estimate: true, nightUnits: Number(cap.spent.toFixed(2)), capUnits: Number(cap.cap.toFixed(2)), weeklyBudgetUnits: Number.isFinite(NIGHT_WEEKLY_BUDGET_UNITS) ? NIGHT_WEEKLY_BUDGET_UNITS : null, weeklyRemainingUnits: cap.remaining, weekResetsAt: new Date(cap.weekResetAt).toISOString() },
    caffeinate: process.env.NIGHT_CAFFEINATE === '1',
  };
}
function startNight() {
  scheduleLimitWake();
  nextHeartbeatAt = Date.now() + NIGHT_HEARTBEAT_MIN * 60000;
  setInterval(() => nightTick('heartbeat'), NIGHT_HEARTBEAT_MIN * 60000);
  if (process.env.NIGHT_CAFFEINATE === '1') {
    // keeps the Mac from idle-sleeping for as long as this process lives; changes no system setting
    try { spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => {}); } catch {}
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(UI_DIR, 'public', 'index.html')));
  } else if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello', busy: live.turnActive, workers: live.workers.size, model: modelLabel(live.mainModel || MAIN_MODEL), modelId: MAIN_MODEL, models: MODEL_CHOICES.map((id) => ({ id, label: modelLabel(id) })), tasks: mainTasks() })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
  } else if (req.method === 'POST' && req.url === '/upload') {
    // One file per request; the body is the raw bytes. Name + type ride in headers.
    const label = decodeURIComponent(String(req.headers['x-file-name'] || 'file')).slice(0, 200);
    const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0];
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_UPLOAD_BYTES) { res.writeHead(413).end(); return; }
      chunks.push(c);
    }
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${stamp}-${path.basename(label).replace(/[^\w.\-]+/g, '_')}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.concat(chunks));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name, label, type, size }));
  } else if (req.method === 'GET' && req.url.startsWith('/uploads/')) {
    const f = uploadedFile(decodeURIComponent(req.url.slice('/uploads/'.length)));
    if (!f) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'X-Content-Type-Options': 'nosniff' });
    res.end(fs.readFileSync(f.full));
  } else if (req.method === 'POST' && req.url === '/message') {
    let text = '';
    let hidden = false;
    let attachments = [];
    try { ({ text, hidden = false, attachments = [] } = JSON.parse(await readBody(req))); } catch {}
    text = String(text || '').trim();
    attachments = Array.isArray(attachments) ? attachments.filter((a) => uploadedFile(a?.name)).slice(0, 10) : [];
    if (!text && attachments.length === 0) { res.writeHead(400).end(); return; }
    if (!hidden) {
      const item = appendThread({ kind: 'user', text, attachments });
      broadcast({ type: 'user', ...item });
      touchUser();
    }
    deliver(text, attachments, { user: !hidden });
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else if (req.method === 'POST' && req.url === '/model') {
    let model = '';
    try { ({ model = '' } = JSON.parse(await readBody(req))); } catch {}
    if (!MODEL_CHOICES.includes(model)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unknown model' })); return; }
    MAIN_MODEL = model;
    try { fs.writeFileSync(MODEL_FILE, model); } catch {}
    if (live.q) { try { await live.q.setModel(model); } catch (err) { console.log(`[model] switch failed: ${err?.message}`); } }
    live.mainModel = model;
    console.log(`[model] now ${model}`);
    broadcast({ type: 'model', model: modelLabel(model), id: model });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, model }));
  } else if (req.method === 'POST' && req.url === '/stop') {
    // Stops what she is saying or doing right now; background workers keep going.
    if (live.q && live.turnActive) {
      try { await live.q.interrupt(); } catch (err) { console.log(`[stop] interrupt failed: ${err?.message}`); }
      setBusy(false);
      const item = appendThread({ kind: 'note', text: 'stopped' });
      broadcast({ type: 'note', ...item });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, workers: live.workers.size }));
  } else if (req.method === 'GET' && req.url === '/tasks') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mainTasks()));
  } else if (req.method === 'GET' && req.url === '/thread') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadThread()));
  } else if (req.method === 'GET' && req.url === '/night') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(nightStatus()));
  } else if (req.method === 'POST' && req.url === '/tm/connect') {
    let email = '', password = '';
    try { ({ email = '', password = '' } = JSON.parse(await readBody(req))); } catch {}
    email = String(email).trim(); password = String(password);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!email || !password) { res.end(JSON.stringify({ ok: false, error: 'Enter your TrueMemory email and password.' })); return; }
    try {
      const { user } = await tm.connect(email, password);
      tmConnected = true;
      res.end(JSON.stringify({ ok: true, user }));
    } catch (err) {
      res.end(JSON.stringify({ ok: false, error: tm.friendlyError(err) }));
    }
  } else if (req.method === 'POST' && req.url === '/tm/set-password') {
    let email = '';
    try { ({ email = '' } = JSON.parse(await readBody(req))); } catch {}
    email = String(email).trim();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!email) { res.end(JSON.stringify({ ok: false, error: 'Enter your TrueMemory email first.' })); return; }
    try { await tm.sendSetPasswordEmail(email); res.end(JSON.stringify({ ok: true })); }
    catch (err) { res.end(JSON.stringify({ ok: false, error: tm.friendlyError(err) })); }
  } else if (req.method === 'GET' && req.url === '/tm/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try { res.end(JSON.stringify(await tm.status())); } catch (err) { res.end(JSON.stringify({ connected: false, error: tm.friendlyError(err) })); }
  } else if (req.method === 'POST' && req.url === '/tm/proof') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try { res.end(JSON.stringify(await tm.runProof())); } catch (err) { res.end(JSON.stringify({ passed: false, steps: [{ step: 'proof', ok: false, error: tm.friendlyError(err) }] })); }
  } else if (req.method === 'GET' && req.url === '/health') {
    const s = loadState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hub: HUB_DIR, model: MAIN_MODEL, session: s.sessionId || null, live: !!live.q, busy: live.turnActive, workers: live.workers.size, share: s.share || 0 }));
  } else {
    res.writeHead(404).end();
  }
});

// Listen only when run directly; tests import the fence without starting a server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureHub();
  watchTasks();
  startNight();
  refreshTmSetup();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Sahar on http://localhost:${PORT} — hub: ${HUB_DIR} — ${MAIN_MODEL} — never busy, workers in the background — rotate at ${Math.round(ROTATE_AT * 100)}% or ${ROTATE_TOKENS} tokens`);
  });
}
