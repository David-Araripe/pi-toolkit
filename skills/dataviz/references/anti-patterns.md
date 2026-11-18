# Visualization anti-patterns

Fix any applicable item before shipping.

## Encoding and color

- **Dual y-axes:** arbitrary scale alignment can manufacture a visual correlation. Use separate charts, small multiples, or a common indexed baseline.
- **Recoloring after filtering:** assign category colors by stable identity, never current rank.
- **Unlimited categorical hues:** above roughly eight, use “Other,” small multiples, direct labels, shapes, or line styles.
- **Rainbow sequential scales:** encode magnitude with a single-hue light-to-dark ramp.
- **Colored diverging midpoint:** the midpoint must be neutral and meaningful.
- **Color-only meaning:** reinforce identity/status with text, icon, shape, texture, or line style.
- **Status colors as decoration:** reserve semantic colors for actual states.
- **Series-colored body text:** use normal text tokens and a nearby swatch/mark.

## Form

- **A chart for one number:** prefer a stat tile with useful context.
- **One-bar chart or two-slice donut:** show the values directly.
- **Pie/donut for close comparisons:** use bars or a table.
- **3D charts:** perspective distorts comparison and adds no information.
- **Bars without zero:** bar length encodes magnitude and requires a zero baseline.
- **Unsorted categories:** sort by value unless a natural/domain order is more meaningful.
- **Too many lines:** highlight a few, facet, or provide filtering.
- **Smoothing that invents precision:** show raw points or clearly explain the method.

## Anatomy and interaction

- **Title names only the metric:** use the title to state the takeaway; put scope/method in a subtitle.
- **Every point labeled:** label endpoints, exceptions, or selected values only.
- **Dominant gridlines and borders:** make scaffolding quieter than data.
- **Legend far from the data:** direct-label a small number of series where practical.
- **Tiny hover targets:** use an invisible larger interaction target around thin marks.
- **Tooltip as the only access to values:** provide labels, a table, or an accessible textual equivalent.
- **Unformatted units:** show currency, percentage, count scale, timezone, and aggregation clearly.

## Data honesty

- **Cumulative and per-period values confused:** label the transformation explicitly.
- **Missing values treated as zero:** preserve and explain missingness unless zero is semantically correct.
- **Aggregation hides distribution:** provide distribution/sample-size context when it affects interpretation.
- **Truncated line axis exaggerates change:** truncation can be valid, but label it clearly and inspect the implied story.
- **Cherry-picked date range:** state the range and offer relevant historical context.
- **No source or methodology note:** cite provenance and non-obvious transformations.
