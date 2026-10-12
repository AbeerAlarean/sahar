// Check-before-done: pure helpers. A task is "checked" only when Sahar herself wrote
// mind/checks/<slug>.md after the last worker finished on it.

/** "[Smart chat] x" / "Smart chat" → "smart-chat" */
export function slugOf(task) {
  return String(task || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** A worker description "[Task] …" → the task name, or null. */
export function taskOfWorker(description) {
  const m = String(description || '').match(/^\s*\[([^\]]{2,60})\]/);
  return m ? m[1].trim() : null;
}

// Stages where the result is being treated as done-or-nearly; these need her own check.
export const CHECKED_STAGES = new Set(['ready', 'test', 'pr', 'checking', 'safe', 'merged']);

/** state: { [slug]: lastWorkerDoneAt(ms) }; checkMtime: ms of her check file or null. */
export function isChecked(state, slug, checkMtime) {
  const done = state?.[slug];
  if (!done) return true; // no worker has finished on it — nothing to check yet
  return typeof checkMtime === 'number' && checkMtime > done;
}

/** Tasks (raw main-tasks.json entries) that sit at a checked stage but have not been checked. */
export function uncheckedTasks(tasks, state, mtimeOf) {
  if (!Array.isArray(tasks)) return [];
  return tasks.filter((t) => {
    const slug = slugOf(t?.name);
    return slug && CHECKED_STAGES.has(String(t?.stage)) && !isChecked(state, slug, mtimeOf(slug));
  });
}

export const VERIFY_LINE = 'Not checked yet — Sahar is checking the result';

/** What the window gets: unchecked tasks shown as "verify"; her file is never rewritten. */
export function overlayVerify(item, unchecked) {
  return unchecked ? { ...item, stage: 'verify', now: VERIFY_LINE } : item;
}

/** The short note prefixed to her next turn, or ''. */
export function uncheckedNote(unchecked) {
  if (!unchecked.length) return '';
  const names = unchecked.map((t) => t.title || t.name).join(', ');
  return `<unchecked>You have not checked these yourself yet — check before reporting them as done: ${names}. Judge the real result against the Done-means list, then write mind/checks/<task-slug>.md.</unchecked>\n`;
}
