#!/usr/bin/env node
// Every stage must be verified here, so the kernel builder compiles each
// intermediate release and compares its published model ref. Ordinary runs
// (tests, benches, the gateway) only verify the release they actually publish.
process.env.EIGOS_KERNEL_PINS = 'full';
/**
 * Ontology integrity gate.
 *
 * Runs the checks that ordinary unit tests only cover incidentally:
 *   --kernels         every selectable kernel release rebuilds to its pinned fingerprint
 *   --structure       graph invariants (dangling links, orphans, duplicate API names)
 *   --classification  reviewed domain vocabulary and per-domain coverage
 *   --actions         actions without an executable implementation must be declared
 *
 * Usage: node --import tsx scripts/ontology-integrity.mjs [--kernels|--structure|--classification|--actions] [--json]
 * Exits non-zero when a check fails so CI can block the change.
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const load = path => import(pathToFileURL(resolve(root, path)).href);

const selections = process.argv.slice(2).filter(arg => arg.startsWith('--') && arg !== '--json');
const mode = selections.length ? new Set(selections) : new Set(['--kernels', '--structure', '--classification', '--actions']);
const json = process.argv.includes('--json');

/** A release that is selectable in code but not fingerprinted is a review gap.
 * Listing it here is a deliberate, reviewable exception. */
const UNPINNED_ALLOWLIST = new Map();

/** Actions that deliberately exist as definitions without an executable
 * implementation. Adding an entry is a reviewed decision, never a silent pass. */
const DEFINITION_ONLY_ACTIONS = new Set([
  'LinkEvidence', 'Cite', 'Observe',
  'RequestDeliveryQuote', 'SelectOffer', 'SubmitServiceRequest', 'ProposeServiceExecution',
  'AuthorizeProposal', 'ConfirmSimulationQuote', 'RevokeProposalAuthorization',
  'AssessServiceOutcome', 'RequestServiceRemedy',
]);

const KERNEL_TARGETS = ['27', '28', '29', '30', '31', '32', '33', '34', '35', '36', '37'];
const PIN_CONSTANTS = {
  '26': 'SINGLE_READ_KERNEL_MODEL_REF',
  '27': 'PAYMENT_COMMERCE_KERNEL_MODEL_REF',
  '28': 'BUSINESS_DESCRIPTIONS_KERNEL_MODEL_REF',
  '29': 'SEMANTIC_RETRIEVAL_KERNEL_MODEL_REF',
  '30': 'PA_CLASSIFICATION_KERNEL_MODEL_REF',
  '31': 'DOMAIN_VOCABULARY_KERNEL_MODEL_REF',
  '32': 'CONTRACT_CLOSURE_KERNEL_MODEL_REF',
  '33': 'EFFECT_COVERAGE_KERNEL_MODEL_REF',
  '34': 'EXECUTABLE_CONTRACT_KERNEL_MODEL_REF',
  '35': 'FUNCTION_CONTRACT_CLOSEOUT_MODEL_REF',
  '36': 'INTERFACE_CONTRACT_MODEL_REF', '37': 'PALANTIR_MODEL_REF',
};
/** Legacy releases accepted by the reviewed-model compatibility matrix that have
 * no reconstruction path in this codebase. Declaring them here is the reviewed
 * decision; a *new* reviewed version without a pin fails the gate. */
const HISTORICAL_ONLY = new Map([
  ['24', 'Superseded before the fingerprint registry; no reconstruction path'],
  ['25', 'Only the SINGLE_READ_PREDECESSOR digest survives; not a selectable target'],
]);

const results = [];
const record = (check, ok, detail) => { results.push({ check, ok, detail }); };

async function kernels() {
  const seed = await load('packages/ontology/seed-definition.ts');
  for (const target of KERNEL_TARGETS) {
    const constant = PIN_CONSTANTS[target];
    const pin = seed[constant];
    if (!pin) {
      const allowed = UNPINNED_ALLOWLIST.has(target);
      record(`kernel:${target}:pin`, allowed, allowed ? `allowlisted: ${UNPINNED_ALLOWLIST.get(target)}` : `no ${constant} fingerprint constant`);
      continue;
    }
    const builder = new seed.StagedKernelBuilder(target);
    let progress = builder.step(0);
    while (!progress.ready) progress = builder.step(progress.completed);
    const { audit, document } = builder.result(), built = audit.model;
    record(`kernel:${target}:fingerprint`, built.version === target && built.digest === pin.digest,
      `built ${built.version}@${built.digest.slice(0, 16)} expected ${pin.version}@${pin.digest.slice(0, 16)} (${progress.total} stages)`);
    if (Number(target) >= 35) {
      const undeclared = document.functions.filter(fn => fn.executionContract?.mode !== 'validated').map(fn => fn.id);
      record('kernel:35:function-contracts', document.functions.length === 54 && undeclared.length === 0,
        undeclared.length ? `unvalidated functions: ${undeclared.join(', ')}` : `${document.functions.length} validated functions`);
    }
  }
  const current = seed.createCurrentKernelDefinition().audit.model;
  record('kernel:current:unchanged', current.version === seed.CURRENT_KERNEL_VERSION,
    `current ${current.version} ${current.digest.slice(0, 16)}`);
  // Reviewed-model compatibility lists historical kernel versions by hand. Every
  // version it accepts must have a fingerprint constant, otherwise the security
  // review silently covers a release nobody pinned.
  const review = await readFile(resolve(root, 'packages/security/model-review.ts'), 'utf8');
  const listed = [...review.matchAll(/'(\d{2})'/g)].map(match => match[1]).filter(version => KERNEL_TARGETS.includes(version) || Number(version) > 20);
  const unpinned = [...new Set(listed)].filter(version => !PIN_CONSTANTS[version] && !HISTORICAL_ONLY.has(version)).sort();
  record('kernel:reviewed-versions-pinned', unpinned.length === 0,
    unpinned.length ? `reviewed without a pin: ${unpinned.join(', ')}` : `reviewed versions: ${[...new Set(listed)].sort().join(', ')} (${HISTORICAL_ONLY.size} historical-only)`);
}

async function structure() {
  const seed = await load('packages/ontology/seed-definition.ts');
  const document = seed.createPalantirModelDefinition().document;
  const known = new Set([...document.objects, ...document.interfaces].map(type => type.id));
  const dangling = document.links.filter(link => !known.has(link.from.type) || !known.has(link.to.type));
  record('structure:dangling-links', dangling.length === 0, `${dangling.length} unresolved of ${document.links.length} links`);
  const degree = new Map();
  for (const link of document.links) for (const side of [link.from, link.to]) degree.set(side.type, (degree.get(side.type) ?? 0) + 1);
  const orphans = document.objects.filter(type => !degree.get(type.id)).map(type => type.id);
  record('structure:orphan-objects', orphans.length === 0, orphans.join(', ') || 'none');
  const apiNames = new Set(), duplicates = [];
  for (const [kind, values] of [['object', document.objects], ['interface', document.interfaces], ['link', document.links], ['action', document.actions]]) {
    for (const value of values) { const key = `${kind}:${value.id}`; if (apiNames.has(key)) duplicates.push(key); apiNames.add(key); }
  }
  record('structure:duplicate-api-names', duplicates.length === 0, duplicates.join(', ') || 'none');
  const requiredPrimaryKeys = document.objects.filter(type => !type.primaryKey || !Object.hasOwn(type.properties, type.primaryKey)).map(type => type.id);
  record('structure:primary-keys', requiredPrimaryKeys.length === 0, requiredPrimaryKeys.join(', ') || 'none');
  const requiredTitles = document.objects.filter(type => !type.titleKey || !Object.hasOwn(type.properties, type.titleKey)).map(type => type.id);
  record('structure:title-keys', requiredTitles.length === 0, requiredTitles.join(', ') || 'none');
}

async function classification() {
  const seed = await load('packages/ontology/seed-definition.ts');
  const vocabulary = await load('packages/ontology/domain-vocabulary.ts');
  const contract = await load('packages/ontology/pa-classification-contract.ts');
  const domains = await load('packages/ontology/service-domains.ts');
  for (const [constName, label] of [['PA_CLASSIFICATION_KERNEL_MODEL_REF', 'v30'], ['DOMAIN_VOCABULARY_KERNEL_MODEL_REF', 'v31']]) {
    const document = constName === 'PA_CLASSIFICATION_KERNEL_MODEL_REF'
      ? seed.createPaClassificationKernelDefinition().document
      : seed.createDomainVocabularyKernelDefinition().document;
    const unclassified = document.objects.filter(type => !type.classification).map(type => type.id);
    record(`classification:${label}:complete`, unclassified.length === 0, unclassified.join(', ') || `${document.objects.length} types`);
    const unreviewed = [];
    for (const type of document.objects) for (const domain of type.classification.domains) if (!vocabulary.isAcceptedDomain(domain)) unreviewed.push(`${type.id}.${domain}`);
    record(`classification:${label}:vocabulary`, unreviewed.length === 0, unreviewed.join(', ') || `${Object.keys(vocabulary.paDomainLabels).length} reviewed labels`);
    const available = contract.paAvailableDomains(document.objects).map(entry => entry.label);
    const missing = domains.domainNames.filter(name => !available.includes(name));
    record(`classification:${label}:domain-coverage`, missing.length === 0, missing.length ? `no discoverable types for ${missing.join(', ')}` : `discoverable: ${available.join(', ')}`);
    const aliasLeft = document.objects.flatMap(type => type.classification.domains.filter(domain => !vocabulary.isReviewedDomainLabel(domain)).map(domain => `${type.id}.${domain}`));
    if (label === 'v31') record('classification:v31:canonical-spellings', aliasLeft.length === 0, aliasLeft.join(', ') || 'no alias spellings published');
  }
  const unmapped = domains.domainNames.filter(name => !vocabulary.labelForServiceDomain(name));
  record('classification:runtime-domain-labels', unmapped.length === 0, unmapped.join(', ') || 'every runtime service domain has a reviewed label');
}

async function actions() {
  const seed = await load('packages/ontology/seed-definition.ts');
  const document = seed.createPalantirModelDefinition().document;
  const unimplemented = document.actions.filter(action => !action.implementation).map(action => action.id);
  const undeclared = unimplemented.filter(id => !DEFINITION_ONLY_ACTIONS.has(id));
  record('actions:definition-only-declared', undeclared.length === 0, undeclared.join(', ') || `${unimplemented.length} reviewed definition-only actions`);
  const stale = [...DEFINITION_ONLY_ACTIONS].filter(id => !unimplemented.includes(id));
  record('actions:definition-only-current', stale.length === 0, stale.length ? `no longer definition-only: ${stale.join(', ')}` : 'allowlist matches the release');
}

const runners = { '--kernels': kernels, '--structure': structure, '--classification': classification, '--actions': actions };
for (const [flag, runner] of Object.entries(runners)) if (mode.has(flag)) await runner();

const failed = results.filter(result => !result.ok);
if (json) console.log(JSON.stringify({ ok: failed.length === 0, checks: results }, null, 2));
else for (const result of results) console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.check} — ${result.detail}`);
if (failed.length) {
  console.error(`\n${failed.length} ontology integrity check(s) failed.`);
  process.exitCode = 1;
} else console.log(`\nOntology integrity: ${results.length} checks passed.`);
