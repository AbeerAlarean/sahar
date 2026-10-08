# Sahar

One assistant for all your work across repos. You talk to her in one window; she keeps the picture of everything you're working on, hands the actual work to background workers (Claude Code agents), and remembers what was decided and why. She is never busy: talk to her any time, even while workers run.

She runs on your machine, on **your own Claude Code login or API key**. Nothing is sent anywhere else.

## What you need

- **Node 22+** — `node -v`
- **Claude Code, signed in** — run `claude` once and sign in (she uses that login). Or set `ANTHROPIC_API_KEY` to run on your own API key.
- **GitHub CLI, signed in** — `brew install gh`, then `gh auth login` (how she learns what you've built)
- **git**

## Start

```bash
git clone https://github.com/AbeerAlarean/sahar.git ~/sahar
cd ~/sahar
npm install
npm start
```

Open **http://localhost:4747**. She speaks first.

## First time

She introduces herself, checks your setup and tells you exactly what's missing. Then she asks which repos you work in (she can find them for you), reads each one with a worker — what it is, how to run it, its rules, and your own PRs and branches — and drafts your workload for you to correct. Then a few questions, one at a time, about how you like to work. After that you just talk.

## Day to day

- **"How's my workload?"** — what's in progress, one repo at a time.
- **Give her priorities** — she prepares, plans with you, and once you approve she runs the work without asking again.
- **Main tasks strip** at the top: your few main tasks, the product they belong to, the stage they're at and what's happening now — a pulsing dot when a worker is on it, red when it needs you. Collapse it to a slim bar (it opens on hover) or pin it open.
- **Pin answers** to the side panel — one pin per topic, updated with the latest answer.
- **Esc** stops her mid-reply; workers keep going.
- **Light and dark** themes (follows your Mac until you choose).
- **Drop or paste** screenshots and files into the window.
- **"I'm testing"** pauses anything that would restart what you're looking at. **"Test passed"** lets her push and open the PR. Merging is always your click.

## Safety rails (enforced in code, not just instructions)

She can't run commands herself — only workers can. Workers can never merge a PR, push to main/master, force-push, hard-reset, run database migrations/seeds/resets, or push shared config. Pushing and opening PRs only unlock when you say "push", "PR" or "test passed" (and "don't push" keeps them locked). Run `npm test` to check the rails.

## Her voice

If `hub/mind/persona.md` exists, she speaks in that character (your agreement with her still wins where they differ). Write it yourself, or ask her to draft one with you.

## Where your stuff lives

- `hub/` — her brain: her notes about you, your repos, your workload, decisions and lessons. Created on first start from `hub-template/`.
- `data/` — your conversation and the files you drop in.

Both stay on your machine and are git-ignored. Updating Sahar (`git pull`) never touches them.

## Settings (optional)

| Variable | Default | What |
|---|---|---|
| `PORT` | `4747` | where the window runs |
| `MAIN_MODEL` | `claude-opus-5-5` | the model she thinks on |
| `HUB_DIR` / `DATA_DIR` | `./hub` / `./data` | where her brain and your conversation live |

If you change your Claude account or plan, restart her (`Ctrl+C`, `npm start`).

## License

MIT — see [LICENSE](LICENSE).
