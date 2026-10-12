import fs from 'node:fs';
import path from 'node:path';

// Night shift helpers — pure functions (tested in night.test.mjs) plus a small
// incremental usage meter. Everything about spend here is an ESTIMATE from her own session
// logs; there is no API that tells us the real remaining allowance.

const DAY = 24 * 3600 * 1000;

// ── time zones without a library ──────────────────────────────────────────────
function partsInTz(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = Number(p.value);
  return { y: o.year, mo: o.month, d: o.day, h: o.hour, mi: o.minute, s: o.second };
}
function offsetMs(tz, ms) {
  const p = partsInTz(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
/** Wall-clock time in `tz` → UTC ms. Day/month overflow is allowed (d+1 etc.). */
export function wallToUtc(tz, y, mo, d, h = 0, mi = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  return guess - offsetMs(tz, guess - offsetMs(tz, guess));
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * "…your session limit resets 5:30am (Asia/Singapore)" or "resets Oct 13 at 1am (Asia/Singapore)"
 * → the reset as epoch ms, or null when the text has no reset time. `nowMs` is injectable for tests.
 */
export function parseResetTime(text, nowMs = Date.now()) {
  const m = String(text || '').match(
    /resets\s+(?:on\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:at\s+)?)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b\s*(?:\(([^)]+)\))?/i,
  );
  if (!m) return null;
  const [, mon, day, hh, mm, ap, tzRaw] = m;
  const tz = (tzRaw || '').trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  let h = Number(hh) % 12;
  if (ap.toLowerCase() === 'pm') h += 12;
  const mi = Number(mm || 0);
  if (Number(hh) < 1 || Number(hh) > 12 || mi > 59) return null;
  try {
    const p = partsInTz(nowMs, tz);
    if (mon) {
      const mo = MONTHS.indexOf(mon.slice(0, 3).toLowerCase()) + 1;
      if (!mo) return null;
      let t = wallToUtc(tz, p.y, mo, Number(day), h, mi);
      if (t < nowMs - 36 * 3600 * 1000) t = wallToUtc(tz, p.y + 1, mo, Number(day), h, mi);
      return t;
    }
    let t = wallToUtc(tz, p.y, p.mo, p.d, h, mi);
    if (t <= nowMs) t = wallToUtc(tz, p.y, p.mo, p.d + 1, h, mi);
    return t;
  } catch {
    return null;
  }
}

/** A failed turn's text says a limit was hit (as opposed to "Not logged in" etc.). */
export function looksLikeLimit(text) {
  return /\blimit\b|\bresets\b/i.test(String(text || ''));
}

// ── away / wake decisions ─────────────────────────────────────────────────────
/** Away = no message typed by the person for `awayMs`. Unknown last activity counts as away. */
export function isAway({ now, lastUserAt, awayMs }) {
  if (!lastUserAt) return true;
  return now - lastUserAt >= awayMs;
}
/** Single place that decides whether a heartbeat/limit-reset wake may start a night-shift turn. */
export function wakeDecision({ now, away, limitedUntil = 0, turnActive, rotating, workers = 0, nightIdle = false, capOk = true }) {
  if (!away) return { wake: false, reason: 'person is active' };
  if (limitedUntil && now < limitedUntil) return { wake: false, reason: 'limited until reset' };
  if (turnActive || rotating) return { wake: false, reason: 'mid-turn' };
  if (workers > 0) return { wake: false, reason: 'workers running' };
  if (nightIdle) return { wake: false, reason: 'nothing left to do' };
  if (!capOk) return { wake: false, reason: 'night share used' };
  return { wake: true, reason: 'away, free, within cap' };
}

// ── cap math (an estimate) ────────────────────────────────────────────────────
/** Start of the current weekly window and the next reset, in the given zone (default: Tue 1am). */
export function weekWindow(nowMs, { dow = 2, hour = 1, tz = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  const p = partsInTz(nowMs, tz);
  const wd = new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();
  let back = (wd - dow + 7) % 7;
  let start = wallToUtc(tz, p.y, p.mo, p.d - back, hour, 0);
  if (start > nowMs) { back += 7; start = wallToUtc(tz, p.y, p.mo, p.d - back, hour, 0); }
  return { start, next: wallToUtc(tz, p.y, p.mo, p.d - back + 7, hour, 0) };
}
/**
 * The night's share: at most half of what is left of the weekly budget, spread over the days
 * until the weekly reset. With no budget known, just the flat per-night cap. ESTIMATE ONLY.
 */
export function capMath({ budget, usedThisWeek = 0, now, nextReset, maxUnits, nightSpent = 0 }) {
  let cap = maxUnits;
  let remaining = null;
  if (Number.isFinite(budget) && budget > 0) {
    remaining = Math.max(0, budget - usedThisWeek);
    const days = Math.max(1, Math.ceil((nextReset - now) / DAY));
    const share = (0.5 * remaining) / days;
    cap = Number.isFinite(maxUnits) ? Math.min(share, maxUnits) : share;
  }
  return { cap, remaining, spent: nightSpent, ok: nightSpent < cap };
}

// ── spend estimate from her session logs ──────────────────────────────────────
// Weights are a rough price ratio, NOT a bill: tokens → "output-weighted Opus million-token units".
//   token mix:  input 1 · cache write 1.25 · cache read 0.1 · output 5
//   model mix:  opus 1 · fable 1.5 (unknown, guessed) · sonnet 0.2 · haiku 0.07
export const TOKEN_WEIGHTS = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };
export const MODEL_WEIGHTS = { opus: 1, fable: 1.5, sonnet: 0.2, haiku: 0.07 };
export function usageUnits(model, u) {
  const fam = Object.keys(MODEL_WEIGHTS).find((k) => String(model || '').toLowerCase().includes(k));
  const w = MODEL_WEIGHTS[fam] ?? 1;
  const t = (u.input_tokens || 0) * TOKEN_WEIGHTS.input
    + (u.cache_creation_input_tokens || 0) * TOKEN_WEIGHTS.cacheWrite
    + (u.cache_read_input_tokens || 0) * TOKEN_WEIGHTS.cacheRead
    + (u.output_tokens || 0) * TOKEN_WEIGHTS.output;
  return (t * w) / 1e6;
}

/** Reads the append-only .jsonl logs incrementally (byte offsets), so a heartbeat is cheap. */
export function createUsageMeter(dir, { maxAgeMs = 8 * DAY } = {}) {
  const files = new Map(); // file → { offset, entries: Map(id → [ts, units]) }
  function walk(d, out, minMtime) {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, out, minMtime);
      else if (e.name.endsWith('.jsonl')) {
        try { if (fs.statSync(p).mtimeMs >= minMtime) out.push(p); } catch {}
      }
    }
  }
  function scanFile(p) {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    const rec = files.get(p) || { offset: 0, entries: new Map() };
    if (st.size < rec.offset) { rec.offset = 0; rec.entries.clear(); }
    if (st.size > rec.offset) {
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.alloc(st.size - rec.offset);
        fs.readSync(fd, buf, 0, buf.length, rec.offset);
        const text = buf.toString('utf8');
        const cut = text.lastIndexOf('\n');
        if (cut >= 0) {
          rec.offset += Buffer.byteLength(text.slice(0, cut + 1));
          for (const line of text.slice(0, cut).split('\n')) {
            if (!line.includes('"usage"')) continue;
            try {
              const j = JSON.parse(line);
              const msg = j.message;
              if (!msg?.usage || j.type !== 'assistant') continue;
              const ts = Date.parse(j.timestamp);
              if (!ts) continue;
              rec.entries.set(msg.id || `${p}:${rec.offset}:${ts}`, [ts, usageUnits(msg.model, msg.usage)]);
            } catch {}
          }
        }
      } finally { fs.closeSync(fd); }
    }
    files.set(p, rec);
  }
  return {
    /** Estimated units spent since `sinceMs` across her conversation and all her workers. */
    unitsSince(sinceMs, now = Date.now()) {
      const list = [];
      walk(dir, list, Math.max(sinceMs, now - maxAgeMs));
      let sum = 0;
      for (const p of list) {
        scanFile(p);
        for (const [ts, u] of files.get(p).entries.values()) if (ts >= sinceMs) sum += u;
      }
      return sum;
    },
  };
}
