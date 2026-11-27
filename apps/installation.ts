import { loadInstallation } from '../packages/runtime/installation.js';

export async function selectedInstallation() {
  const path = process.env.EIGOS_SOLUTION_MANIFEST;
  return path === undefined ? (await import('../packages/solutions/eigos/installation.js')).eigosInstallation() : loadInstallation(path);
}
