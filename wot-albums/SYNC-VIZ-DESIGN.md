# Lyric Sync Visualization System — Design Proposal

## Overview

A visualization layer for the WoT Albums website that shows how well lyrics sync
with audio. It overlays sync quality metrics on the existing lyrics panel without
disrupting the current listening experience.

**Reference/test case:** Perrin's album — Wolves and Hammers (#901)

---

## Architecture

### Data Model

The system operates on two timing datasets per track:

1. **Estimated timings** — current `lyrics-timings.js` data (evenly distributed or
   manually set `{time, endTime, text}` per line)
2. **Reference timings** — ground-truth from forced alignment (Whisper, wav2vec2,
   or manual correction), stored as `{time, endTime, text, confidence}` per line

Sync quality is computed by comparing estimated vs reference for each line:

```
errorMs = |estimated.time - reference.time| * 1000
```

### Quality Tiers (MIREX-informed)

| Tier       | Error Range | Color        | CSS Variable          |
|------------|-------------|-------------|-----------------------|
| Perfect    | 0-100ms     | Green       | `--sync-perfect`      |
| Good       | 100-300ms   | Soft yellow | `--sync-good`         |
| Drifting   | 300-500ms   | Orange      | `--sync-drifting`     |
| Misaligned | 500ms+      | Red         | `--sync-misaligned`   |

The 300ms threshold comes from MIREX's Percentage of Correct Estimates with
Tolerance Window — it's the accepted boundary for human-perceptible sync errors.

---

## UI Components

### 1. Sync Quality Toggle (lyrics panel header)

A small toggle button in the lyrics panel header that switches between normal
lyrics view and sync analysis view. Non-intrusive — off by default.

```
[Track Title]                    [Sync] [Close]
```

When active, it enables the sync overlay on lyrics and shows the metrics bar.

### 2. Per-Line Sync Indicators

Each lyric line gets a thin colored bar on its left edge showing sync quality:

```
┃ Iron knows my hands before my name...     ← green bar = perfect
┃ Heat and steel, the only language...       ← green bar = perfect
┃ Master Luhhan taught me: move slow...      ← yellow bar = slight drift
┃ Big hands, gentle grip, shaping...         ← orange bar = drifting
```

Implementation: CSS `border-left` on `.lyrics-line` elements, color set via
inline `--sync-color` custom property. Width = 3px. Subtle, scannable.

Hovering a line shows a tooltip with exact offset: "+142ms early" or "-380ms late".

### 3. Sync Metrics Bar

A compact summary bar between the lyrics header and content:

```
┌──────────────────────────────────────────┐
│ ●92% in sync   ▸ Avg drift: 85ms   ▸ 2 misaligned lines │
└──────────────────────────────────────────┘
```

Three key metrics:
- **% in sync** — lines within 300ms tolerance (PCETW)
- **Avg drift** — mean absolute error across all lines (AAE)
- **Misaligned count** — lines beyond 500ms threshold

### 4. Drift Timeline (mini chart)

A thin horizontal bar chart below the metrics bar showing drift across the song's
timeline. Each line becomes a thin vertical bar, positioned proportionally along
the song duration, with height/color representing error magnitude.

```
  ▕ ▕▕▕ ▕  ▕ ▕▕▕▕▕▕ ▕ ▕▕ ▕  ▕▕▕▕▕▕   ▕ ▕
  ─────────────────────────────────────────── song timeline
  0:00            1:00            2:00   3:25
```

Green bars above the line = early, red bars below = late.
Height proportional to error magnitude. Renders as a pure CSS/HTML element
(no canvas needed).

### 5. Line Detail Popover (on hover/click)

When sync view is active and user hovers/clicks a line:

```
┌─────────────────────────────┐
│ Line 14 of 34               │
│ Offset: +142ms (early)      │
│ Confidence: 0.87            │
│ Expected: 1:21.67           │
│ Actual:   1:21.53           │
└─────────────────────────────┘
```

---

## Integration Strategy

### Files Modified
- `css/style.css` — add sync visualization styles
- `js/app.js` — add sync toggle, overlay logic, metrics computation

### Files Added
- `js/sync-analysis.js` — sync quality computation engine
- `js/sync-reference.js` — reference/ground-truth timing data (starts with Perrin)

### Zero-Disruption Guarantee
- Sync view is **off by default** — toggle activates it
- All sync styles use a parent `.sync-active` class on the lyrics panel
- Normal playback and highlighting continue to work unchanged
- Sync indicators layer on top of existing styles (border-left, not replacing)

---

## Metrics Computation (sync-analysis.js)

```javascript
function analyzeSyncQuality(estimated, reference) {
  const results = estimated.map((est, i) => {
    const ref = reference[i];
    const errorMs = Math.abs(est.time - ref.time) * 1000;
    const direction = est.time < ref.time ? 'early' : 'late';
    const tier = errorMs < 100 ? 'perfect'
               : errorMs < 300 ? 'good'
               : errorMs < 500 ? 'drifting'
               : 'misaligned';
    return { line: i, errorMs, direction, tier, confidence: ref.confidence };
  });

  const inSync = results.filter(r => r.errorMs < 300).length;
  const avgDrift = results.reduce((s, r) => s + r.errorMs, 0) / results.length;
  const misaligned = results.filter(r => r.errorMs >= 500).length;

  return {
    lines: results,
    summary: {
      pcetw: (inSync / results.length * 100).toFixed(1),
      aae: Math.round(avgDrift),
      misalignedCount: misaligned,
      totalLines: results.length
    }
  };
}
```

---

## Reference Data Format (sync-reference.js)

```javascript
window.syncReference = {
  "wolves-and-hammers": {
    "The Forge": {
      lines: [
        { time: 0.8, endTime: 7.1, text: "Iron knows...", confidence: 0.92 },
        { time: 7.3, endTime: 13.5, text: "Heat and steel...", confidence: 0.88 },
        // ...
      ]
    }
  }
};
```

The `confidence` field comes from the forced alignment model (0-1 scale).
For manually corrected entries, confidence = 1.0.

---

## Implementation Phases

### Phase 1: Engine + Static Analysis (this task)
- Build `sync-analysis.js` computation engine
- Create synthetic reference data for Perrin's album to demonstrate the system
- Add CSS styles for all sync visualization components
- Wire toggle into existing lyrics panel

### Phase 2: Ground Truth Generation (future)
- Run forced alignment (Whisper or wav2vec2) on Perrin's audio
- Generate real reference timings
- Replace synthetic data with actual measurements

### Phase 3: Expand to All Albums (future)
- Generate reference data for remaining synced albums
- Add album-level aggregate metrics to album cards
- Consider batch analysis tooling

---

## Color Palette (dark theme compatible)

```css
--sync-perfect:    #4CAF50;  /* green — within 100ms */
--sync-good:       #8BC34A;  /* lime — within 300ms */
--sync-drifting:   #FF9800;  /* orange — within 500ms */
--sync-misaligned: #F44336;  /* red — beyond 500ms */
--sync-bg:         rgba(255,255,255,0.03);
```

These contrast well against the `#0a0a0c` background and don't clash with
the existing ember/purple accent palette.

---

## Accessibility

- Color is not the only indicator — error magnitude shown as text on hover
- Left border bars are 3px wide (visible but not overwhelming)
- Metrics bar uses text labels alongside visual indicators
- Drift timeline has a baseline marker for orientation
- All interactive elements are keyboard accessible (toggle is a button, not checkbox)
