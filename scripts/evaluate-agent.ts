import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { HarnessAgent } from '../packages/runtime/harness.js';
import { agentEvaluationCases, evaluateAgentCase, type AgentEvaluationCase } from '../tests/agent-evaluation.js';

async function main() {
  const args = process.argv.slice(2);
  const selected = args[0]?.startsWith('--case=') ? args[0].slice('--case='.length) : undefined;
  if (args.length && (args.length !== 1 || !agentEvaluationCases.includes(selected as AgentEvaluationCase))) {
    throw new Error(`Choose one case with --case=. Available cases: ${agentEvaluationCases.join(', ')}`);
  }
  const binary = process.env.EIGOS_HARNESS_BIN;
  const credentialFile = process.env.EIGOS_HARNESS_CREDENTIAL_FILE;
  const model = process.env.EIGOS_HARNESS_MODEL;
  if (!binary || !isAbsolute(binary) || !credentialFile || !isAbsolute(credentialFile) || !model) {
    throw new Error('Set EIGOS_HARNESS_BIN and EIGOS_HARNESS_CREDENTIAL_FILE to absolute paths and select EIGOS_HARNESS_MODEL.');
  }
  try { await access(binary, constants.X_OK); }
  catch { throw new Error('The configured EIGOS Harness runtime must be executable.'); }

  const driver = new HarnessAgent({ binary, credentialFile, model, reasoningEffort: process.env.EIGOS_HARNESS_REASONING_EFFORT ?? 'low' });
  const cases = selected ? [selected as AgentEvaluationCase] : agentEvaluationCases;
  const results = [];
  for (const name of cases) results.push(await evaluateAgentCase(name, () => driver));
  const passed = results.every(result => result.passed);
  console.log(JSON.stringify({ version: 1, source: 'synthetic', model, passed, cases: results }, null, 2));
  process.exitCode = passed ? 0 : 1;
}

try { await main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : 'Agent evaluation failed');
  process.exitCode = 1;
}
