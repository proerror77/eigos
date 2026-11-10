#!/usr/bin/env node
/**
 * Kernel construction benchmark.
 *
 * The ontology kernel is an immutable chain: every stage republishes the whole
 * document. This measures what that costs so the numbers are reviewable instead
 * of folklore.
 *
 * Usage: node --import tsx scripts/kernel-bench.mts [--json] [--target=28]
 */
import { createHash } from 'node:crypto';
import {
  createSeedDefinition,
  createCurrentKernelDefinition,
  StagedKernelBuilder,
} from '../packages/ontology/seed-definition.js';
import { compileOntologyDocument } from '../packages/ontology/model-compiler.js';
import { createDomainVocabularyKernelDefinition } from '../packages/ontology/seed-definition.js';

const now = () => Number(process.hrtime.bigint()) / 1e6;
const target = (process.argv.find(argument => argument.startsWith('--target='))?.slice(9) ?? '28') as '27' | '28' | '29' | '30' | '31';
const asJson = process.argv.includes('--json');

const legacyStart = now();
const legacy = createSeedDefinition();
const legacyMs = now() - legacyStart;

const builder = new StagedKernelBuilder(target);
let progress = builder.step(0);
const stages: { stage: number; ms: number }[] = [];
while (!progress.ready) {
  const started = now();
  progress = builder.step(progress.completed);
  stages.push({ stage: progress.completed, ms: Math.round(now() - started) });
}

const chainStart = now();
const current = createCurrentKernelDefinition();
const chainMs = now() - chainStart;

const document = current.document, registry = current.registry;
const cloneStart = now(); const clone = structuredClone(document); const cloneMs = now() - cloneStart;
const protectStart = now(); registry.protect(clone); const protectMs = now() - protectStart;
const assertStart = now(); registry.assertProtected(clone); const assertMs = now() - assertStart;
const compileStart = now(); compileOntologyDocument(document, registry); const compileMs = now() - compileStart;
const digestStart = now(); createHash('sha256').update(JSON.stringify(document)).digest('hex'); const serializeMs = now() - digestStart;

const result = {
  target,
  legacyMs: Math.round(legacyMs),
  chainMs: Math.round(chainMs),
  stageMs: stages.map(entry => entry.ms),
  stageTotalMs: stages.reduce((sum, entry) => sum + entry.ms, 0),
  stageCount: stages.length,
  cloneMs: Math.round(cloneMs),
  protectMs: Math.round(protectMs),
  assertMs: Math.round(assertMs),
  compileMs: Math.round(compileMs),
  serializeMs: Math.round(serializeMs),
  documentBytes: JSON.stringify(document).length,
  counts: current.audit.counts,
  model: current.audit.model,
  vocabulary: createDomainVocabularyKernelDefinition().audit.model.version,
};
if (asJson) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`kernel v${target} — ${result.stageCount} stages, ${result.chainMs} ms total (${result.stageTotalMs} ms inside stages)`);
  console.log(`  legacy v15 build      ${result.legacyMs} ms`);
  console.log(`  whole current chain   ${result.chainMs} ms`);
  console.log(`  one compile           ${result.compileMs} ms`);
  console.log(`  protect / assert      ${result.protectMs} / ${result.assertMs} ms`);
  console.log(`  structuredClone       ${result.cloneMs} ms`);
  console.log(`  per stage             ${result.stageMs.join(', ')}`);
  console.log(`  document              ${(result.documentBytes / 1024 / 1024).toFixed(2)} MB`);
}
