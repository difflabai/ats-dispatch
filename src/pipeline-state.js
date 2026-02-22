/**
 * Pipeline state persistence — stores project/variant metadata as JSON.
 *
 * State file: .pipeline/state.json in the repo root.
 * Structure:
 * {
 *   projects: {
 *     "<id>": {
 *       id: string,
 *       name: string,
 *       round: number,
 *       status: "evaluating" | "advanced" | "idle",
 *       variants: [
 *         { branch: string, pr_number: number|null, status: "open"|"picked"|"closed" }
 *       ]
 *     }
 *   }
 * }
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

function repoRoot() {
  return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
}

function statePath() {
  return join(repoRoot(), '.pipeline', 'state.json');
}

function ensureDir() {
  const dir = join(repoRoot(), '.pipeline');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadState() {
  const p = statePath();
  if (!existsSync(p)) return { projects: {} };
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return { projects: {} };
  }
}

export function saveState(state) {
  ensureDir();
  writeFileSync(statePath(), JSON.stringify(state, null, 2) + '\n');
}

export function getProject(id) {
  const state = loadState();
  return state.projects[id] || null;
}

export function setProject(project) {
  const state = loadState();
  state.projects[project.id] = project;
  saveState(state);
}

export function listProjects() {
  const state = loadState();
  return Object.values(state.projects);
}
