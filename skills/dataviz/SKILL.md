---
name: dataviz
description: Design and implement clear, elegant, accessible charts, plots, dashboards, KPI tiles, and other data visualizations in any medium or library. Use before writing visualization code or choosing chart colors.
---

# Data Visualization

Treat visualization as a sequence of testable design decisions, not decoration. Read this skill before writing the first line of chart code.

## Workflow

Follow these steps in order. Color comes after form and structure.

1. **Understand the question and data.** Identify the audience, decision, measures, dimensions, units, missing values, uncertainty, and whether values are raw, aggregated, or cumulative. Verify transformations before plotting.
2. **Choose the form.** Match the chart to the data's job using [references/choosing-a-form.md](references/choosing-a-form.md). Sometimes the right output is a number, table, or small multiple rather than a chart.
3. **Define the visual hierarchy.** Write a takeaway-oriented title, use a short subtitle for scope/method, emphasize the evidence that answers the question, and make axes/gridlines/context recessive.
4. **Assign color by role.** Use categorical color for identity, sequential color for magnitude, diverging color for polarity around a meaningful midpoint, and status color only for state. Start from [references/palette.md](references/palette.md) unless the project has a design system.
5. **Validate categorical colors.** Run:
   ```bash
   python3 scripts/validate_palette.py '#2a78d6,#1baf7a,#eda100' --mode light
   ```
   Run it from this skill directory, or pass the script's full path. On Windows, use `py` or `python` if `python3` is not on `PATH`. Treat failures as design work, not warnings to ignore. Preserve identity with labels, symbols, line styles, or texture as needed.
6. **Apply restrained mark styling.** Prefer 2px lines, visible markers of at least 7–8px when markers matter, subtle grids, direct labels for a few important series, and enough separation between adjacent/overlapping fills. Do not label every point.
7. **Add interaction where appropriate.** Interactive line/area charts should normally have a crosshair or nearest-point tooltip; bars, dots, and cells should have per-mark tooltips. Make hit targets larger than thin marks. Keep filters together above the visualization.
8. **Check accessibility.** Never rely on color alone. Use a legend for two or more series; direct-label up to four series when practical. Supply a table or textual summary for important data. Format units explicitly. Validate light and dark palettes independently.
9. **Render and inspect.** Open or screenshot the actual output. Check clipping, overlap, tick density, mobile/narrow layouts, dark mode, empty states, and whether the intended takeaway is obvious.
10. **Run the anti-pattern review.** Check [references/anti-patterns.md](references/anti-patterns.md) before finishing.

## Non-negotiables

- Never use dual y-axes. Use small multiples, separate charts, or normalize both series to a common baseline.
- Color belongs to an entity, not its current rank. Filtering must not repaint surviving categories.
- Do not cycle or generate categorical hues indefinitely. Above roughly eight categories, group the tail, facet, or add a second encoding.
- Sequential scales use one hue from light to dark. Diverging scales use opposing hues and a neutral midpoint.
- Reserve green/yellow/orange/red status colors for actual status semantics.
- Text uses text colors, not series colors; put a colored mark beside text to communicate identity.
- One series does not need a legend when the title already names it.
- Cite the data source and explain non-obvious transformations or limitations.

## Deliverables

Unless the request says otherwise:

- Keep source data/transformation separate from presentation code.
- Save editable source alongside rendered output.
- State the chart's data source and important assumptions.
- If code is created, run it and inspect the generated artifact before reporting completion.
