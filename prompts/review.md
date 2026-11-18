---
description: Adversarially review branch changes before merging
argument-hint: "[additional review instructions]"
---
<!-- Adapted from the existing personal review prompt and review criteria in mitsuhiko/agent-stuff extensions/review.ts at revision 13bc8f8 (Apache-2.0). See ../THIRD_PARTY_NOTICES.md. -->

Adversarially review the changes in this branch.

Additional review instructions: ${ARGUMENTS:-No additional instructions; review the full branch change.}

## Establish the review scope

Do not guess the diff. Inspect `git status --short`, identify the default/base branch, determine the merge base, and review the complete diff that would be merged. Include staged, unstaged, and untracked changes when they belong to the branch. If this is the default branch with no branch diff, review the local working-tree changes. State the exact scope and comparison used.

Read surrounding code, tests, call sites, contracts, and project instructions as needed. Treat the current worktree and command output as authoritative; do not review the diff in isolation.

## What to flag

Trust nothing until verified. Actively try to falsify the implementation and design by finding concrete bugs, edge cases, security problems, regressions, broken invariants, incomplete requirements, unsafe assumptions, or flawed architecture.

Report an issue only when it is:

1. Introduced by the reviewed change and overlaps the actual review scope.
2. Discrete, actionable, and likely worth fixing.
3. Supported by a concrete failure scenario or provable impact; do not speculate about unidentified breakage.
4. Not clearly an intentional behavior change.
5. Evaluated with rigor consistent with the rest of the codebase and its documented standards.

Pay particular attention to:

- Untrusted input, injection, open redirects, SSRF/local-network access, auth and permission changes, unsafe output handling, and non-parameterized SQL.
- Backpressure, concurrency, state restoration, partial failure, operational risk, and compatibility.
- Added or modified `try/catch` blocks. Prefer failure propagation unless that exact layer can fully recover without hiding correctness failures. Flag swallowed parse/I/O/network errors, success-like fallbacks, and checks against unstable error-message text instead of stable codes or identifiers.
- Permanent maintainability. Favor simple, coherent, idiomatic implementations; flag unnecessary complexity, duplication, dead or temporary scaffolding, awkward abstractions, redundant defensive code, or explanatory clutter. Comments and documentation should add context rather than restating the code.

Do not invent issues, nitpick style, or demand rigor absent from the surrounding project. Do not produce a full fix.

## Output

Start with **Review Scope**, including the base/merge-base and whether local changes were included.

Then list every qualifying finding, highest priority first. For each finding include:

- `[P0]` critical and universally blocking, `[P1]` urgent, `[P2]` normal, or `[P3]` low priority.
- A short title.
- The narrowest useful `path:line` location overlapping the reviewed diff.
- The concrete failure scenario, why it matters, and the smallest actionable direction.

After the findings, provide **Verdict: correct** or **Verdict: needs attention**. If there are no substantive findings, explicitly say so only after seriously attempting to break and simplify the change.

End with **Human Reviewer Callouts (Non-Blocking)**. Include only applicable informational callouts for database migrations, new or changed dependencies/lockfiles, auth or permission changes, backwards-incompatible public contracts, and irreversible or destructive operations. If none apply, write `- (none)`. Callouts alone do not change the verdict.
