---
name: simplify
description: Apply targeted simplifications to changed code while preserving intended behavior. Use only when explicitly asked to simplify or refactor the implementation; do not invoke merely because a code review mentions maintainability, complexity, tidiness, or simplification opportunities.
---

# Simplify Changed Code

Improve an already-established implementation without turning the task into a bug hunt or redesign.

Preserve intended behavior and keep changes scoped to the target diff.

Look for concrete opportunities to:

- reuse existing code instead of duplicating it,
- remove unnecessary state, wrappers, branches, configuration, or scaffolding,
- reduce duplication and accidental complexity,
- replace special cases with an existing or clearly better abstraction,
- remove comments that merely narrate obvious code,
- eliminate meaningful wasted work where the simpler alternative remains clear.

Prefer deletion and reuse over adding abstractions. Do not make speculative, stylistic, or churn-heavy changes.

Do not:
- repair uncertain behavior by guessing intent,
- broaden the scope into unrelated code,
- change public behavior unless explicitly requested,
- optimize without a concrete reason,
- refactor merely to make code different or shorter.

After changes, run the narrowest relevant validation and briefly report what changed and what was verified.
