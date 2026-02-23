/**
 * pipeline status [id] — Show pipeline status with live PR data from GitHub.
 *
 * Without arguments: list all projects.
 * With project ID: show detailed status including live PR state,
 * labels, and winner detection.
 */

import { getProject, listProjects } from '../pipeline-state.js';
import { getPrStatus, getPrLabels, countThumbsUp } from '../github.js';

// ANSI color helpers
const color = {
  green: s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  gray: s => `\x1b[90m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
};

function formatPrState(state) {
  switch (state) {
    case 'OPEN': return color.yellow(state);
    case 'MERGED': return color.green(state);
    case 'CLOSED': return color.gray(state);
    default: return state;
  }
}

function formatVariantStatus(status) {
  switch (status) {
    case 'picked': return color.green('PICKED');
    case 'closed': return color.gray('CLOSED');
    case 'open': return color.yellow('OPEN');
    default: return status || 'unknown';
  }
}

export function run(args) {
  const id = args[0];

  if (!id) {
    // List all projects
    const projects = listProjects();
    if (projects.length === 0) {
      console.log('No pipeline projects found.');
      console.log('Create a project by adding it to .pipeline/state.json.');
      return;
    }

    console.log(color.bold('Pipeline Projects\n'));
    for (const p of projects) {
      const variantCount = (p.variants || []).length;
      const activeCount = (p.variants || []).filter(v => v.status !== 'closed').length;
      console.log(`  ${color.cyan(p.id)} — ${p.name || '(unnamed)'}`);
      console.log(`    Status: ${p.status || 'idle'}  |  Round: ${p.round || 0}  |  Variants: ${activeCount}/${variantCount} active`);
    }
    return;
  }

  // Detailed project status
  const project = getProject(id);
  if (!project) {
    console.error(`Project not found: ${id}`);
    process.exit(1);
  }

  console.log(color.bold(`\nProject: ${project.name || id}`));
  console.log(`  ID:     ${project.id}`);
  console.log(`  Status: ${project.status || 'idle'}`);
  console.log(`  Round:  ${project.round || 0}`);

  const variants = project.variants || [];
  if (variants.length === 0) {
    console.log('\n  No variants.\n');
    return;
  }

  console.log(color.bold('\n  Variants:\n'));

  for (const v of variants) {
    const localStatus = formatVariantStatus(v.status);
    console.log(`  ${color.cyan(v.branch)}`);
    console.log(`    Local status: ${localStatus}`);

    if (v.pr_number) {
      try {
        const prState = getPrStatus(v.pr_number);
        const labels = getPrLabels(v.pr_number);
        const thumbs = countThumbsUp(v.pr_number);

        const isWinner = labels.includes('pipeline:winner');
        const isPicked = labels.includes('pipeline:picked');
        const isEvaluating = labels.includes('pipeline:evaluating');

        console.log(`    PR #${v.pr_number}: ${formatPrState(prState)}`);

        const labelTags = [];
        if (isWinner) labelTags.push(color.green('pipeline:winner'));
        if (isPicked) labelTags.push(color.green('pipeline:picked'));
        if (isEvaluating) labelTags.push(color.yellow('pipeline:evaluating'));
        if (labelTags.length) {
          console.log(`    Labels: ${labelTags.join(', ')}`);
        }

        if (thumbs > 0) {
          console.log(`    Reactions: ${thumbs} 👍`);
        }
      } catch {
        console.log(`    PR #${v.pr_number}: ${color.gray('(unable to fetch)')}`);
      }
    } else {
      console.log(`    ${color.gray('No PR')}`);
    }
    console.log();
  }
}
