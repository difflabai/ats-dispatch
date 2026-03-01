// Lyric Sync Analysis Engine
// Compares estimated vs reference timings and computes quality metrics
(function() {
  'use strict';

  // Quality tiers based on MIREX tolerance thresholds
  var TIERS = {
    perfect:    { max: 100,  color: '#4CAF50', label: 'Perfect' },
    good:       { max: 300,  color: '#8BC34A', label: 'Good' },
    drifting:   { max: 500,  color: '#FF9800', label: 'Drifting' },
    misaligned: { max: Infinity, color: '#F44336', label: 'Misaligned' }
  };

  function getTier(errorMs) {
    if (errorMs < TIERS.perfect.max) return 'perfect';
    if (errorMs < TIERS.good.max) return 'good';
    if (errorMs < TIERS.drifting.max) return 'drifting';
    return 'misaligned';
  }

  function getTierColor(tier) {
    return TIERS[tier] ? TIERS[tier].color : TIERS.misaligned.color;
  }

  function getTierLabel(tier) {
    return TIERS[tier] ? TIERS[tier].label : 'Unknown';
  }

  // Main analysis function
  // estimated: [{time, endTime, text}, ...]
  // reference: [{time, endTime, text, confidence?}, ...]
  function analyzeSyncQuality(estimated, reference) {
    if (!estimated || !reference || estimated.length === 0) {
      return null;
    }

    var len = Math.min(estimated.length, reference.length);
    var lines = [];

    for (var i = 0; i < len; i++) {
      var est = estimated[i];
      var ref = reference[i];
      var errorMs = Math.abs(est.time - ref.time) * 1000;
      var direction = est.time < ref.time ? 'early' : (est.time > ref.time ? 'late' : 'exact');
      var signedMs = Math.round((est.time - ref.time) * 1000);
      var tier = getTier(errorMs);

      lines.push({
        line: i,
        text: est.text,
        estimatedTime: est.time,
        referenceTime: ref.time,
        estimatedEnd: est.endTime,
        referenceEnd: ref.endTime,
        errorMs: Math.round(errorMs),
        signedMs: signedMs,
        direction: direction,
        tier: tier,
        color: getTierColor(tier),
        confidence: ref.confidence || null
      });
    }

    // Summary metrics
    var inSync = 0;
    var totalError = 0;
    var misaligned = 0;
    var tierCounts = { perfect: 0, good: 0, drifting: 0, misaligned: 0 };

    for (var j = 0; j < lines.length; j++) {
      totalError += lines[j].errorMs;
      tierCounts[lines[j].tier]++;
      if (lines[j].errorMs < 300) inSync++;
      if (lines[j].errorMs >= 500) misaligned++;
    }

    var avgDrift = lines.length > 0 ? Math.round(totalError / lines.length) : 0;
    var pcetw = lines.length > 0 ? (inSync / lines.length * 100) : 0;

    return {
      lines: lines,
      summary: {
        pcetw: parseFloat(pcetw.toFixed(1)),
        aae: avgDrift,
        misalignedCount: misaligned,
        totalLines: lines.length,
        tierCounts: tierCounts
      },
      tiers: TIERS
    };
  }

  // Get analysis for a specific album/track
  function getTrackAnalysis(albumId, trackTitle) {
    if (!window.lyricsTimings || !window.syncReference) return null;

    var albumTimings = window.lyricsTimings[albumId];
    var albumRef = window.syncReference[albumId];
    if (!albumTimings || !albumRef) return null;

    var trackTimings = albumTimings[trackTitle];
    var trackRef = albumRef[trackTitle];
    if (!trackTimings || !trackRef) return null;

    var estimated = trackTimings.lines;
    var reference = trackRef.lines;
    if (!estimated || !reference) return null;

    return analyzeSyncQuality(estimated, reference);
  }

  // Format error for display
  function formatError(signedMs) {
    var abs = Math.abs(signedMs);
    if (abs === 0) return 'Exact';
    var prefix = signedMs > 0 ? '+' : '-';
    var dir = signedMs > 0 ? 'late' : 'early';
    return prefix + abs + 'ms (' + dir + ')';
  }

  // Format time as mm:ss.cc
  function formatTimePrecise(seconds) {
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  }

  // Expose API
  window.SyncAnalysis = {
    analyze: analyzeSyncQuality,
    getTrackAnalysis: getTrackAnalysis,
    getTier: getTier,
    getTierColor: getTierColor,
    getTierLabel: getTierLabel,
    formatError: formatError,
    formatTimePrecise: formatTimePrecise,
    TIERS: TIERS
  };
})();
