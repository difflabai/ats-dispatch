/**
 * pipeline test <id> — Label variant PRs for evaluation.
 *
 * After generating/sending the test plan, this command:
 * - Adds `pipeline:variant` and `pipeline:evaluating` labels to all active variant PRs
 * - Posts evaluation instructions as a comment on each PR
 * - Prints instructions for the human reviewer
 */

import { getProject, setProject } from '../pipeline-state.js';
import { addPrLabel, addPrComment } from '../github.js';

const EVALUATION_COMMENT = [
  '## Pipeline Evaluation',
  '',
  'This variant is being evaluated.',
  '',
  'To select this as the winner:',
  '- **Option A:** Apply the label `pipeline:winner` to this PR',
  '- **Option B:** Add a :+1: reaction to this PR (highest count wins)',
  '',
  'Then run `pipeline advance` to advance the pipeline.',
].join('\n');

export function run(args) {
  const id = args[0];
  if (!id) {
    console.error('Usage: pipeline test <project-id>');
    process.exit(1);
  }

  const project = getProject(id);
  if (!project) {
    console.error(`Project not found: ${id}`);
    console.error('Run `pipeline status` to see available projects.');
    process.exit(1);
  }

  const variants = (project.variants || []).filter(v => v.pr_number && v.status !== 'closed');
  if (variants.length === 0) {
    console.error(`No active variant PRs for project "${id}".`);
    console.error('Ensure variants have been created with PR numbers before running test.');
    process.exit(1);
  }

  console.log(`Labeling ${variants.length} variant PR(s) for project "${project.name || id}"...\n`);

  let labeled = 0;
  for (const variant of variants) {
    const pr = variant.pr_number;
    try {
      addPrLabel(pr, 'pipeline:variant');
      addPrLabel(pr, 'pipeline:evaluating');
      addPrComment(pr, EVALUATION_COMMENT);
      console.log(`  PR #${pr} (${variant.branch}) — labeled and commented`);
      labeled++;
    } catch (err) {
      console.error(`  PR #${pr} (${variant.branch}) — FAILED: ${err.message}`);
    }
  }

  if (labeled === 0) {
    console.error('\nAll GitHub operations failed — project status unchanged.');
    process.exit(1);
  }

  // Update project status
  project.status = 'evaluating';
  setProject(project);

  console.log('\n----');
  console.log('Label a PR with `pipeline:winner` or add 👍 to pick it, then run `pipeline advance`');
}
