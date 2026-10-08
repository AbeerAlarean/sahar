import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

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

/** What she needs on this machine, checked at start — told to her plainly at First Contact. */
function setupCheck() {
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
  return [claudeLine, ghLine, git.ok ? 'git: installed.' : 'git: NOT installed.'].join('\n');
}
const STATE_FILE = path.join(DATA_DIR, '.session.json');
const THREAD_FILE = path.join(DATA_DIR, '.thread.json');
const PORT = Number(process.env.PORT || 4747);
const MAIN_MODEL = process.env.MAIN_MODEL || 'claude-opus-5-5';
// Rotate the hidden conversation when its context passes this share of the window OR this
// many tokens, and only while no worker is running (a rotation would end them).
const ROTATE_AT = Number(process.env.ROTATE_AT || 0.55);
const ROTATE_TOKENS = Number(process.env.ROTATE_TOKENS || 200000);
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

YOU NEVER DO THE WORK YOURSELF — this is the whole point of you. You cannot run commands. Anything that touches a repo, GitHub, Linear, a server, a test, a file outside the hub, or any lookup bigger than a glance at your own notes goes to a worker with the Agent tool, in the background (the default). Hand off in one short line ("on it — a reader is checking the PRs"), then stay with the person. Several workers may run at once (one builder per repo). You are never busy: the person can always talk to you while workers run.

WHEN A WORKER REPORTS BACK: check what it says against what you asked, write the outcome into the mind, and tell the person in one or two lines — at a natural pause, not in the middle of something else they are discussing. If they are mid-topic, finish their topic first.

CARDS = EVERYTHING RUNNING. The strip is every task the person is working on with you, not only big ones. The moment a task is started or agreed, it gets a card (even before any worker); the moment it closes, merges, is dropped or parked, its card is removed — never wait to be reminded. Each card is one task; the server also adds a card by itself if a worker starts on a [tag] that has none — then fill in its title and project.

LIVE MAIN TASKS FILE. Keep mind/main-tasks.json current — the window draws the person's main tasks from it, live. Shape: [{"name":"<main task, their words — the anchor you tag workers with>","title":"<the MAIN task — the overall goal, in plain product words, at most 6 — e.g. 'Finishing the checkout redesign', 'Moving auth to the new provider'>","now":"<what is being done on it RIGHT NOW, at most 8 words — e.g. 'Fixing the failing payment test'>","project":"<the product/repo in human words, e.g. Checkout, Search>","stage":"plan|build|fix|verify|ready|test|pr|checking|safe|merged","state":"moving|needs-you|blocked|waiting","line":"<at most 12 words: where it is>"}]. Rewrite it the moment any main task changes stage or state. Stages, exactly: plan · build · fix (changes after a review or a test failed) · verify (built; a worker is proving it works) · ready (built and proven — waiting for the person to test) · test (the person is testing) · pr (pushed, PR up) · checking (the merge-safety check is running) · safe (the check passed — safe to merge) · merged. Every time a worker starts or finishes on a main task, re-check that task's stage, state and now-line and rewrite the file in the same turn. When a task is safe, its only remaining step is the person's merge — that is good news, not a problem (the window shows it calm and faded). When it is merged, set stage merged; once the merge is confirmed deployed, remove it from the file (it leaves the strip) and record it in mind/done.md. The card must never say a stage that isn't true right now: if a PR gets new commits, it's back to build or fix, and "safe" is lost until the check passes again. Start every worker's description with the main task in brackets — "[Smart chat] fix the white band" — so the window can show which tasks have workers running.

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
- your own model (Opus, general-purpose worker): design calls, tricky debugging, reviews, the merge-safety check.
- expert (Fable): when work is stuck or high-stakes. Stuck = the same feature fails after two rounds of fixes, tests keep failing, a reviewer keeps finding the same kind of problem, or a day passes without real progress. Call the expert BEFORE trying a third round on a weaker model: it starts from the first failing test, finds the root cause (the approach, the skill instructions, or the test itself) and proposes the better fix. Tell the person in one progress line, e.g. "Checkout redesign: stuck after two rounds; asking a Fable expert what's really wrong."
One short line says which worker and model, and why.`;

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
/** `recentUserText`: a string, or a function returning the person's recent words. */
export function fenceHook(recentUserText) {
  const words = () => (typeof recentUserText === 'function' ? recentUserText() : recentUserText);
  return async (input) => {
    const onMainThread = !input.agent_id;
    if (onMainThread) {
      if (!MAIN_ALLOWED.has(input.tool_name)) {
        return deny(`Sahar never does the work herself — hand "${input.tool_name}" to a worker (Agent tool, in the background)`);
      }
      if ((input.tool_name === 'Write' || input.tool_name === 'Edit') && !insideHub(input.tool_input?.file_path)) {
        return deny(`Sahar only writes her own notes, and they live in ${HUB_DIR} (e.g. ${path.join(HUB_DIR, 'mind', 'workload.md')}) — check the path; anything outside it goes to a builder`);
      }
      if ((input.tool_name === 'Agent' || input.tool_name === 'Task') && input.tool_input?.run_in_background === false) {
        return deny('workers run in the background so Sahar stays available — call it again without run_in_background:false');
      }
      return {};
    }
    if (input.tool_name !== 'Bash') return {};
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
${setupCheck()}
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
function mainTasks() {
  let tasks = [];
  try { tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); } catch {}
  if (!Array.isArray(tasks)) return [];
  const running = [...live.workers.values()].filter((w) => w.shown);
  return tasks.slice(0, 8).map((t) => {
    const name = String(t?.name || '').slice(0, 60);
    const tag = `[${name.toLowerCase()}]`;
    return {
      name,
      title: String(t?.title || '').slice(0, 70),
      now: String(t?.now || '').slice(0, 90),
      project: String(t?.project || '').slice(0, 40),
      stage: String(t?.stage || 'plan'),
      state: String(t?.state || 'waiting'),
      line: String(t?.line || '').slice(0, 140),
      running: running.filter((w) => String(w.task || '').toLowerCase().startsWith(tag)).length,
    };
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
      hooks: { PreToolUse: [{ hooks: [fenceHook(recentUserText)] }] },
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
          say(block.text);
        } else if (block.type === 'tool_use') {
          broadcast({ type: 'status', text: activityLine(block) });
          if (block.name === 'Task' || block.name === 'Agent') {
            const t = block.input?.subagent_type || 'general-purpose';
            const alias = block.input?.model || AGENT_MODEL[t];
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
      }
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
    for (const m of held) deliver(m.text, m.attachments);
    return;
  }
  const share = live.windowSize ? live.lastCtx / live.windowSize : 0;
  saveState({ ...loadState(), lastCtx: live.lastCtx, share: Number(share.toFixed(3)) });
  if ((share >= ROTATE_AT || live.lastCtx >= ROTATE_TOKENS) && live.workers.size === 0 && live.push) {
    console.log(`[rotate] context ${live.lastCtx}/${live.windowSize} — writing down first`);
    live.rotating = true;
    live.push(ROTATION_PROMPT);
  }
}

/** A dropped file, resolved safely inside the upload folder — or null. */
function uploadedFile(name) {
  const safe = path.basename(String(name || ''));
  const full = path.join(UPLOAD_DIR, safe);
  return safe && fs.existsSync(full) ? { name: safe, full } : null;
}

function deliver(text, attachments = []) {
  // Never feed a message into a conversation that is being written down and closed —
  // it would be answered inside the hidden rotation turn and the reply lost.
  if (live.rotating) {
    live.heldDuringRotation.push({ text, attachments });
    if (!live.turnActive) setBusy(true);
    return;
  }
  live.recentWords = [...live.recentWords, text].slice(-3);
  const cards = mainTasks().map((t) => `${t.title || t.name} (${t.stage})`).join(' · ') || 'none';
  let prefix = nowLine() + `\n<cards>Cards now: ${cards}. If this message starts, agrees or names a task with no card, add its card now; if it closes, merges, drops or parks one, remove that card now.</cards>\n`;
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
    res.write(`data: ${JSON.stringify({ type: 'hello', busy: live.turnActive, workers: live.workers.size, model: modelLabel(live.mainModel), tasks: mainTasks() })}\n\n`);
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
    }
    deliver(text, attachments);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
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
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Sahar on http://localhost:${PORT} — hub: ${HUB_DIR} — ${MAIN_MODEL} — never busy, workers in the background — rotate at ${Math.round(ROTATE_AT * 100)}% or ${ROTATE_TOKENS} tokens`);
  });
}
