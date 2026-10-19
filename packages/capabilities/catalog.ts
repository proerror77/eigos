import { ShopifyCatalogAdapter } from './shopify/adapter.js';
import type { ShopifyMerchant } from './shopify/contracts.js';
import type { ShopifyCatalogReader } from './shopify/reader.js';
import { PersonalSourceAccess } from '../core/personal-source.js';
import { DomainServiceAdapter, domainBinding, domainCapability, type DomainSandboxProvider } from './domain-service.js';
import { ExecutionCatalog } from '../core/catalog.js';
import { BRIEF_CAPABILITY, BRIEF_BINDING, BriefAdapter } from './brief.js';
import { CSV_CAPABILITY, CSV_BINDING, CsvAuditAdapter } from './csv-audit.js';
import { SANDBOX_CAPABILITY, SANDBOX_BINDING, SandboxServiceAdapter } from './sandbox-service.js';
import { DocumentAdapter, DOCUMENT_CAPABILITY, DOCUMENT_BINDING } from './document.js';
import type { Executor } from './executor.js';
import { OntologyMcpPaotuiReader } from './paotui-mcp.js';
import { PAOTUI_READ_BINDINGS, PAOTUI_READ_CAPABILITIES, PaotuiReadAdapter } from './paotui-read.js';
import type { JobStore } from '../core/store.js';
import { DELIVERY_REQUEST_CAPABILITY, DELIVERY_REQUEST_BINDING, PaotuiRequestAdapter } from './paotui-request.js';
import { PaotuiGeoDiscoverySource, type PublicGeoQuery } from './paotui-geo-discovery.js';
import { UcpSandboxAdapter, ucpCapabilities, type UcpSandboxOptions } from './ucp/adapter.js';

export function createExecutionCatalog(options: { store?: JobStore; csvInputDirectory?: string; documentEnabled?: boolean; documentExecutor?: Executor; paotuiSkillDirectory?: string; paotuiMemberConnectionFile?: string; executionHost?: 'gateway' | 'worker'; ontologyAuditPath?: string; publicGeoDiscoveryQueries?: readonly PublicGeoQuery[]; sandbox?: { endpoint: string; tokenFile: string }; domainSandboxProviders?: DomainSandboxProvider[]; ucpSandbox?: UcpSandboxOptions; shopifyCatalog?: { merchants: ShopifyMerchant[]; auditDirectory?: string; reader?: ShopifyCatalogReader } } = {}): ExecutionCatalog {
  const shopify = options.shopifyCatalog?.merchants.length ? new ShopifyCatalogAdapter(options.shopifyCatalog.merchants, options.shopifyCatalog) : undefined;
  if (options.ucpSandbox && !options.store) throw new Error('UCP checkout ownership requires the shared task store');
  const ucp = options.ucpSandbox ? (['prepare', 'confirm'] as const).map(mode => new UcpSandboxAdapter(mode, options.store!, options.ucpSandbox!)) : [];
  const domainProviders = options.domainSandboxProviders ?? [];
  const domainCapabilities = [...new Map(domainProviders.map(p => [p.domain, domainCapability(p.domain)])).values()];
  if (options.paotuiMemberConnectionFile && (!options.paotuiSkillDirectory || !options.store || options.store.databasePath === ':memory:')) throw new Error('Member source requires a configured reader and persistent business database');
  const access = options.paotuiMemberConnectionFile ? new PersonalSourceAccess(options.paotuiMemberConnectionFile, (c, hash) => options.store!.personalSourceAdmitted(c, hash), options.paotuiSkillDirectory!) : undefined;
  const paotui = options.paotuiSkillDirectory ? new OntologyMcpPaotuiReader(options.paotuiSkillDirectory, options.ontologyAuditPath, { access, databasePath: options.store?.databasePath, execute: options.executionHost !== 'gateway' }) : undefined;
  if (access && options.publicGeoDiscoveryQueries?.length) throw new Error('Member delivery connections do not enable public discovery');
  const sandbox = options.sandbox ? new SandboxServiceAdapter(options.sandbox.endpoint, options.sandbox.tokenFile) : undefined;
  if (paotui && !options.store) throw new Error('Address selection requires the owned persistent task store');
  if (options.publicGeoDiscoveryQueries?.length && !paotui) throw new Error('Public-location discovery requires the existing personal Meituan reader');
  // Off by default. Trusted configuration must enumerate authorized public queries;
  // model output and user task content cannot enable or broaden this list.
  const geoDiscovery = paotui && options.publicGeoDiscoveryQueries?.length
    ? new PaotuiGeoDiscoverySource(paotui, paotui.configurationDigest, options.publicGeoDiscoveryQueries) : undefined;
  const reads = PAOTUI_READ_CAPABILITIES.map((c, i) => ({ capability: c, binding: PAOTUI_READ_BINDINGS[i]!, i })).filter(x => x.i !== 1 && (!access || x.i === 2));
  return new ExecutionCatalog([BRIEF_CAPABILITY, ...domainCapabilities, ...(shopify ? [shopify.capability()] : []), ...(options.ucpSandbox ? ucpCapabilities(options.ucpSandbox) : []), ...(options.csvInputDirectory ? [CSV_CAPABILITY] : []), ...(options.sandbox ? [SANDBOX_CAPABILITY] : []), ...(options.documentEnabled ? [DOCUMENT_CAPABILITY] : []), ...(paotui ? [...reads.map(x => x.capability), DELIVERY_REQUEST_CAPABILITY] : [])],
    [BRIEF_BINDING, ...domainProviders.map(domainBinding), ...ucp.map(adapter => adapter.binding()), ...(shopify ? [shopify.binding()] : []), ...(options.csvInputDirectory ? [CSV_BINDING] : []), ...(sandbox ? [{ ...SANDBOX_BINDING, configurationDigest: sandbox.configurationDigest }] : []), ...(options.documentEnabled ? [DOCUMENT_BINDING] : []), ...(paotui ? [...reads.filter(x => !geoDiscovery || x.i !== 0).map(x => x.binding), DELIVERY_REQUEST_BINDING].map(b => ({ ...b, configurationDigest: paotui.configurationDigest })) : [])],
    [new BriefAdapter(), ...domainProviders.map(p => new DomainServiceAdapter(p)), ...ucp, ...(shopify ? [shopify] : []), ...(options.csvInputDirectory ? [new CsvAuditAdapter(options.csvInputDirectory)] : []), ...(sandbox ? [sandbox] : []), ...(options.documentEnabled ? [new DocumentAdapter(options.documentExecutor)] : []), ...(paotui ? [...reads.map(x => x.i === 0 && geoDiscovery ? geoDiscovery.adapter : new PaotuiReadAdapter(x.i, paotui, access)), new PaotuiRequestAdapter(paotui, options.store!, paotui.configurationDigest, access)] : [])],
    geoDiscovery ? [geoDiscovery] : []);
}
