# Third-party notices

## mitsuhiko/agent-stuff

Selected resources in this repository are copied or adapted from Armin Ronacher's [`mitsuhiko/agent-stuff`](https://github.com/mitsuhiko/agent-stuff) at revision `13bc8f87970bec8830aab0f1c0487d35aa7c0917`.

The upstream work is licensed under the Apache License, Version 2.0. A copy is included at [`licenses/mitsuhiko-agent-stuff-Apache-2.0.txt`](licenses/mitsuhiko-agent-stuff-Apache-2.0.txt). The copied and adapted resources remain subject to that license; everything else in this repository is MIT-licensed (see [`LICENSE`](LICENSE)).

### Copied with provenance-only changes

- `extensions/btw.ts`
- `extensions/goal.ts`
- `skills/commit/SKILL.md`

### Adapted

- `extensions/notify.ts` — notifications are delayed until `agent_settled` and limited to interactive TUI sessions.
- `extensions/session-breakdown.ts` — session discovery respects `PI_CODING_AGENT_SESSION_DIR` and `PI_CODING_AGENT_DIR`; its main dark categorical palette was replaced with a contrast- and CVD-screened palette.
- `skills/pi-share/SKILL.md`, `skills/pi-share/fetch-session.mjs` — script paths no longer assume `~/.pi/agent/skills`; the human-summary prompt is passed through stdin and the `pi` shim is resolved through a shell on Windows.
- `prompts/review.md` — incorporates review criteria and structured-output ideas from `extensions/review.ts`, adapted to this repository's existing prompt-template workflow.

Each adapted source file carries a notice describing the changes.

## mattpocock/skills

Selected productivity skills are copied or adapted from Matt Pocock's [`mattpocock/skills`](https://github.com/mattpocock/skills/tree/49dd158d1076134a641b33efb035946536778336/skills/productivity) at revision `49dd158d1076134a641b33efb035946536778336`.

The upstream work is licensed under the MIT License. A copy is included at [`licenses/mattpocock-skills-MIT.txt`](licenses/mattpocock-skills-MIT.txt). These resources remain subject to that license.

### Copied with provenance-only changes

- `skills/teach/GLOSSARY-FORMAT.md`
- `skills/teach/LEARNING-RECORD-FORMAT.md`
- `skills/teach/MISSION-FORMAT.md`
- `skills/teach/RESOURCES-FORMAT.md`

### Adapted

- `skills/grill-me/SKILL.md` — replaces the upstream Skill-tool invocation with a relative pointer to `grilling`; defines argument and missing-topic behavior.
- `skills/grilling/SKILL.md` — permits direct tool-based investigation when subagents are unavailable and respects access restrictions and unknown facts.
- `skills/teach/SKILL.md` — adds request/resume behavior, workspace confirmation and preservation, the glossary-format pointer, source-access fallback, remote/headless lesson handling, and comparable rather than mechanically equal quiz-answer lengths.
- `skills/handoff/SKILL.md` — replaces Skill-tool instructions with Pi equivalents; adds unique temporary files, active-host awareness, a continuation checklist, path reporting, temporary-file caveats, and explicit document-only behavior.

Each skill also carries license and provenance metadata. `extensions/productivity-commands.ts` is a local alias implementation, not an upstream import. Upstream agent-specific YAML files are not needed by Pi and are not included. Updates are manual and should be reviewed against this pinned revision before adoption.
