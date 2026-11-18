# Choosing a visualization form

Choose based on the reader's task, not novelty.

| Task | Preferred forms | Notes |
|---|---|---|
| One headline value | Stat tile or prominent number | Include comparison/context if meaningful. |
| Change over time | Line chart | Use bars for sparse periods or discrete totals; area only when volume is meaningful. |
| Compare categories | Sorted horizontal bars or dot plot | Keep a meaningful order; use a shared zero baseline for bars. |
| Distribution | Histogram, ECDF, box/violin plus points | Show sample size and outliers; avoid hiding multimodality. |
| Relationship | Scatterplot | Add trend only if justified; encode a third variable sparingly. |
| Part-to-whole | Stacked bars | Pie/donut only for a simple glanceable composition with few, distinct slices. |
| Magnitude over a matrix | Heatmap | Use a sequential scale and include a scale legend. |
| Positive/negative deviation | Diverging bars or heatmap | The midpoint must be meaningful, usually zero or a target. |
| Geography | Map only when location is explanatory | Otherwise sorted bars are usually easier to compare. |
| Several comparable series | Small multiples | Shared scales make comparison honest. |
| Exact lookup | Table | Add bars/sparklines only when they aid scanning. |

## Form checks

- Does the form answer the stated question directly?
- Are values compared on a common scale?
- Is zero required? Bars generally require zero; lines often do not, but truncation must not exaggerate variation.
- Is aggregation appropriate and clearly described?
- Would a number or table communicate the result more directly?
- If time is present, is it truly continuous and correctly ordered?
- If uncertainty matters, is it shown rather than implied away?
