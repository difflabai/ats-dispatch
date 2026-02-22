/**
 * pipeline advance <id> [--from <pr>] [--auto] — Advance the pipeline by picking a winner.
 *
 * Winner detection (when --from is NOT provided):
 *   1. Check for `pipeline:winner` label — immediate pick
 *   2. Count 👍 reactions — highest wins (tiebreaker: most recent PR number)
 *   3. If no signal, prompt user
 *
 * After picking:
 *   - Close all other variant PRs with explanatory comment
 *   - Remove `pipeline:evaluating` labels
 *   - Add `pipeline:picked` label to winner PR
 */

import { getProject, setProject } from '../pipeline-state.js';
import {
  getPrLabels,
  countThumbsUp,
  closePr,
  removePrLabel,
  addPrLabel,
} from '../github.js';

/**
 * Detect winner from GitHub signals across variant PRs.
 * @param {Array<{branch: string, pr_number: number, status: string}>} variants
 * @returns {{ winner: object|null, candidates: object[] }}
 */
function detectWinner(variants) {
  const activePrs = variants.filter(v => v.pr_number && v.status !== 'closed');

  // Pass 1: Check for explicit `pipeline:winner` label
  const labeledWinners = [];
  for (const v of activePrs) {
    const labels = getPrLabels(v.pr_number);
    if (labels.includes('pipeline:winner')) {
      labeledWinners.push(v);
    }
  }

  if (labeledWinners.length === 1) {
    return { winner: labeledWinners[0], candidates: labeledWinners };
  }
  if (labeledWinners.length > 1) {
    return { winner: null, candidates: labeledWinners };
  }

  // Pass 2: Count 👍 reactions
  const scored = activePrs.map(v => ({
    ...v,
    thumbsUp: countThumbsUp(v.pr_number),
  }));

  const maxThumbs = Math.max(...scored.map(s => s.thumbsUp));
  if (maxThumbs > 0) {
    const topScored = scored.filter(s => s.thumbsUp === maxThumbs);
    if (topScored.length === 1) {
      return { winner: topScored[0], candidates: topScored };
    }
    // Tiebreaker: highest PR number (most recent)
    topScored.sort((a, b) => b.pr_number - a.pr_number);
    return { winner: topScored[0], candidates: topScored };
  }

  return { winner: null, candidates: [] };
}

export function run(args) {
  const id = args[0];
  if (!id) {
    console.error('Usage: pipeline advance <project-id> [--from <pr-number>] [--auto]');
    process.exit(1);
  }

  const project = getProject(id);
  if (!project) {
    console.error(`Project not found: ${id}`);
    process.exit(1);
  }

  const variants = (project.variants || []).filter(v => v.pr_number && v.status !== 'closed');
  if (variants.length === 0) {
    console.error(`No active variant PRs for project "${id}".`);
    process.exit(1);
  }

  // Parse flags
  const fromIdx = args.indexOf('--from');
  const fromPr = fromIdx !== -1 ? parseInt(args[fromIdx + 1], 10) : null;
  const auto = args.includes('--auto');

  let winner;

  if (fromPr) {
    // Explicit selection
    winner = variants.find(v => v.pr_number === fromPr);
    if (!winner) {
      console.error(`PR #${fromPr} is not an active variant for project "${id}".`);
      console.error('Active variants:', variants.map(v => `#${v.pr_number} (${v.branch})`).join(', '));
      process.exit(1);
    }
  } else {
    // Auto-detect from GitHub signals
    console.log('Detecting winner from GitHub signals...\n');
    const detection = detectWinner(variants);

    if (detection.winner) {
      winner = detection.winner;
      console.log(`Winner detected: PR #${winner.pr_number} (${winner.branch})`);
      if (detection.candidates.length > 1) {
        console.log(`  (resolved tiebreak among ${detection.candidates.length} candidates)`);
      }
    } else if (detection.candidates.length > 1) {
      console.error('Multiple PRs have the `pipeline:winner` label:');
      for (const c of detection.candidates) {
        console.error(`  PR #${c.pr_number} (${c.branch})`);
      }
      console.error('\nRemove the label from all but one, or use --from <pr-number>.');
      process.exit(1);
    } else {
      console.error('No winner detected.');
      console.error('Label a PR with `pipeline:winner` or add 👍 reactions, or use --from <pr-number>.');
      process.exit(1);
    }
  }

  // Confirm in non-auto mode
  if (!auto && !fromPr) {
    console.log(`\nWill pick PR #${winner.pr_number} (${winner.branch}) as the winner.`);
    console.log('Use --auto to skip this confirmation, or --from to override.\n');
  }

  // Apply winner
  console.log(`\nAdvancing project "${project.name || id}"...`);
  console.log(`  Winner: PR #${winner.pr_number} (${winner.branch})\n`);

  // Label the winner
  try {
    addPrLabel(winner.pr_number, 'pipeline:picked');
    removePrLabel(winner.pr_number, 'pipeline:evaluating');
    console.log(`  PR #${winner.pr_number} — labeled pipeline:picked`);
  } catch (err) {
    console.error(`  PR #${winner.pr_number} — label failed: ${err.message}`);
  }

  // Close losers
  const losers = variants.filter(v => v.pr_number !== winner.pr_number);
  for (const loser of losers) {
    try {
      closePr(
        loser.pr_number,
        `Closed: variant ${winner.branch} (PR #${winner.pr_number}) was selected as the winner for this round.`
      );
      removePrLabel(loser.pr_number, 'pipeline:evaluating');
      console.log(`  PR #${loser.pr_number} (${loser.branch}) — closed`);
    } catch (err) {
      console.error(`  PR #${loser.pr_number} (${loser.branch}) — close failed: ${err.message}`);
    }
  }

  // Update state
  for (const v of project.variants) {
    if (v.pr_number === winner.pr_number) {
      v.status = 'picked';
    } else if (losers.some(l => l.pr_number === v.pr_number)) {
      v.status = 'closed';
    }
  }
  project.status = 'advanced';
  project.round = (project.round || 0) + 1;
  setProject(project);

  console.log(`\nProject "${project.name || id}" advanced to round ${project.round}.`);
}
