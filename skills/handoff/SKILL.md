---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
license: "MIT; see ../../licenses/mattpocock-skills-MIT.txt"
---

<!-- Adapted from mattpocock/skills at revision 49dd158d1076134a641b33efb035946536778336. Pi compatibility changes are documented in ../../THIRD_PARTY_NOTICES.md. -->

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save to a new, uniquely named Markdown file in the temporary directory of the active execution environment (`$TMPDIR`, else `/tmp`; `%TEMP%` on Windows) - not the current workspace. On an HPC workspace, this is a remote file; say which host holds it. Never overwrite an earlier handoff.

Include the objective, relevant workspace and branch, settled decisions, progress, validation results, outstanding work or blockers, and concrete next steps. Distinguish completed work from proposals and verified results from assumptions.

Include a "suggested skills" section with relevant skills actually available in this session and how to load them in Pi (for example, `/skill:grill-me` or reading its `SKILL.md`), rather than assuming a Skill tool exists.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments after `/handoff` or `/skill:handoff`, treat them as a description of what the next session will focus on and tailor the doc accordingly. Without arguments, summarize for continuing the current work.

Report the exact handoff path and give a copyable instruction for the next session: `Read <handoff-path> and continue from the next steps.` Temporary files may be cleared by the OS and are not automatically transferred between machines; mention this when reporting the path. This command only writes a document: it does not compact, clear, switch, or end the current Pi session.
