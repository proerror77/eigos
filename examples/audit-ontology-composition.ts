import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { JobStore } from '../packages/core/store.js';
import { digest } from '../packages/core/delegation.js';
import { domainAtomicMetadata } from '../packages/ontology/domain-composition.js';
import { sandboxActionSchemas } from '../packages/ontology/sandbox-composition.js';
import { ucpSchemas } from '../packages/ontology/ucp-composition.js';
import { catalogActionIds } from '../packages/ontology/catalog-agent.js';
import { paotuiActionIds } from '../packages/ontology/paotui-agent.js';
import { commerceJourneyActionSchemas } from '../packages/ontology/commerce-journey.js';
import { stripePaymentActionSchemas } from '../packages/ontology/stripe-payment.js';
import { bookingActionSchemas } from '../packages/ontology/booking.js';
import { domainNames } from '../packages/ontology/service-domains.js';
import { BRIEF_CAPABILITY } from '../packages/capabilities/brief.js';
import { DOCUMENT_CAPABILITY } from '../packages/capabilities/document.js';
import { CSV_CAPABILITY } from '../packages/capabilities/csv-audit.js';
import { SANDBOX_CAPABILITY } from '../packages/capabilities/sandbox-service.js';
import { PAOTUI_READ_CAPABILITIES } from '../packages/capabilities/paotui-read.js';
import { domainCapability } from '../packages/capabilities/domain-service.js';
import { ucpCapabilities } from '../packages/capabilities/ucp/adapter.js';

// Definition/registration inventory only. This never loads a member config,
// calls a provider, registers a source, creates a task or grants authority.
const { values } = parseArgs({ options: { output: { type: 'string' } } });
if (!values.output) throw new Error('Pass --output with the destination for this audit snapshot');
const store = new JobStore(':memory:');
try {
  const release = store.definitions.active(), model = release.model, document = release.document;
  const programs = [
    { capability: 'commerce.catalog.query@2', source: 'packages/capabilities/catalog-agent.ts', actions: [...catalogActionIds] },
    { capability: 'delivery.quote@4', source: 'packages/capabilities/paotui-agent.ts', actions: [...paotuiActionIds] },
    { capability: 'address.book.read@3', source: 'packages/capabilities/paotui-agent.ts', actions: ['ReadSavedAddresses'] },
    { capability: 'commerce.journey.sandbox@2', source: 'packages/capabilities/commerce-agent.ts', actions: Object.keys(commerceJourneyActionSchemas).filter(id => id !== 'SubmitCommerceUnpaidOrder') },
    { capability: 'commerce.journey.stripe-test@1', source: 'packages/capabilities/commerce-agent.ts', actions: [...Object.keys(commerceJourneyActionSchemas).filter(id => !['SubmitCommerceOrder', 'ReadCommercePayment', 'ReadCommerceDelivery'].includes(id)), ...Object.keys(stripePaymentActionSchemas)] },
    { capability: 'booking.pa-payment.sandbox@2', source: 'packages/capabilities/booking/program.ts', actions: Object.keys(bookingActionSchemas) },
    { capability: 'brief.prepare@2', source: 'packages/capabilities/local-artifact-agent.ts', actions: ['PrepareTaskBrief'] },
    { capability: 'data.quality.audit.simulated@2', source: 'packages/capabilities/local-artifact-agent.ts', actions: ['ReadCsvAuditSource', 'AuditCsvSnapshot'] },
    { capability: 'document.compose@2', source: 'packages/capabilities/document-agent.ts', actions: ['ComposeDocument'] },
    { capability: 'geo.search@1', source: 'packages/capabilities/geo-agent.ts', actions: ['ReadPublicLocations'] },
    ...domainNames.map(domain => ({ capability: `service.${domain}.sandbox@2`, source: 'packages/capabilities/domain-agent.ts', actions: Object.values(domainAtomicMetadata(domain)).filter((value): value is string => typeof value === 'string') })),
    { capability: 'commerce.ucp.prepare.sandbox.atomic@1', source: 'packages/capabilities/ucp/program.ts', actions: Object.keys(ucpSchemas).filter(id => ['ReadUcpCreateTerms', 'CreateUcpCheckout'].includes(id)) },
    { capability: 'commerce.ucp.confirm.sandbox.atomic@1', source: 'packages/capabilities/ucp/program.ts', actions: Object.keys(ucpSchemas).filter(id => ['ReadUcpConfirmationTerms', 'ConfirmUcpCheckout'].includes(id)) },
    { capability: 'service.fulfillment.sandbox.atomic@1', source: 'packages/capabilities/sandbox-agent.ts', actions: Object.keys(sandboxActionSchemas) },
    { capability: 'ontology.managed.<published-ontology>', source: 'packages/capabilities/dynamic-ontology.ts', actions: model.actionDefinitions().filter(a => model.actionImplementation(a.id)?.kind === 'declarative').map(a => a.id) },
  ];
  // Only the metadata factory uses this ephemeral key. No client is constructed
  // and no key, signature or credential enters the inventory.
  const ucp = ucpCapabilities({ merchantId: 'audit-only', baseUrl: 'http://127.0.0.1:1', platformProfileUrl: 'http://127.0.0.1:1/.well-known/ucp', keyId: 'audit-only', privateKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey, fulfillmentProfiles: {} });
  const adapters = [BRIEF_CAPABILITY, DOCUMENT_CAPABILITY, CSV_CAPABILITY, SANDBOX_CAPABILITY, ...PAOTUI_READ_CAPABILITIES, ...domainNames.map(domainCapability), ...ucp];
  const definitions = model.actionDefinitions();
  const adapterRegistrations = adapters.map(capability => ({ activation: ['document.compose', 'delivery.quote', 'address.book.read'].includes(capability.ref.id) ? 'historical_or_explicit_fixture_only' : 'explicit_legacy_decision_only_no_native_fallback', capability: `${capability.ref.id}@${capability.ref.version}`, environment: capability.environment ?? 'local', verifierRef: capability.verifierRef, predicates: capability.predicates.map(p => p.id), actions: capability.actions.map(action => ({ ...action, ontologyActionIds: definitions.filter(definition => definition.id === action.ref.id || definition.providerOperation === action.ref.id).map(definition => definition.id) })) }));
  const actions = definitions.map(action => ({
    id: action.id, version: action.version ?? action.read?.version ?? action.operation?.version ?? null,
    kind: action.kind ?? null, inputs: action.inputs, declaredResultTypes: action.resultTypes ?? [],
    effectiveResultTypes: action.resultTypes ?? (action.read ? [action.read.resultType] : action.operation ? [action.operation.resultType] : []),
    declaredEffects: action.effects ?? [], effectiveEffects: action.effects ?? (action.read ? ['read'] : action.operation ? [action.operation.effect, ...(action.operation.additionalEffects ?? [])] : []),
    composition: action.composition ? { version: action.composition.version, inputs: action.composition.inputs, outputs: action.composition.outputs, checks: action.composition.checks, effectScope: action.composition.effectScope } : null,
    schemaPresent: !!(action.inputSchema ?? action.read?.inputSchema ?? action.operation?.inputSchema),
    changes: action.changes, submissionCriteria: action.submissionCriteria, implementation: model.actionBindingStatus(action.id),
    programRegistrations: programs.filter(program => program.actions.includes(action.id)).map(program => program.capability),
    adapterRegistrations: adapterRegistrations.filter(adapter => adapter.actions.some(operation => operation.ontologyActionIds.includes(action.id))).map(adapter => adapter.capability),
    definitionDigest: digest(action),
  }));
  const files = execFileSync('rg', ['--no-index', '--files', '--', 'apps', 'packages'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const sourceDigests = Object.fromEntries([...files, 'package.json', 'package-lock.json', 'tsconfig.json'].sort().map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
  const snapshot = {
    version: 2, recordedAt: new Date().toISOString(), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    auditGeneratorSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    scope: 'isolated current definitions and source-declared program/compatibility inventory; not deployed configuration, source readiness or completion evidence',
    networkCalls: 0, memberConfigurationRead: false, tasksCreated: 0, release: release.ref, model: model.ref,
    counts: { objects: document.objects.length, interfaces: document.interfaces.length, links: document.links.length, actions: actions.length, functions: document.functions.length, programFamilies: programs.length, adapterCapabilities: adapterRegistrations.length },
    objects: document.objects.map(o => ({
      id: o.id, resourceId: o.resourceId, version: o.version, primaryKey: o.primaryKey, writePolicy: o.writePolicy, interfaces: o.interfaces ?? [],
      properties: Object.fromEntries(Object.entries(o.properties).map(([name, p]) => [name, {
        kind: p.kind, required: !!p.required, authority: p.authority ?? o.writePolicy, source: p.source, restricted: !!p.restricted, derived: p.derived ?? null,
      }])),
    })),
    interfaces: document.interfaces.map(i => ({ id: i.id, parents: i.parents ?? [], links: i.links ?? [], actions: i.actions ?? [] })),
    links: document.links.map(l => ({ id: l.id, from: l.from, to: l.to, writePolicy: l.writePolicy })),
    functions: document.functions.map(f => ({ id: f.id, version: f.version, inputTypes: f.inputTypes, handlerRef: f.handlerRef })),
    programs, adapterRegistrations, actions,
    gaps: {
      adapterOperationsWithoutOntologyDefinition: adapterRegistrations.flatMap(c => c.actions.filter(a => !a.ontologyActionIds.length).map(a => ({ capability: c.capability, operation: a.ref, effect: a.effect }))),
      actionsWithSeveralProgramRegistrations: actions.filter(a => a.programRegistrations.length > 1).map(a => ({ action: a.id, programs: a.programRegistrations })),
      actionsWithoutEffectiveOutputContract: actions.filter(a => !a.effectiveResultTypes.length).map(a => a.id),
      definitionsWithoutRuntimeRegistration: actions.filter(a => !a.programRegistrations.length && !a.adapterRegistrations.length).map(a => ({ action: a.id, implementation: a.implementation, note: 'May be an intentional planning-only definition; classify before enabling' })),
    }, sourceDigests,
  };
  const destination = resolve(values.output); mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(JSON.stringify({ output: values.output, counts: snapshot.counts, gapCounts: Object.fromEntries(Object.entries(snapshot.gaps).map(([name, entries]) => [name, entries.length])) }));
} finally { store.close(); }
