#!/usr/bin/env python3
"""Build single static HTML for WoT Albums with new side-by-side layout."""
import os

DIR = os.path.dirname(os.path.abspath(__file__))

def read(path):
    with open(os.path.join(DIR, path)) as f:
        return f.read()

css = read('css/style.css')
# Remove @import since we use <link> tag
css = css.replace("@import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700;900&family=Inter:wght@300;400;500;600&display=swap');\n", "")
albums_js = read('js/albums.js')
timings_js = read('js/lyrics-timings.js')
sync_ref_js = read('js/sync-reference.js')
sync_analysis_js = read('js/sync-analysis.js')
app_js = read('js/app.js')

# --- CSS overrides for the new layout ---
# Key change: album detail becomes a two-column flex layout
# Left: compact art + info + tracklist
# Right: lyrics panel (full height, no scroll-below)
css_overrides = """
/* ===== NEW LAYOUT OVERRIDES ===== */

/* Album detail: two-column flex layout filling viewport */
.album-detail {
  display: none;
  max-width: 1600px;
  margin: 0 auto;
  padding: 90px 32px 100px;
}

.album-detail.active {
  display: flex;
  gap: 32px;
  align-items: stretch;
  min-height: calc(100vh - 190px);
}

/* Left column: art + info + tracklist */
.detail-left {
  display: flex;
  flex-direction: column;
  width: 480px;
  min-width: 380px;
  flex-shrink: 0;
  overflow-y: auto;
  max-height: calc(100vh - 190px);
  scrollbar-width: thin;
}

.detail-left::-webkit-scrollbar { width: 4px; }
.detail-left::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 2px; }

/* Compact header within left column */
.album-detail-header {
  display: flex;
  gap: 20px;
  margin-bottom: 20px;
  align-items: flex-start;
  flex-shrink: 0;
}

.album-detail-art {
  width: 140px;
  min-width: 140px;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5);
}

.album-detail-art img {
  width: 100%;
  height: 140px;
  object-fit: cover;
}

.album-detail-info { flex: 1; min-width: 0; }

.album-detail-character {
  font-size: 0.65rem;
  letter-spacing: 3px;
  margin-bottom: 4px;
}

.album-detail-title {
  font-size: clamp(1.1rem, 2.5vw, 1.5rem);
  margin-bottom: 8px;
}

.album-detail-desc {
  font-size: 0.82rem;
  line-height: 1.5;
  margin-bottom: 12px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.album-detail-meta { font-size: 0.75rem; }

/* Tracklist fills remaining left column space */
.track-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

/* Right column: lyrics panel takes remaining width */
.lyrics-panel {
  flex: 1;
  min-width: 0;
  max-height: calc(100vh - 190px);
  overflow-y: auto;
  position: static;
  display: none;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 28px;
}

.lyrics-panel.active {
  display: flex;
  flex-direction: column;
}

.lyrics-content {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

/* When no lyrics shown, left column takes full width */
.album-detail.active:not(.has-lyrics) .detail-left {
  max-width: 800px;
  margin: 0 auto;
}

/* Remove the old body wrapper styles */
.album-detail-body {
  display: contents;
}

/* Responsive */
@media (max-width: 900px) {
  .album-detail.active {
    flex-direction: column;
    min-height: auto;
  }
  .detail-left {
    width: 100%;
    min-width: 0;
    max-height: none;
    overflow-y: visible;
  }
  .lyrics-panel {
    max-height: 50vh;
    position: static;
  }
  .album-detail-art {
    width: 120px;
    min-width: 120px;
  }
  .album-detail-art img {
    height: 120px;
  }
}

@media (max-width: 480px) {
  .album-detail-header {
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .album-detail-art {
    width: 160px;
    min-width: 160px;
  }
  .album-detail-art img {
    height: 160px;
  }
}
"""

# --- JS overrides ---
# Change .album-detail-body class toggle to .album-detail
app_js_patched = app_js.replace(
    "var body = document.querySelector('.album-detail-body');\n    if (body) body.classList.add('has-lyrics');",
    "var detail = document.getElementById('detail-view');\n    if (detail) detail.classList.add('has-lyrics');"
).replace(
    "var body = document.querySelector('.album-detail-body');\n    if (body) body.classList.remove('has-lyrics');",
    "var detail = document.getElementById('detail-view');\n    if (detail) detail.classList.remove('has-lyrics');"
)

html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>The Wheel of Time — Album Collection</title>
  <meta name="description" content="A dark, moody music collection inspired by the Wheel of Time. Fifteen character albums with original lyrics.">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔥</text></svg>">
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700;900&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
{css}
{css_overrides}
  </style>
</head>
<body>

  <!-- Ambient Background -->
  <div class="ambient-bg">
    <div class="ambient-orb"></div>
    <div class="ambient-orb"></div>
    <div class="ambient-orb"></div>
  </div>

  <!-- Header -->
  <header class="site-header">
    <div class="header-content">
      <div>
        <div class="site-title">The Wheel of Time</div>
        <div class="site-subtitle">Album Collection</div>
      </div>
      <a href="#" class="nav-home" id="nav-home" onclick="event.preventDefault(); WOT.goHome();">All Albums</a>
    </div>
  </header>

  <!-- Grid View (Home) -->
  <div id="grid-view">
    <section class="hero">
      <div class="wheel-symbol">
        <svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
          <circle cx="50" cy="50" r="45"/>
          <circle cx="50" cy="50" r="20"/>
          <line x1="50" y1="5" x2="50" y2="30"/>
          <line x1="50" y1="70" x2="50" y2="95"/>
          <line x1="5" y1="50" x2="30" y2="50"/>
          <line x1="70" y1="50" x2="95" y2="50"/>
          <line x1="18" y1="18" x2="36" y2="36"/>
          <line x1="64" y1="64" x2="82" y2="82"/>
          <line x1="82" y1="18" x2="64" y2="36"/>
          <line x1="36" y1="64" x2="18" y2="82"/>
        </svg>
      </div>
      <h1>The Wheel of Time</h1>
      <p>Fifteen character albums. The Pattern weaves as the Pattern wills, and every thread has a song to sing.</p>
    </section>

    <div class="albums-grid" id="albums-container">
      <!-- Rendered by JS -->
    </div>
  </div>

  <!-- Album Detail View (NEW LAYOUT: two-column) -->
  <div class="album-detail" id="detail-view">
    <!-- Left Panel: Art + Info + Tracklist -->
    <div class="detail-left">
      <div class="album-detail-header">
        <div class="album-detail-art">
          <img id="detail-art" src="" alt="Album art">
        </div>
        <div class="album-detail-info">
          <div class="album-detail-character" id="detail-character"></div>
          <h2 class="album-detail-title" id="detail-title"></h2>
          <p class="album-detail-desc" id="detail-desc"></p>
          <div class="album-detail-meta" id="detail-meta"></div>
          <div class="no-audio-badge">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            Lyrics only &mdash; audio coming soon
          </div>
        </div>
      </div>

      <div class="track-list">
        <div class="track-list-header">Tracklist</div>
        <div id="track-list-body">
          <!-- Rendered by JS -->
        </div>
      </div>
    </div>

    <!-- Right Panel: Lyrics -->
    <div class="lyrics-panel" id="lyrics-panel">
      <div class="lyrics-panel-header">
        <div class="lyrics-panel-title" id="lyrics-title"></div>
        <div style="display:flex;align-items:center;gap:4px;">
          <button class="sync-toggle" id="sync-toggle" onclick="WOT.toggleSync()">Sync</button>
          <button class="lyrics-panel-close" onclick="WOT.hideLyrics()">Close</button>
        </div>
      </div>

      <div class="sync-metrics" id="sync-metrics">
        <span class="sync-metric">
          <span class="sync-metric-dot" style="background:var(--sync-perfect)"></span>
          <span class="sync-metric-value" id="sync-pcetw">&mdash;</span>% in sync
        </span>
        <span class="sync-metric-sep">|</span>
        <span class="sync-metric">
          Avg drift: <span class="sync-metric-value" id="sync-aae">&mdash;</span>ms
        </span>
        <span class="sync-metric-sep">|</span>
        <span class="sync-metric">
          <span class="sync-metric-dot" style="background:var(--sync-misaligned)"></span>
          <span class="sync-metric-value" id="sync-misaligned">&mdash;</span> misaligned
        </span>
        <span class="sync-metric-sep">|</span>
        <div class="sync-tier-bar" id="sync-tier-bar"></div>
      </div>

      <div class="sync-drift-timeline" id="sync-drift-timeline">
        <div class="sync-drift-tolerance"></div>
        <div class="sync-drift-baseline"></div>
      </div>
      <div class="sync-legend" id="sync-legend">
        <span class="sync-legend-item"><span class="sync-legend-swatch" style="background:var(--sync-perfect)"></span> &lt;100ms</span>
        <span class="sync-legend-item"><span class="sync-legend-swatch" style="background:var(--sync-good)"></span> &lt;300ms</span>
        <span class="sync-legend-item"><span class="sync-legend-swatch" style="background:var(--sync-drifting)"></span> &lt;500ms</span>
        <span class="sync-legend-item"><span class="sync-legend-swatch" style="background:var(--sync-misaligned)"></span> &gt;500ms</span>
      </div>
      <div class="sync-no-data" id="sync-no-data">No sync reference data available for this track.</div>

      <div class="lyrics-content" id="lyrics-content"></div>
    </div>
  </div>

  <!-- Persistent Audio Player -->
  <div class="audio-player" id="audio-player">
    <div class="player-content">
      <div class="player-track-info">
        <div class="player-art">
          <img id="player-art" src="" alt="">
        </div>
        <div>
          <div class="player-track-name" id="player-track-name">&mdash;</div>
          <div class="player-album-name" id="player-album-name">&mdash;</div>
        </div>
      </div>

      <div class="player-controls">
        <button class="player-btn" title="Previous">
          <svg viewBox="0 0 24 24"><polygon points="19,20 9,12 19,4"/><line x1="5" y1="4" x2="5" y2="20" stroke="currentColor" stroke-width="2"/></svg>
        </button>
        <button class="player-btn-play" id="play-btn" onclick="WOT.togglePlay()" title="Play">
          <svg viewBox="0 0 24 24"><polygon points="5,3 19,12 5,21"/></svg>
        </button>
        <button class="player-btn" title="Next">
          <svg viewBox="0 0 24 24"><polygon points="5,4 15,12 5,20"/><line x1="19" y1="4" x2="19" y2="20" stroke="currentColor" stroke-width="2"/></svg>
        </button>
      </div>

      <div class="player-progress-container">
        <span class="player-time">0:00</span>
        <div class="player-progress">
          <div class="player-progress-fill"></div>
        </div>
        <span class="player-time">0:00</span>
      </div>

      <div class="player-volume">
        <button class="player-btn" title="Volume">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
        </button>
        <div class="player-volume-slider">
          <div class="player-volume-fill"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- Sync Tooltip -->
  <div class="sync-tooltip" id="sync-tooltip">
    <div class="sync-tooltip-title" id="sync-tooltip-title"></div>
    <div class="sync-tooltip-row"><span class="sync-tooltip-label">Offset:</span> <span class="sync-tooltip-value" id="sync-tooltip-offset"></span></div>
    <div class="sync-tooltip-row"><span class="sync-tooltip-label">Expected:</span> <span class="sync-tooltip-value" id="sync-tooltip-expected"></span></div>
    <div class="sync-tooltip-row"><span class="sync-tooltip-label">Actual:</span> <span class="sync-tooltip-value" id="sync-tooltip-actual"></span></div>
    <div class="sync-tooltip-row"><span class="sync-tooltip-label">Confidence:</span> <span class="sync-tooltip-value" id="sync-tooltip-confidence"></span></div>
  </div>

  <!-- Footer -->
  <footer class="site-footer">
    <p>The Wheel of Time Album Collection &mdash; An Ada Production</p>
  </footer>

  <script>
{albums_js}
{timings_js}
{sync_ref_js}
{sync_analysis_js}
{app_js_patched}
  </script>
</body>
</html>"""

out_path = os.path.join(DIR, 'index-static.html')
with open(out_path, 'w') as f:
    f.write(html)

size = os.path.getsize(out_path)
print(f"Built: {out_path} ({size:,} bytes, {size/1024:.0f} KB)")
