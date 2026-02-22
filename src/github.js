/**
 * GitHub integration module — wraps `gh` CLI for PR labels, reactions, and status.
 */

import { execSync } from 'node:child_process';

let _ownerRepo = null;

/**
 * Auto-detect owner/repo from git remote origin.
 * Returns "owner/repo" string.
 */
function getOwnerRepo() {
  if (_ownerRepo) return _ownerRepo;
  const url = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
  // Handle SSH: git@github.com:owner/repo.git
  // Handle HTTPS: https://github.com/owner/repo.git
  const sshMatch = url.match(/git@[^:]+:(.+?)(?:\.git)?$/);
  if (sshMatch) {
    _ownerRepo = sshMatch[1];
    return _ownerRepo;
  }
  const httpsMatch = url.match(/github\.com\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    _ownerRepo = httpsMatch[1];
    return _ownerRepo;
  }
  throw new Error(`Cannot parse owner/repo from remote: ${url}`);
}

/**
 * Run a gh CLI command and return trimmed stdout.
 * Throws on non-zero exit.
 */
function gh(args, { silent = false } = {}) {
  const cmd = `gh ${args}`;
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (!silent) {
      console.error(`gh command failed: ${cmd}`);
      if (err.stderr) console.error(err.stderr.toString().trim());
    }
    throw err;
  }
}

/**
 * Get labels on a PR.
 * @param {number|string} prNumber
 * @returns {string[]} array of label names
 */
export function getPrLabels(prNumber) {
  const out = gh(`pr view ${prNumber} --json labels --jq '.labels[].name'`);
  if (!out) return [];
  return out.split('\n').filter(Boolean);
}

/**
 * Get reactions on a PR (issue endpoint).
 * @param {number|string} prNumber
 * @returns {Array<{content: string, user: {login: string}}>}
 */
export function getPrReactions(prNumber) {
  const ownerRepo = getOwnerRepo();
  const out = gh(`api repos/${ownerRepo}/issues/${prNumber}/reactions`);
  if (!out) return [];
  try {
    return JSON.parse(out);
  } catch {
    return [];
  }
}

/**
 * Add a label to a PR. Creates the label if it doesn't exist.
 * @param {number|string} prNumber
 * @param {string} label
 */
export function addPrLabel(prNumber, label) {
  gh(`pr edit ${prNumber} --add-label "${label}"`);
}

/**
 * Post a comment on a PR.
 * @param {number|string} prNumber
 * @param {string} body
 */
export function addPrComment(prNumber, body) {
  // Use stdin to avoid shell escaping issues with the comment body
  execSync(`gh pr comment ${prNumber} --body-file -`, {
    input: body,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Close a PR with an optional comment.
 * @param {number|string} prNumber
 * @param {string} [comment]
 */
export function closePr(prNumber, comment) {
  if (comment) {
    gh(`pr close ${prNumber} --comment "${comment.replace(/"/g, '\\"')}"`);
  } else {
    gh(`pr close ${prNumber}`);
  }
}

/**
 * Get PR state: 'OPEN', 'CLOSED', or 'MERGED'.
 * @param {number|string} prNumber
 * @returns {string}
 */
export function getPrStatus(prNumber) {
  const out = gh(`pr view ${prNumber} --json state --jq '.state'`);
  return out;
}

/**
 * List PRs matching given labels.
 * @param {string[]} labels - label names to filter by
 * @returns {Array<{number: number, title: string, labels: Array<{name: string}>}>}
 */
export function getRepoPrs(labels) {
  const labelArg = labels.map(l => `--label "${l}"`).join(' ');
  const out = gh(`pr list ${labelArg} --json number,title,labels`);
  if (!out) return [];
  try {
    return JSON.parse(out);
  } catch {
    return [];
  }
}

/**
 * Remove a label from a PR.
 * @param {number|string} prNumber
 * @param {string} label
 */
export function removePrLabel(prNumber, label) {
  gh(`pr edit ${prNumber} --remove-label "${label}"`, { silent: true });
}

/**
 * Count thumbs-up (+1) reactions on a PR.
 * @param {number|string} prNumber
 * @returns {number}
 */
export function countThumbsUp(prNumber) {
  const reactions = getPrReactions(prNumber);
  return reactions.filter(r => r.content === '+1').length;
}
