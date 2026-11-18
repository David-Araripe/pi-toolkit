# Reference palette

Use project design tokens when available. Otherwise this is a restrained starting point. Define colors by semantic role rather than scattering raw hex values through chart code.

## Surfaces and text

| Role | Light | Dark |
|---|---:|---:|
| chart surface | `#fcfcfb` | `#1a1a19` |
| primary text | `#0b0b0b` | `#ffffff` |
| secondary text | `#52514e` | `#c3c2b7` |
| grid/border | `#e2e2df` | `#3a3a37` |

## Categorical series

Keep this fixed order so filtering does not change identity.

| Slot | Hue | Light | Dark |
|---:|---|---:|---:|
| 1 | blue | `#2a78d6` | `#3987e5` |
| 2 | aqua | `#1baf7a` | `#199e70` |
| 3 | yellow | `#eda100` | `#c98500` |
| 4 | green | `#008300` | `#36a936` |
| 5 | violet | `#4a3aa7` | `#9085e9` |
| 6 | red | `#e34948` | `#e66767` |
| 7 | magenta | `#e87ba4` | `#d55181` |
| 8 | orange | `#eb6834` | `#d95926` |

Some series colors do not achieve text-level contrast against the surface. That is acceptable for sufficiently large marks only when identity is also carried by direct labels, a legend, shape, line style, or a table. Never use these colors for body text.

## Sequential blue

Light to dark:

`#cde2fb`, `#b7d3f6`, `#9ec5f4`, `#86b6ef`, `#6da7ec`, `#5598e7`, `#3987e5`, `#2a78d6`, `#256abf`, `#1c5cab`, `#184f95`, `#104281`, `#0d366b`

Use the full range for continuous magnitude. For discrete ordinal marks, avoid the palest values when they disappear into the background.

## Diverging

Use blue and red as poles with a neutral center:

`#184f95`, `#3987e5`, `#9ec5f4`, `#e2e2df`, `#f3aaa9`, `#e66767`, `#a92525`

The midpoint must represent a meaningful neutral value. Do not use a diverging scale merely because the data has a minimum and maximum.

## CSS role example

```css
.viz-root {
  --viz-surface: #fcfcfb;
  --viz-text: #0b0b0b;
  --viz-muted: #52514e;
  --viz-grid: #e2e2df;
  --viz-series-1: #2a78d6;
}

@media (prefers-color-scheme: dark) {
  .viz-root {
    --viz-surface: #1a1a19;
    --viz-text: #ffffff;
    --viz-muted: #c3c2b7;
    --viz-grid: #3a3a37;
    --viz-series-1: #3987e5;
  }
}
```

Validate the exact subset and order used in the finished chart, separately for light and dark surfaces.
