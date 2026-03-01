// WoT Albums - Main Application
(function() {
  'use strict';

  const B2_ART = 'https://f004.backblazeb2.com/file/adas-storage/site/art';

  // Map album IDs to B2 art filenames
  var ART_MAP = {
    'dragon-reborn': 'album-dragon-reborn',
    'amyrlins-fire': 'album-amyrlin-fire',
    'wolves-and-hammers': 'album-wolves-and-hammers',
    'the-chess-player': 'album-the-chess-player',
    'duty-heavier-than-a-mountain': 'album-duty-heavier-than-a-mountain',
    'spear-and-flame': 'album-spear-and-flame',
    'the-gleemans-tale': 'album-the-gleemans-tale',
    'the-viewings': 'album-the-viewings',
    'the-fisher-queen': 'album-the-fisher-queen',
    'the-shepherds-sword': 'album-the-shepherds-sword',
    'shadow-and-the-flame': 'album-the-shadow-and-the-flame',
    'dice-stop-rolling': 'album-dice-stop-rolling',
    'daughter-of-the-night': 'album-daughter-of-the-night',
    'nynaeve-al-meara': 'album-nynaeve-al-meara'
  };

  function getArtUrl(albumId) {
    var mapped = ART_MAP[albumId] || albumId;
    return B2_ART + '/' + mapped + '.jpg';
  }

  // State
  let currentView = 'grid';
  let currentAlbum = null;
  let currentTrack = null;
  let currentTrackIndex = -1;
  let isPlaying = false;

  // A/B variant selections: { "albumId": { trackIndex: "A"|"B", ... }, ... }
  let variantSelections = {};
  var VARIANT_STORAGE_KEY = 'wot-variant-selections';

  function saveVariantSelections() {
    try {
      localStorage.setItem(VARIANT_STORAGE_KEY, JSON.stringify(variantSelections));
    } catch (e) { /* quota exceeded or private browsing */ }
  }

  function loadVariantSelections() {
    try {
      var saved = localStorage.getItem(VARIANT_STORAGE_KEY);
      if (saved) return JSON.parse(saved);
    } catch (e) { /* corrupted data */ }
    return null;
  }

  function initVariantSelections() {
    var saved = loadVariantSelections();
    ALBUMS.forEach(function(album) {
      variantSelections[album.id] = {};
      album.tracks.forEach(function(track, i) {
        // Restore saved selection if available, otherwise use track default or "A"
        var savedVariant = saved && saved[album.id] && saved[album.id][i];
        variantSelections[album.id][i] = savedVariant || track.variant || 'A';
      });
    });
  }

  function getVariantUrl(url, variant) {
    if (!url) return '';
    if (variant === 'B') {
      return url.replace(/-a\.mp3$/, '-b.mp3');
    }
    return url;
  }

  function getActiveUrl(track, albumId, trackIndex) {
    if (!track.url) return '';
    var v = variantSelections[albumId] && variantSelections[albumId][trackIndex];
    return getVariantUrl(track.url, v || 'A');
  }

  // Lyrics highlight state
  let lyricsLines = [];       // array of {el, isContent} for each rendered line
  let lastHighlightIndex = -1; // avoid redundant DOM updates

  // Sync visualization state
  let syncActive = false;
  let currentAnalysis = null;

  // Persistent audio element
  const audio = new Audio();
  audio.preload = 'metadata';

  // DOM refs
  let gridView, detailView, navHome, lyricsPanel;

  function init() {
    gridView = document.getElementById('grid-view');
    detailView = document.getElementById('detail-view');
    navHome = document.getElementById('nav-home');
    lyricsPanel = document.getElementById('lyrics-panel');

    initVariantSelections();
    renderGrid();
    setupNavigation();
    setupPlayerControls();

    window.addEventListener('popstate', function(e) {
      if (e.state && e.state.album) {
        showAlbum(e.state.album, false);
      } else {
        showGrid(false);
      }
    });

    var hash = window.location.hash.replace('#', '');
    if (hash) {
      var album = ALBUMS.find(function(a) { return a.id === hash; });
      if (album) {
        showAlbum(album.id, false);
        return;
      }
    }
  }

  function renderGrid() {
    var container = document.getElementById('albums-container');
    container.innerHTML = ALBUMS.map(function(album) {
      var trackCount = album.tracks.length;
      return '<div class="album-card" data-album="' + album.id + '" onclick="WOT.openAlbum(\'' + album.id + '\')">' +
        '<div class="album-card-art">' +
          '<img src="' + getArtUrl(album.id) + '" alt="' + album.title + '" loading="lazy" onerror="this.src=\'data:image/svg+xml,' + encodeURIComponent(generatePlaceholderSVG(album)) + '\'">' +
        '</div>' +
        '<div class="album-card-info">' +
          '<div class="album-card-play"><svg viewBox="0 0 24 24"><polygon points="5,3 19,12 5,21"/></svg></div>' +
          '<div class="album-card-character">' + album.character + '</div>' +
          '<div class="album-card-title">' + album.title + '</div>' +
          '<div class="album-card-tracks">' + trackCount + ' tracks</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function generatePlaceholderSVG(album) {
    var color = album.color || '#333';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">' +
      '<rect width="400" height="400" fill="' + color + '"/>' +
      '<text x="200" y="190" text-anchor="middle" fill="white" font-family="serif" font-size="20" opacity="0.7">' + album.character + '</text>' +
      '<text x="200" y="220" text-anchor="middle" fill="white" font-family="serif" font-size="14" opacity="0.4">' + album.title + '</text>' +
    '</svg>';
  }

  function albumHasAudio(album) {
    return album.tracks.some(function(t) { return t.url; });
  }

  function showAlbum(albumId, pushState) {
    var album = ALBUMS.find(function(a) { return a.id === albumId; });
    if (!album) return;

    currentAlbum = album;
    currentView = 'album';

    if (pushState !== false) {
      history.pushState({ album: albumId }, '', '#' + albumId);
    }

    document.getElementById('detail-art').src = getArtUrl(album.id);
    document.getElementById('detail-art').onerror = function() {
      this.src = 'data:image/svg+xml,' + encodeURIComponent(generatePlaceholderSVG(album));
    };
    document.getElementById('detail-character').textContent = album.character;
    document.getElementById('detail-title').textContent = album.title;
    document.getElementById('detail-desc').textContent = album.description;

    var totalDuration = album.tracks.reduce(function(sum, t) {
      var parts = t.duration.split(':');
      return sum + parseInt(parts[0]) * 60 + parseInt(parts[1]);
    }, 0);
    var mins = Math.floor(totalDuration / 60);

    document.getElementById('detail-meta').innerHTML =
      '<span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> ' + mins + ' min</span>' +
      '<span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg> ' + album.tracks.length + ' tracks</span>';

    var badge = document.querySelector('.no-audio-badge');
    if (badge) {
      badge.style.display = albumHasAudio(album) ? 'none' : 'flex';
    }

    var trackList = document.getElementById('track-list-body');
    trackList.innerHTML = album.tracks.map(function(track, i) {
      var activeClass = (currentTrack && currentTrack.title === track.title) ? ' active' : '';
      var currentVariant = variantSelections[album.id][i] || 'A';
      var hasAudio = !!track.url;
      var variantToggle = hasAudio
        ? '<div class="variant-toggle" data-track-idx="' + i + '" onclick="event.stopPropagation(); WOT.toggleVariant(\'' + album.id + '\', ' + i + ')">' +
            '<span class="variant-opt' + (currentVariant === 'A' ? ' variant-active' : '') + '">A</span>' +
            '<span class="variant-opt' + (currentVariant === 'B' ? ' variant-active' : '') + '">B</span>' +
          '</div>'
        : '';
      return '<div class="track-item' + activeClass + '" data-track-index="' + i + '" onclick="WOT.selectTrack(' + i + ')">' +
        '<span class="track-number">' + (i + 1) + '</span>' +
        '<span class="track-title">' + track.title + '</span>' +
        variantToggle +
        '<span class="track-duration">' + track.duration + '</span>' +
      '</div>';
    }).join('');

    // Add report button below tracklist
    var existingReport = document.getElementById('variant-report-btn');
    if (existingReport) existingReport.remove();
    if (albumHasAudio(album)) {
      var reportBtn = document.createElement('button');
      reportBtn.id = 'variant-report-btn';
      reportBtn.className = 'variant-report-btn';
      reportBtn.textContent = 'Report Variant Selection';
      reportBtn.onclick = function() { showVariantReport(album); };
      trackList.parentNode.appendChild(reportBtn);
    }

    document.documentElement.style.setProperty('--accent-ember', album.color);
    document.documentElement.style.setProperty('--accent-ember-glow', album.accent);

    gridView.style.display = 'none';
    detailView.classList.add('active');
    navHome.classList.add('visible');
    hideLyrics();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showGrid(pushState) {
    currentView = 'grid';
    currentAlbum = null;

    if (pushState !== false) {
      history.pushState({}, '', window.location.pathname);
    }

    document.documentElement.style.setProperty('--accent-ember', '#d4631d');
    document.documentElement.style.setProperty('--accent-ember-glow', '#ff7b2e');

    detailView.classList.remove('active');
    gridView.style.display = 'block';
    navHome.classList.remove('visible');
    hideLyrics();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function selectTrack(index) {
    if (!currentAlbum) return;
    var track = currentAlbum.tracks[index];
    if (!track) return;

    currentTrack = track;
    currentTrackIndex = index;

    document.querySelectorAll('.track-item').forEach(function(el) { el.classList.remove('active'); });
    var trackEl = document.querySelector('.track-item[data-track-index="' + index + '"]');
    if (trackEl) trackEl.classList.add('active');

    showLyrics(track);
    loadAndPlay(track);
  }

  function loadAndPlay(track) {
    var player = document.getElementById('audio-player');
    player.classList.add('active');

    document.getElementById('player-art').src = getArtUrl(currentAlbum.id);
    document.getElementById('player-art').onerror = function() {
      this.src = 'data:image/svg+xml,' + encodeURIComponent(generatePlaceholderSVG(currentAlbum));
    };
    document.getElementById('player-track-name').textContent = track.title;
    document.getElementById('player-album-name').textContent = currentAlbum.title;

    var times = document.querySelectorAll('.player-time');
    times[0].textContent = '0:00';
    times[1].textContent = track.duration;
    document.querySelector('.player-progress-fill').style.width = '0%';

    var activeUrl = getActiveUrl(track, currentAlbum.id, currentTrackIndex);
    if (activeUrl) {
      audio.src = activeUrl;
      audio.load();
      var playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.then(function() {
          isPlaying = true;
          updatePlayButton();
        }).catch(function(err) {
          console.log('Autoplay blocked, click play to start:', err.message);
          isPlaying = false;
          updatePlayButton();
        });
      }
    } else {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      isPlaying = false;
      updatePlayButton();
    }
  }

  // Track which section header index owns each lyrics line
  var lineSectionOwner = [];
  var lastActiveSectionIndex = -1;

  function showLyrics(track) {
    if (!lyricsPanel) return;
    lyricsPanel.classList.add('active');
    if (currentAlbum) lyricsPanel.setAttribute('data-album', currentAlbum.id);
    var body = document.querySelector('.album-detail-body');
    if (body) body.classList.add('has-lyrics');
    if (syncActive) lyricsPanel.classList.add('sync-active');
    document.getElementById('lyrics-title').textContent = track.title;

    var lyricsContent = document.getElementById('lyrics-content');
    var rawLines = track.lyrics.split('\n');

    lyricsLines = [];
    lineSectionOwner = [];
    lastHighlightIndex = -1;
    lastActiveSectionIndex = -1;
    lyricsContent.innerHTML = '';

    var contentIdx = 0;
    var currentSectionIdx = -1;

    rawLines.forEach(function(line) {
      var div = document.createElement('div');
      var isSection = /^\[.*\]$/.test(line);
      var isEmpty = line.trim() === '';
      var lineIdx = lyricsLines.length;

      if (isSection) {
        currentSectionIdx = lineIdx;
        div.className = 'lyrics-line lyrics-line-section';
        div.textContent = line.replace(/[\[\]]/g, '');
        lyricsLines.push({ el: div, isContent: false });
        lineSectionOwner[lineIdx] = -1; // sections own themselves
      } else if (isEmpty) {
        div.className = 'lyrics-line lyrics-line-blank';
        div.innerHTML = '&nbsp;';
        lyricsLines.push({ el: div, isContent: false });
        lineSectionOwner[lineIdx] = currentSectionIdx;
      } else {
        div.className = 'lyrics-line';
        div.textContent = line;
        lyricsLines.push({ el: div, isContent: true });
        lineSectionOwner[lineIdx] = currentSectionIdx;
        contentIdx++;
      }
      lyricsContent.appendChild(div);
    });

    // Show/hide sync toggle based on reference data availability
    var syncToggle = document.getElementById('sync-toggle');
    if (syncToggle) {
      var hasRef = window.syncReference && currentAlbum &&
        window.syncReference[currentAlbum.id] &&
        window.syncReference[currentAlbum.id][track.title];
      syncToggle.style.display = hasRef ? 'inline-block' : 'none';
    }

    // Re-apply sync overlay if active
    if (syncActive) {
      applySyncOverlay();
    }
  }

  function getTimingData() {
    if (!window.lyricsTimings || !currentAlbum || !currentTrack) return null;
    var albumTimings = window.lyricsTimings[currentAlbum.id];
    if (!albumTimings) return null;
    var trackTimings = albumTimings[currentTrack.title];
    if (!trackTimings || !trackTimings.lines || !trackTimings.lines.length) return null;
    return trackTimings.lines;
  }

  function updateLyricsHighlight() {
    if (!lyricsLines.length || !audio.duration) return;

    var contentIndices = [];
    for (var i = 0; i < lyricsLines.length; i++) {
      if (lyricsLines[i].isContent) contentIndices.push(i);
    }
    if (!contentIndices.length) return;

    var timingData = getTimingData();
    var activeIndex;
    var contentPos = 0;
    var t = audio.currentTime;

    if (timingData && timingData.length === contentIndices.length) {
      // Use forced-alignment timing data (line-level)
      for (var ti = timingData.length - 1; ti >= 0; ti--) {
        var lineStart = timingData[ti].start !== undefined ? timingData[ti].start : timingData[ti].time;
        if (t >= lineStart) {
          contentPos = ti;
          break;
        }
      }
      activeIndex = contentIndices[contentPos];
    } else {
      // Fallback: proportional distribution
      var pct = audio.currentTime / audio.duration;
      contentPos = Math.floor(pct * contentIndices.length);
      if (contentPos >= contentIndices.length) contentPos = contentIndices.length - 1;
      activeIndex = contentIndices[contentPos];
    }

    // Skip DOM updates if nothing changed
    if (activeIndex === lastHighlightIndex) return;
    lastHighlightIndex = activeIndex;

    // Find neighboring content lines for near-fade effect
    var prevContentIndex = -1, nextContentIndex = -1;
    for (var j = 0; j < contentIndices.length; j++) {
      if (contentIndices[j] === activeIndex) {
        if (j > 0) prevContentIndex = contentIndices[j - 1];
        if (j < contentIndices.length - 1) nextContentIndex = contentIndices[j + 1];
        break;
      }
    }

    // Apply line classes in a single pass
    for (var k = 0; k < lyricsLines.length; k++) {
      var el = lyricsLines[k].el;
      if (k === activeIndex) {
        el.className = el.className.replace(/ lyrics-line-active| lyrics-line-near| lyrics-line-dim/g, '') + ' lyrics-line-active';
      } else if (k === prevContentIndex || k === nextContentIndex) {
        el.className = el.className.replace(/ lyrics-line-active| lyrics-line-near| lyrics-line-dim/g, '') + ' lyrics-line-near';
      } else {
        el.className = el.className.replace(/ lyrics-line-active| lyrics-line-near| lyrics-line-dim/g, '') + ' lyrics-line-dim';
      }
    }

    // Update active section header effect
    var newSectionIdx = lineSectionOwner[activeIndex] !== undefined ? lineSectionOwner[activeIndex] : -1;
    if (newSectionIdx !== lastActiveSectionIndex) {
      if (lastActiveSectionIndex >= 0 && lyricsLines[lastActiveSectionIndex]) {
        lyricsLines[lastActiveSectionIndex].el.classList.remove('lyrics-section-active');
      }
      if (newSectionIdx >= 0 && lyricsLines[newSectionIdx]) {
        lyricsLines[newSectionIdx].el.classList.add('lyrics-section-active');
      }
      lastActiveSectionIndex = newSectionIdx;
    }

    // Auto-scroll current line within lyrics-content container only
    var lc = document.getElementById('lyrics-content');
    if (lc) {
      var lineEl = lyricsLines[activeIndex].el;
      var scrollTarget = lineEl.offsetTop - lc.offsetTop - (lc.clientHeight / 2) + (lineEl.offsetHeight / 2);
      lc.scrollTo({ top: scrollTarget, behavior: 'smooth' });
    }
  }

  function hideLyrics() {
    if (lyricsPanel) {
      lyricsPanel.classList.remove('active');
      lyricsPanel.classList.remove('sync-active');
      lyricsPanel.removeAttribute('data-album');
    }
    var body = document.querySelector('.album-detail-body');
    if (body) body.classList.remove('has-lyrics');
    clearSyncOverlay();
    lyricsLines = [];
    lineSectionOwner = [];
    lastHighlightIndex = -1;
    lastActiveSectionIndex = -1;
  }

  function formatTime(seconds) {
    if (isNaN(seconds) || !isFinite(seconds)) return '0:00';
    var m = Math.floor(seconds / 60);
    var s = Math.floor(seconds % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function updatePlayButton() {
    var btn = document.getElementById('play-btn');
    if (!btn) return;
    if (isPlaying) {
      btn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" fill="white"/><rect x="14" y="4" width="4" height="16" fill="white"/></svg>';
    } else {
      btn.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="5,3 19,12 5,21" fill="white"/></svg>';
    }
  }

  function togglePlay() {
    if (!currentTrack || !currentTrack.url) return;

    if (isPlaying) {
      audio.pause();
      // pause event listener will set isPlaying = false
    } else {
      if (!audio.src || audio.ended) {
        audio.src = getActiveUrl(currentTrack, currentAlbum.id, currentTrackIndex);
        audio.load();
      }
      var playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.then(function() {
          // play event listener will set isPlaying = true
        }).catch(function(err) {
          console.log('Play failed:', err.message);
          isPlaying = false;
          updatePlayButton();
        });
      }
    }
  }

  function playPrev() {
    if (!currentAlbum || currentTrackIndex <= 0) return;
    selectTrack(currentTrackIndex - 1);
  }

  function playNext() {
    if (!currentAlbum) return;
    if (currentTrackIndex < currentAlbum.tracks.length - 1) {
      selectTrack(currentTrackIndex + 1);
    }
  }

  function setupPlayerControls() {
    var controlBtns = document.querySelectorAll('.player-controls .player-btn');
    if (controlBtns[0]) controlBtns[0].onclick = playPrev;
    if (controlBtns[1]) controlBtns[1].onclick = playNext;

    var progressBar = document.querySelector('.player-progress');
    if (progressBar) {
      progressBar.style.cursor = 'pointer';
      progressBar.addEventListener('click', function(e) {
        if (!audio.duration || !currentTrack || !currentTrack.url) return;
        var rect = progressBar.getBoundingClientRect();
        var pct = (e.clientX - rect.left) / rect.width;
        audio.currentTime = pct * audio.duration;
      });
    }

    var volumeSlider = document.querySelector('.player-volume-slider');
    var volumeFill = document.querySelector('.player-volume-fill');
    if (volumeSlider) {
      volumeSlider.style.cursor = 'pointer';
      if (volumeFill) volumeFill.style.width = (audio.volume * 100) + '%';
      volumeSlider.addEventListener('click', function(e) {
        var rect = volumeSlider.getBoundingClientRect();
        var pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        audio.volume = pct;
        if (volumeFill) volumeFill.style.width = (pct * 100) + '%';
      });
    }

    var volumeBtn = document.querySelector('.player-volume .player-btn');
    var savedVolume = 1;
    if (volumeBtn) {
      volumeBtn.addEventListener('click', function() {
        if (audio.volume > 0) {
          savedVolume = audio.volume;
          audio.volume = 0;
          if (volumeFill) volumeFill.style.width = '0%';
        } else {
          audio.volume = savedVolume;
          if (volumeFill) volumeFill.style.width = (savedVolume * 100) + '%';
        }
      });
    }

    // Audio events — single source of truth for play state
    audio.addEventListener('playing', function() {
      isPlaying = true;
      updatePlayButton();
    });

    audio.addEventListener('pause', function() {
      isPlaying = false;
      updatePlayButton();
    });

    audio.addEventListener('timeupdate', function() {
      var times = document.querySelectorAll('.player-time');
      var fill = document.querySelector('.player-progress-fill');
      if (times.length >= 2) {
        times[0].textContent = formatTime(audio.currentTime);
        if (audio.duration) times[1].textContent = formatTime(audio.duration);
      }
      if (fill && audio.duration) {
        fill.style.width = (audio.currentTime / audio.duration * 100) + '%';
      }
      updateLyricsHighlight();
    });

    audio.addEventListener('ended', function() {
      isPlaying = false;
      updatePlayButton();
      playNext();
    });

    audio.addEventListener('error', function(e) {
      console.log('Audio error:', audio.error);
      isPlaying = false;
      updatePlayButton();
    });

    document.addEventListener('keydown', function(e) {
      if (e.code === 'Space' && e.target === document.body) {
        e.preventDefault();
        togglePlay();
      }
    });
  }

  function setupNavigation() {
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        if (currentView === 'album') {
          showGrid();
        }
      }
    });
  }

  // ===== SYNC VISUALIZATION =====

  function toggleSync() {
    syncActive = !syncActive;
    var btn = document.getElementById('sync-toggle');
    if (btn) btn.classList.toggle('active', syncActive);
    if (lyricsPanel) lyricsPanel.classList.toggle('sync-active', syncActive);

    if (syncActive) {
      applySyncOverlay();
    } else {
      clearSyncOverlay();
    }
  }

  function applySyncOverlay() {
    if (!currentAlbum || !currentTrack || !window.SyncAnalysis) {
      showSyncNoData();
      return;
    }

    var analysis = window.SyncAnalysis.getTrackAnalysis(currentAlbum.id, currentTrack.title);
    currentAnalysis = analysis;

    if (!analysis) {
      showSyncNoData();
      return;
    }

    hideSyncNoData();

    // Update metrics bar
    var metricsEl = document.getElementById('sync-metrics');
    var driftEl = document.getElementById('sync-drift-timeline');
    var legendEl = document.getElementById('sync-legend');
    if (metricsEl) metricsEl.classList.add('visible');
    if (driftEl) driftEl.classList.add('visible');
    if (legendEl) legendEl.classList.add('visible');

    document.getElementById('sync-pcetw').textContent = analysis.summary.pcetw;
    document.getElementById('sync-aae').textContent = analysis.summary.aae;
    document.getElementById('sync-misaligned').textContent = analysis.summary.misalignedCount;

    // Tier distribution bar
    var tierBar = document.getElementById('sync-tier-bar');
    if (tierBar) {
      var tc = analysis.summary.tierCounts;
      var total = analysis.summary.totalLines;
      tierBar.innerHTML = '';
      var tiers = ['perfect', 'good', 'drifting', 'misaligned'];
      for (var t = 0; t < tiers.length; t++) {
        var count = tc[tiers[t]] || 0;
        if (count > 0) {
          var seg = document.createElement('div');
          seg.className = 'sync-tier-segment';
          seg.style.width = (count / total * 100) + '%';
          seg.style.background = window.SyncAnalysis.getTierColor(tiers[t]);
          tierBar.appendChild(seg);
        }
      }
    }

    // Apply per-line sync indicators
    var contentIdx = 0;
    for (var i = 0; i < lyricsLines.length; i++) {
      if (lyricsLines[i].isContent && contentIdx < analysis.lines.length) {
        var lineData = analysis.lines[contentIdx];
        lyricsLines[i].el.setAttribute('data-sync-tier', lineData.tier);
        lyricsLines[i].el.setAttribute('data-sync-index', contentIdx);
        contentIdx++;
      }
    }

    // Render drift timeline
    renderDriftTimeline(analysis);

    // Setup hover tooltips
    setupSyncTooltips(analysis);
  }

  function clearSyncOverlay() {
    currentAnalysis = null;

    var metricsEl = document.getElementById('sync-metrics');
    var driftEl = document.getElementById('sync-drift-timeline');
    var legendEl = document.getElementById('sync-legend');
    var noDataEl = document.getElementById('sync-no-data');
    if (metricsEl) metricsEl.classList.remove('visible');
    if (driftEl) driftEl.classList.remove('visible');
    if (legendEl) legendEl.classList.remove('visible');
    if (noDataEl) noDataEl.classList.remove('visible');

    // Clear per-line indicators
    for (var i = 0; i < lyricsLines.length; i++) {
      lyricsLines[i].el.removeAttribute('data-sync-tier');
      lyricsLines[i].el.removeAttribute('data-sync-index');
    }

    // Clear drift bars
    var driftTimeline = document.getElementById('sync-drift-timeline');
    if (driftTimeline) {
      var bars = driftTimeline.querySelectorAll('.sync-drift-bar');
      for (var b = 0; b < bars.length; b++) bars[b].remove();
    }

    // Hide tooltip
    var tooltip = document.getElementById('sync-tooltip');
    if (tooltip) tooltip.classList.remove('visible');

    // Remove hover listeners
    removeSyncTooltips();
  }

  function showSyncNoData() {
    var noDataEl = document.getElementById('sync-no-data');
    if (noDataEl) noDataEl.classList.add('visible');
    var metricsEl = document.getElementById('sync-metrics');
    var driftEl = document.getElementById('sync-drift-timeline');
    var legendEl = document.getElementById('sync-legend');
    if (metricsEl) metricsEl.classList.remove('visible');
    if (driftEl) driftEl.classList.remove('visible');
    if (legendEl) legendEl.classList.remove('visible');
  }

  function hideSyncNoData() {
    var noDataEl = document.getElementById('sync-no-data');
    if (noDataEl) noDataEl.classList.remove('visible');
  }

  function renderDriftTimeline(analysis) {
    var container = document.getElementById('sync-drift-timeline');
    if (!container || !analysis.lines.length) return;

    // Remove existing bars
    var existing = container.querySelectorAll('.sync-drift-bar');
    for (var e = 0; e < existing.length; e++) existing[e].remove();

    // Find the total song duration for positioning
    var lastLine = analysis.lines[analysis.lines.length - 1];
    var songDuration = lastLine.referenceEnd || lastLine.referenceTime + 10;

    // Max error for scaling (cap at 800ms for visual clarity)
    var maxError = 800;
    var timelineHeight = container.offsetHeight || 40;
    var halfHeight = timelineHeight / 2;

    for (var i = 0; i < analysis.lines.length; i++) {
      var line = analysis.lines[i];
      var bar = document.createElement('div');
      bar.className = 'sync-drift-bar';

      // Horizontal position: proportional to song timeline
      var xPct = (line.referenceTime / songDuration) * 100;
      bar.style.left = xPct + '%';

      // Vertical: height proportional to error, direction determines above/below
      var errorClamped = Math.min(line.errorMs, maxError);
      var barHeight = Math.max(2, (errorClamped / maxError) * halfHeight);

      if (line.direction === 'late' || line.direction === 'exact') {
        bar.style.top = halfHeight + 'px';
        bar.style.height = barHeight + 'px';
      } else {
        bar.style.top = (halfHeight - barHeight) + 'px';
        bar.style.height = barHeight + 'px';
      }

      bar.style.background = line.color;
      bar.style.opacity = '0.7';
      bar.title = 'Line ' + (i + 1) + ': ' + window.SyncAnalysis.formatError(line.signedMs);
      container.appendChild(bar);
    }
  }

  // Tooltip management
  var syncTooltipHandlers = [];

  function setupSyncTooltips(analysis) {
    removeSyncTooltips();

    var tooltip = document.getElementById('sync-tooltip');
    if (!tooltip) return;

    for (var i = 0; i < lyricsLines.length; i++) {
      if (!lyricsLines[i].isContent) continue;
      var idx = lyricsLines[i].el.getAttribute('data-sync-index');
      if (idx === null) continue;

      (function(el, lineIdx) {
        var lineData = analysis.lines[parseInt(lineIdx)];
        if (!lineData) return;

        var enterHandler = function(e) {
          if (!syncActive) return;
          document.getElementById('sync-tooltip-title').textContent = 'Line ' + (lineData.line + 1) + ' of ' + analysis.summary.totalLines;
          document.getElementById('sync-tooltip-offset').textContent = window.SyncAnalysis.formatError(lineData.signedMs);
          document.getElementById('sync-tooltip-offset').style.color = lineData.color;
          document.getElementById('sync-tooltip-expected').textContent = window.SyncAnalysis.formatTimePrecise(lineData.estimatedTime);
          document.getElementById('sync-tooltip-actual').textContent = window.SyncAnalysis.formatTimePrecise(lineData.referenceTime);
          document.getElementById('sync-tooltip-confidence').textContent = lineData.confidence ? lineData.confidence.toFixed(2) : '—';

          tooltip.classList.add('visible');
          positionTooltip(e);
        };

        var moveHandler = function(e) {
          if (!syncActive) return;
          positionTooltip(e);
        };

        var leaveHandler = function() {
          tooltip.classList.remove('visible');
        };

        el.addEventListener('mouseenter', enterHandler);
        el.addEventListener('mousemove', moveHandler);
        el.addEventListener('mouseleave', leaveHandler);

        syncTooltipHandlers.push({ el: el, enter: enterHandler, move: moveHandler, leave: leaveHandler });
      })(lyricsLines[i].el, idx);
    }
  }

  function removeSyncTooltips() {
    for (var i = 0; i < syncTooltipHandlers.length; i++) {
      var h = syncTooltipHandlers[i];
      h.el.removeEventListener('mouseenter', h.enter);
      h.el.removeEventListener('mousemove', h.move);
      h.el.removeEventListener('mouseleave', h.leave);
    }
    syncTooltipHandlers = [];
  }

  function positionTooltip(e) {
    var tooltip = document.getElementById('sync-tooltip');
    if (!tooltip) return;
    var x = e.clientX + 12;
    var y = e.clientY - 10;
    // Keep within viewport
    var rect = tooltip.getBoundingClientRect();
    if (x + rect.width > window.innerWidth - 10) x = e.clientX - rect.width - 12;
    if (y + rect.height > window.innerHeight - 10) y = e.clientY - rect.height - 10;
    if (y < 10) y = 10;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }

  function toggleVariant(albumId, trackIndex) {
    var current = variantSelections[albumId][trackIndex] || 'A';
    variantSelections[albumId][trackIndex] = current === 'A' ? 'B' : 'A';
    saveVariantSelections();

    // Update the toggle UI
    var trackEl = document.querySelector('.track-item[data-track-index="' + trackIndex + '"]');
    if (trackEl) {
      var toggle = trackEl.querySelector('.variant-toggle');
      if (toggle) {
        var opts = toggle.querySelectorAll('.variant-opt');
        var newVariant = variantSelections[albumId][trackIndex];
        opts[0].className = 'variant-opt' + (newVariant === 'A' ? ' variant-active' : '');
        opts[1].className = 'variant-opt' + (newVariant === 'B' ? ' variant-active' : '');
      }
    }

    // If this is the currently playing track, swap the audio source
    if (currentAlbum && currentAlbum.id === albumId && currentTrackIndex === trackIndex && currentTrack) {
      var wasPlaying = isPlaying;
      var savedTime = audio.currentTime;
      audio.src = getActiveUrl(currentTrack, albumId, trackIndex);
      audio.load();
      audio.addEventListener('loadedmetadata', function onMeta() {
        audio.removeEventListener('loadedmetadata', onMeta);
        audio.currentTime = savedTime;
        if (wasPlaying) {
          var p = audio.play();
          if (p) p.catch(function() {});
        }
      });
    }
  }

  function showVariantReport(album) {
    var report = {
      album: album.id,
      title: album.title,
      tracks: {}
    };
    album.tracks.forEach(function(track, i) {
      if (track.url) {
        report.tracks[track.title] = variantSelections[album.id][i] || 'A';
      }
    });

    // Create modal
    var existing = document.getElementById('variant-report-modal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'variant-report-modal';
    modal.className = 'variant-report-modal';
    modal.innerHTML =
      '<div class="variant-report-content">' +
        '<div class="variant-report-header">' +
          '<span>Variant Selection Report</span>' +
          '<button class="variant-report-close" onclick="WOT.closeReport()">&times;</button>' +
        '</div>' +
        '<div class="variant-report-desc">Copy this JSON and set <code>variant: "B"</code> on tracks in albums.js to make B the default.</div>' +
        '<pre class="variant-report-json">' + JSON.stringify(report, null, 2) + '</pre>' +
        '<button class="variant-report-copy" onclick="WOT.copyReport()">Copy to Clipboard</button>' +
      '</div>';
    modal.addEventListener('click', function(e) {
      if (e.target === modal) closeReport();
    });
    document.body.appendChild(modal);
  }

  function closeReport() {
    var modal = document.getElementById('variant-report-modal');
    if (modal) modal.remove();
  }

  function copyReport() {
    var pre = document.querySelector('.variant-report-json');
    if (pre) {
      navigator.clipboard.writeText(pre.textContent).then(function() {
        var btn = document.querySelector('.variant-report-copy');
        if (btn) {
          btn.textContent = 'Copied!';
          setTimeout(function() { btn.textContent = 'Copy to Clipboard'; }, 2000);
        }
      });
    }
  }

  window.WOT = {
    openAlbum: showAlbum,
    goHome: showGrid,
    selectTrack: selectTrack,
    hideLyrics: hideLyrics,
    togglePlay: togglePlay,
    toggleSync: toggleSync,
    toggleVariant: toggleVariant,
    closeReport: closeReport,
    copyReport: copyReport
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
