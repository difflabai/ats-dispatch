#!/usr/bin/env node

/**
 * pipeline — CLI for variant evaluation using GitHub-native UX.
 *
 * Commands:
 *   pipeline test <id>                          Label variant PRs for evaluation
 *   pipeline advance <id> [--from <pr>] [--auto] Pick a winner and advance
 *   pipeline status [id]                         Show project/variant status
 *
 * This variant (Variant 2) uses GitHub PRs, labels, and reactions as the
 * selection interface — no new pipeline-specific commands for picking.
 * Selection happens where humans already review code: on GitHub.
 */

const command = process.argv[2];
const args = process.argv.slice(3);

function usage() {
  console.log(`
pipeline — GitHub-native variant selection

Commands:
  test <id>                          Label variant PRs for evaluation
  advance <id> [--from <pr>] [--auto] Detect winner and advance the pipeline
  status [id]                         Show pipeline status (live PR data)

Workflow:
  1. Create variants with PRs (manually or via your generation tool)
  2. Run \`pipeline test <id>\` to label PRs for evaluation
  3. On GitHub, apply \`pipeline:winner\` label or 👍-react on the best PR
  4. Run \`pipeline advance <id>\` to auto-detect the winner and close losers
  5. Run \`pipeline status <id>\` to see live PR states at any time

Flags:
  --from <pr>   Explicitly specify winner PR number (skips auto-detection)
  --auto        Auto-detect winner without confirmation prompt
`.trim());
}

async function main() {
  switch (command) {
    case 'test': {
      const { run } = await import('../src/commands/test.js');
      run(args);
      break;
    }
    case 'advance': {
      const { run } = await import('../src/commands/advance.js');
      run(args);
      break;
    }
    case 'status': {
      const { run } = await import('../src/commands/status.js');
      run(args);
      break;
    }
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      usage();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

main();
