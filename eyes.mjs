// Her eyes: a strict read-only allowlist for Bash on the main thread. Anything not
// positively recognised is refused.

const SAFE_PIPE = new Set(['head', 'tail', 'wc', 'grep', 'rg', 'sort', 'uniq', 'cut', 'jq']);
const BANNED_WORDS = new Set(['tee', 'xargs', 'sudo', 'rm', 'mv', 'cp', 'kill']);
const PLAIN = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'stat', 'file', 'du', 'df', 'pwd', 'which']);

/** Quote-aware split into pipe-separated segments of words; throws a reason on any shell operator. */
function parse(cmd) {
  const segs = [[]];
  let word = '';
  let has = false;
  let q = null;
  const endWord = () => { if (has) segs[segs.length - 1].push(word); word = ''; has = false; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const n = cmd[i + 1];
    if (q === "'") { if (c === "'") q = null; else word += c; continue; }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === '`' || (c === '$' && (n === '(' || n === '{'))) throw new Error('substitution');
      else if (c === '\\' && n !== undefined) { word += n; i++; }
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === '\\') { if (n === undefined) throw new Error('trailing backslash'); word += n; has = true; i++; continue; }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    if (c === '|') {
      if (n === '|') throw new Error('||');
      endWord(); segs.push([]); continue;
    }
    if (c === '$' && n && /[\w({]/.test(n)) throw new Error('expansion');
    if (';&<>`\n\r()'.includes(c)) throw new Error(`operator ${JSON.stringify(c)}`);
    word += c; has = true;
  }
  if (q) throw new Error('unterminated quote');
  endWord();
  return segs;
}

const has = (args, ...flags) => args.some((a) => flags.some((f) => a === f || (f.length > 2 && f.startsWith('--') && a.startsWith(f + '='))));

function gitOk(args) {
  let a = [...args];
  while (a.length && a[0].startsWith('-')) {
    if (a[0] === '-C' && a.length > 1) { a = a.slice(2); continue; }
    return false; // -c, --exec-path, … change behaviour
  }
  const sub = a[0];
  const rest = a.slice(1);
  if (['log', 'show', 'diff', 'status', 'rev-parse', 'ls-remote', 'ls-files', 'blame'].includes(sub)) {
    return !rest.some((x) => x === '--output' || x.startsWith('--output=') || x === '--ext-diff' || x === '--open-files-in-pager');
  }
  if (sub === 'remote') return rest.length === 1 && (rest[0] === '-v' || rest[0] === '--verbose');
  if (sub === 'branch') {
    if (rest.some((x) => /^(-d|-D|-m|-M|-c|-C|-f|-u|--delete|--move|--copy|--force|--set-upstream-to.*|--unset-upstream|--edit-description|--track|--no-track)$/.test(x))) return false;
    const listing = has(rest, '--list', '-l', '--contains', '--merged', '--no-merged', '--points-at');
    return listing || !rest.some((x) => !x.startsWith('-'));
  }
  return false;
}

function ghOk(args) {
  const [a, b, ...rest] = args;
  const pair = `${a} ${b}`;
  if (['pr view', 'pr list', 'pr checks', 'pr diff', 'run view', 'run list', 'issue view'].includes(pair)) return true;
  if (a === 'api') {
    const all = args.slice(1);
    for (let i = 0; i < all.length; i++) {
      const x = all[i];
      if (/^(-f|-F|--field|--raw-field|--input)(=|$)/.test(x) || /^-[fF]./.test(x)) return false;
      if (x === '-X' || x === '--method' || x.startsWith('--method=') || x.startsWith('-X')) {
        const v = x === '-X' || x === '--method' ? all[i + 1] : x.startsWith('--method=') ? x.slice(9) : x.slice(2);
        if (String(v).toUpperCase() !== 'GET') return false;
      }
    }
    return !all.some((x) => x === 'graphql');
  }
  return false;
}

function curlOk(args) {
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (x === '-X' || x === '--request' || /^-X./.test(x) || x.startsWith('--request=')) {
      const v = x === '-X' || x === '--request' ? args[i + 1] : x.startsWith('--request=') ? x.slice(10) : x.slice(2);
      if (String(v).toUpperCase() !== 'GET') return false;
      continue;
    }
    if (/^--(data|form|upload-file|output|remote-name|json|dump-header|cookie-jar|config|trace|trace-ascii|stderr)/.test(x)) return false;
    if (/^-[A-Za-z]+$/.test(x) && /[dDFToOcK]/.test(x)) return false;
  }
  return true;
}

function firstOk(w) {
  const [cmd, ...args] = w;
  if (!cmd) return false;
  if (PLAIN.has(cmd)) {
    if (cmd === 'rg' && args.some((x) => x.startsWith('--pre'))) return false;
    if (cmd === 'tail' && (has(args, '-f', '-F', '--follow') || args.some((x) => /^-[a-zA-Z]*[fF]/.test(x)))) return false;
    return true;
  }
  switch (cmd) {
    case 'git': return gitOk(args);
    case 'gh': return ghOk(args);
    case 'curl': return curlOk(args);
    case 'find': return !args.some((x) => /^-(exec|execdir|delete|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(x));
    case 'date': return !args.some((x) => x === '-s' || x === '--set' || x.startsWith('--set=') || /^-[a-z]*s/.test(x));
    case 'lsof': return args.some((x) => x.startsWith('-i')) && !args.includes('-c');
    case 'ps': return true;
    default: return false;
  }
}

/** { ok:true } when the command is one of her read-only looks; otherwise { ok:false, why }. */
export function readOnlyBash(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, why: 'empty' };
  let segs;
  try { segs = parse(cmd); } catch (e) { return { ok: false, why: e.message }; }
  if (segs.some((s) => s.length === 0)) return { ok: false, why: 'empty pipe segment' };
  for (const s of segs) if (s.some((w) => BANNED_WORDS.has(w))) return { ok: false, why: 'banned word' };
  if (/^\w+=/.test(segs[0][0])) return { ok: false, why: 'env assignment' };
  if (!firstOk(segs[0])) return { ok: false, why: `not a read-only command: ${segs[0][0]}` };
  for (const s of segs.slice(1)) {
    if (!SAFE_PIPE.has(s[0])) return { ok: false, why: `cannot pipe into ${s[0]}` };
    if (s[0] === 'sort' && s.some((x) => x === '-o' || x.startsWith('--output') || /^-[a-z]*o/.test(x))) return { ok: false, why: 'sort -o writes' };
    if (s[0] === 'rg' && s.some((x) => x.startsWith('--pre'))) return { ok: false, why: 'rg --pre runs commands' };
  }
  return { ok: true };
}
