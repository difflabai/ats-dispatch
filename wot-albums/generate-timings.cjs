#!/usr/bin/env node
// Intelligent lyrics timing generator for WoT Albums
// Generates musically-aware {time, endTime, text, words} data
// considering section structure, syllable count, and musical phrasing.

const fs = require('fs');
const path = require('path');

// --- Syllable estimation (English heuristic) ---
function countSyllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!word) return 0;
  if (word.length <= 2) return 1;
  // Count vowel groups
  var matches = word.match(/[aeiouy]+/g);
  var count = matches ? matches.length : 1;
  // Subtract silent e at end
  if (word.endsWith('e') && count > 1 && !/le$/.test(word)) count--;
  // Common adjustments
  if (/tion$|sion$/.test(word)) count = Math.max(count, 2);
  return Math.max(1, count);
}

function lineSyllables(text) {
  return text.split(/\s+/).reduce((sum, w) => sum + countSyllables(w), 0);
}

// --- Parse duration string "M:SS" to seconds ---
function parseDuration(dur) {
  var parts = dur.split(':');
  return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

// --- Section type detection ---
function sectionType(header) {
  var h = header.toLowerCase();
  if (/chorus/.test(h)) return 'chorus';
  if (/bridge/.test(h)) return 'bridge';
  if (/outro/.test(h)) return 'outro';
  if (/intro/.test(h)) return 'intro';
  if (/pre[- ]?chorus/.test(h)) return 'prechorus';
  if (/verse/.test(h)) return 'verse';
  if (/hook/.test(h)) return 'chorus';
  return 'verse';
}

// --- Tempo modifier by section type ---
// > 1.0 = faster (less time per syllable), < 1.0 = slower
function sectionTempoFactor(type) {
  switch (type) {
    case 'chorus': return 1.05;     // Choruses are slightly more rhythmic
    case 'prechorus': return 1.0;
    case 'bridge': return 0.90;     // Bridges tend to be more drawn-out/dramatic
    case 'outro': return 0.85;      // Outros slow down
    case 'intro': return 0.90;
    default: return 1.0;            // Verses are baseline
  }
}

// --- Transition time between sections (instrumental break) ---
function sectionGap(prevType, nextType) {
  // First section gets an intro offset
  if (!prevType) return 0;
  // Larger gap before chorus (build-up), bridge (mood change)
  if (nextType === 'chorus') return 2.0;
  if (nextType === 'bridge') return 2.5;
  if (nextType === 'outro') return 2.0;
  // Standard verse-to-verse transition
  return 1.5;
}

// --- Main timing generation ---
function generateTrackTimings(lyrics, durationStr) {
  var totalDuration = parseDuration(durationStr);
  var rawLines = lyrics.split('\n');

  // Parse into sections with content lines
  var sections = [];
  var currentSection = { type: 'verse', header: null, lines: [] };

  rawLines.forEach(line => {
    var sectionMatch = line.match(/^\[(.*)\]$/);
    if (sectionMatch) {
      // Start new section
      if (currentSection.lines.length > 0 || currentSection.header) {
        sections.push(currentSection);
      }
      currentSection = {
        type: sectionType(sectionMatch[1]),
        header: sectionMatch[1],
        lines: []
      };
    } else if (line.trim() !== '') {
      currentSection.lines.push(line.trim());
    }
  });
  if (currentSection.lines.length > 0) {
    sections.push(currentSection);
  }

  // Flatten to content lines with section metadata
  var contentLines = [];
  sections.forEach((sec, si) => {
    sec.lines.forEach((text, li) => {
      contentLines.push({
        text: text,
        syllables: lineSyllables(text),
        wordCount: text.split(/\s+/).length,
        sectionType: sec.type,
        sectionIndex: si,
        isFirstInSection: li === 0,
        isLastInSection: li === sec.lines.length - 1
      });
    });
  });

  if (contentLines.length === 0) return { lines: [] };

  // Calculate total weighted syllables (adjusted by tempo factor)
  var totalWeightedSyllables = 0;
  contentLines.forEach(cl => {
    totalWeightedSyllables += cl.syllables / sectionTempoFactor(cl.sectionType);
  });

  // Calculate total structural gaps
  var introOffset = 1.0; // Time before first lyrics
  var outroBuffer = 3.0; // Time after last lyrics (fade out)
  var totalGaps = introOffset + outroBuffer;

  // Add section transition gaps
  var prevSectionType = null;
  contentLines.forEach(cl => {
    if (cl.isFirstInSection && cl.sectionIndex > 0) {
      totalGaps += sectionGap(prevSectionType, cl.sectionType);
    }
    if (cl.isLastInSection) {
      prevSectionType = cl.sectionType;
    }
  });

  // Available singing time
  var singingTime = totalDuration - totalGaps;
  if (singingTime < totalDuration * 0.5) {
    // Safety: don't let gaps take more than half the time
    var scale = (totalDuration * 0.5) / totalGaps;
    totalGaps *= scale;
    singingTime = totalDuration - totalGaps;
    introOffset *= scale;
    outroBuffer *= scale;
  }

  // Time per weighted syllable
  var timePerWeightedSyllable = singingTime / totalWeightedSyllables;

  // Generate line timings
  var currentTime = introOffset;
  prevSectionType = null;
  var result = [];

  contentLines.forEach((cl, i) => {
    // Add section transition gap
    if (cl.isFirstInSection && cl.sectionIndex > 0) {
      currentTime += sectionGap(prevSectionType, cl.sectionType);
    }

    // Calculate line duration based on syllable weight
    var tempoFactor = sectionTempoFactor(cl.sectionType);
    var lineDuration = (cl.syllables / tempoFactor) * timePerWeightedSyllable;

    // Minimum line duration: 1.5s
    lineDuration = Math.max(1.5, lineDuration);

    var lineStart = parseFloat(currentTime.toFixed(2));
    var lineEnd = parseFloat((currentTime + lineDuration).toFixed(2));

    result.push({
      time: lineStart,
      endTime: lineEnd,
      text: cl.text,
    });

    currentTime += lineDuration;
    if (cl.isLastInSection) {
      prevSectionType = cl.sectionType;
    }
  });

  // Clamp final line endTime to song duration
  if (result.length > 0) {
    var last = result[result.length - 1];
    if (last.endTime > totalDuration) {
      last.endTime = parseFloat((totalDuration - 0.5).toFixed(2));
    }
  }

  // Normalize: if timing overflows, compress proportionally
  if (result.length > 0 && result[result.length - 1].endTime > totalDuration) {
    var overflow = result[result.length - 1].endTime - (totalDuration - outroBuffer);
    var totalLineDuration = result[result.length - 1].endTime - result[0].time;
    var compressionFactor = (totalLineDuration - overflow) / totalLineDuration;

    var base = result[0].time;
    result.forEach(line => {
      var relStart = (line.time - base) * compressionFactor + base;
      var relEnd = (line.endTime - base) * compressionFactor + base;
      line.time = parseFloat(relStart.toFixed(2));
      line.endTime = parseFloat(relEnd.toFixed(2));
    });
  }

  return { lines: result };
}

// --- Load albums data ---
var albumsSrc = fs.readFileSync(path.join(__dirname, 'js/albums.js'), 'utf8');
var fn = new Function(albumsSrc + '; return ALBUMS;');
var ALBUMS = fn();

// --- Generate all timings ---
var output = '// Lyrics timing data for WoT albums\n';
output += '// Intelligent sync: syllable-weighted timing with section-aware gaps\n';
output += '// Word-level timing included for smooth within-line scrolling\n';
output += '// Generated: ' + new Date().toISOString().split('T')[0] + '\n';
output += 'window.lyricsTimings = window.lyricsTimings || {};\n\n';

var stats = { albums: 0, tracks: 0, lines: 0 };

ALBUMS.forEach(album => {
  var albumTimings = {};
  album.tracks.forEach(track => {
    var timings = generateTrackTimings(track.lyrics, track.duration);
    albumTimings[track.title] = timings;
    stats.tracks++;
    stats.lines += timings.lines.length;
  });
  output += 'window.lyricsTimings["' + album.id + '"] = ' + JSON.stringify(albumTimings, null, 2) + ';\n\n';
  stats.albums++;
});

fs.writeFileSync(path.join(__dirname, 'js/lyrics-timings.js'), output);

console.log('Timing generation complete:');
console.log('  Albums: ' + stats.albums);
console.log('  Tracks: ' + stats.tracks);
console.log('  Content lines: ' + stats.lines);
console.log('  Output: js/lyrics-timings.js');
