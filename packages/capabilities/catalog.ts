import { DidiBookingProgram } from './didi/booking-program.js';
import type { DidiBookingConnector } from './didi/booking-connector.js';
import { DidiAgentProgram } from './didi/program.js';
import type { DidiBinding } from './didi/contracts.js';
import type { DidiConnector } from './didi/connector.js';
import { SandboxAgentProgram } from './sandbox-agent.js';
import { UcpAgentProgram } from './ucp/program.js';
import { GeoAgentProgram } from './geo-agent.js';
import { LocalArtifactProgram } from './local-artifact-agent.js';
import { DomainAgentProgram } from './domain-agent.js';
import { CatalogAgentProgram } from './catalog-agent.js';
import type { ShopifyMerchant } from './shopify/contracts.js';
import type { CatalogConnector } from './shopify/connector.js';
import { PersonalSourceAccess } from '../core/personal-source.js';
import { PaotuiAgentProgram } from './paotui-agent.js';
import { BookingAgentProgram } from './booking/program.js';
import type { BookingSandboxOptions } from './booking/connector.js';
import { DomainServiceAdapter, domainBinding, domainCapability, type DomainSandboxProvider } from './domain-service.js';
import { ExecutionCatalog } from '../core/catalog.js';
import { createDynamicOntologyProgram } from './dynamic-ontology.js';
import { BRIEF_CAPABILITY, BRIEF_BINDING, BriefAdapter } from './brief.js';
import { CSV_CAPABILITY, CSV_BINDING, CsvAuditAdapter } from './csv-audit.js';
import { SANDBOX_CAPABILITY, SANDBOX_BINDING, SandboxServiceAdapter } from './sandbox-service.js';
import { DocumentAgentProgram } from './document-agent.js';
import type { Executor } from './executor.js';
import { OntologyMcpPaotuiReader } from './paotui-mcp.js';
import { PAOTUI_READ_BINDINGS, PAOTUI_READ_CAPABILITIES, PaotuiReadAdapter } from './paotui-read.js';
import type { JobStore } from '../core/store.js';
import { PaotuiGeoDiscoverySource, type PublicGeoQuery } from './paotui-geo-discovery.js';
import { UcpSandboxAdapter, ucpCapabilities, type UcpSandboxOptions } from './ucp/adapter.js';
import { CommerceAgentProgram } from './commerce-agent.js';
import type { CommerceSandboxOptions, CommerceSandboxConnector } from './commerce-sandbox/connector.js';
import type { StripeTestOptions } from './stripe/client.js';

export function createExecutionCatalog(options: { didi?: DidiBinding & { connector?: DidiConnector; bookingEnabled?: boolean; bookingConnector?: DidiBookingConnector }; store?: JobStore; csvInputDirectory?: string; documentEnabled?: boolean; documentExecutor?: Executor; paotuiSkillDirectory?: string; paotuiMemberConnectionFile?: string; memberSourceKeyFile?: string; executionHost?: 'gateway' | 'worker'; ontologyAuditPath?: string; publicGeoDiscoveryQueries?: readonly PublicGeoQuery[]; sandbox?: { endpoint: string; tokenFile: string }; domainSandboxProviders?: DomainSandboxProvider[]; ucpSandbox?: UcpSandboxOptions; bookingSandbox?: BookingSandboxOptions; stripeTest?: StripeTestOptions; commerceSandbox?: CommerceSandboxOptions & { connector?: CommerceSandboxConnector }; shopifyCatalog?: { merchants: ShopifyMerchant[]; auditDirectory?: string; connector?: CatalogConnector } } = {}): ExecutionCatalog {
  const didi = options.didi ? new DidiAgentProgram({ bindingId: options.didi.bindingId, keyFile: options.didi.keyFile, keySha256: options.didi.keySha256, environment: options.didi.environment, auditDirectory: options.didi.auditDirectory }, { connector: options.didi.connector }) : undefined;
  const didiBooking = didi && options.didi?.bookingEnabled ? new DidiBookingProgram(didi.binding, options.didi.bookingConnector, options.didi.connector) : undefined;
  const brief = new LocalArtifactProgram('brief'), csv = options.csvInputDirectory ? new LocalArtifactProgram('csv', options.csvInputDirectory) : undefined;
  const shopify = options.shopifyCatalog?.merchants.length ? new CatalogAgentProgram(options.shopifyCatalog.merchants, options.shopifyCatalog) : undefined;
  const booking = options.bookingSandbox ? new BookingAgentProgram(options.bookingSandbox) : undefined;
  const document = options.documentEnabled ? new DocumentAgentProgram(options.documentExecutor) : undefined;
  const commerce = options.commerceSandbox ? new CommerceAgentProgram(options.commerceSandbox) : undefined;
  if (options.stripeTest && !options.commerceSandbox) throw new Error('Stripe test payment requires an isolated commerce order source');
  if (options.stripeTest && !options.stripeTest.transport) throw new Error('Merchant Stripe execution is retained only for injected fixtures; use PA-owned payment handoff in EIGOS');
  const stripe = options.stripeTest ? new CommerceAgentProgram({ ...options.commerceSandbox!, stripe: options.stripeTest }) : undefined;
  if (options.ucpSandbox && !options.store) throw new Error('UCP checkout ownership requires the shared task store');
  const ucp = options.ucpSandbox ? (['prepare', 'confirm'] as const).map(mode => new UcpSandboxAdapter(mode, options.store!, options.ucpSandbox!)) : [];
  const ucpPrograms = ucp.map(adapter => new UcpAgentProgram(adapter));
  const domainProviders = options.domainSandboxProviders ?? [];
  const domainPrograms = domainProviders.map(provider => new DomainAgentProgram(provider));
  const domainCapabilities = [...new Map(domainPrograms.map(program => [program.capability().ref.id, program.capability()])).values()];
  if (options.paotuiMemberConnectionFile && (!options.paotuiSkillDirectory || !options.store || options.store.databasePath === ':memory:')) throw new Error('Member source requires a configured reader and persistent business database');
  if (options.memberSourceKeyFile && (!options.paotuiSkillDirectory || !options.store || options.store.databasePath === ':memory:' || options.paotuiMemberConnectionFile || options.publicGeoDiscoveryQueries?.length)) throw new Error('Member sources require a dedicated reader and persistent store without shared credentials');
  if (options.paotuiSkillDirectory && !options.store) throw new Error('Address selection requires the owned task store');
  const vault = options.memberSourceKeyFile ? options.store!.memberSources(options.memberSourceKeyFile, options.paotuiSkillDirectory!) : undefined;
  const access = options.paotuiMemberConnectionFile ? new PersonalSourceAccess(options.paotuiMemberConnectionFile, (c, hash) => options.store!.personalSourceAdmitted(c, hash), options.paotuiSkillDirectory!) : undefined;
  const paotui = options.paotuiSkillDirectory && !vault ? new OntologyMcpPaotuiReader(options.paotuiSkillDirectory, options.ontologyAuditPath, { access, databasePath: options.store?.databasePath, execute: options.executionHost !== 'gateway' }) : undefined;
  if (access && options.publicGeoDiscoveryQueries?.length) throw new Error('Member delivery connections do not enable public discovery');
  const paotuiPrograms = options.paotuiSkillDirectory ? (['quote', 'addresses'] as const).map(kind => new PaotuiAgentProgram(kind, { store: options.store!, directory: options.paotuiSkillDirectory!, vault, access, execute: options.executionHost !== 'gateway', auditPath: options.ontologyAuditPath })) : [];
  const sandbox = options.sandbox ? new SandboxServiceAdapter(options.sandbox.endpoint, options.sandbox.tokenFile) : undefined;
  const sandboxProgram = sandbox ? new SandboxAgentProgram(sandbox, options.store) : undefined;
  if (options.publicGeoDiscoveryQueries?.length && !paotui) throw new Error('Public-location discovery requires the existing personal Meituan reader');
  // Off by default. Trusted configuration must enumerate authorized public queries;
  // model output and user task content cannot enable or broaden this list.
  const geoDiscovery = paotui && options.publicGeoDiscoveryQueries?.length
    ? new PaotuiGeoDiscoverySource(paotui, paotui.configurationDigest, options.publicGeoDiscoveryQueries) : undefined;
  const reads = PAOTUI_READ_CAPABILITIES.map((c, i) => ({ capability: c, binding: PAOTUI_READ_BINDINGS[i]!, i })).filter(x => x.i === 0 && !access);
  const geo = paotui && reads.length ? new GeoAgentProgram(geoDiscovery?.adapter ?? new PaotuiReadAdapter(0, paotui, access), geoDiscovery?.configurationDigest ?? paotui.configurationDigest) : undefined;
  return new ExecutionCatalog([...(didiBooking ? [didiBooking.capability()] : []), ...(didi ? [didi.capability()] : []), brief.capability(), ...paotuiPrograms.map(p => p.capability()), ...domainCapabilities, ...(sandboxProgram ? [sandboxProgram.capability()] : []), ...ucpPrograms.map(program => program.capability()), ...(shopify ? [shopify.capability()] : []), ...(commerce ? [commerce.capability()] : []), ...(stripe ? [stripe.capability()] : []), ...(booking ? [booking.capability()] : []), ...(options.ucpSandbox ? ucpCapabilities(options.ucpSandbox) : []), ...(csv ? [csv.capability()] : []), ...(options.sandbox ? [SANDBOX_CAPABILITY] : []), ...(document ? [document.capability()] : []), ...(geo ? [geo.capability()] : [])],
    [BRIEF_BINDING, ...domainProviders.map(domainBinding), ...ucp.map(adapter => adapter.binding()), ...(options.csvInputDirectory ? [CSV_BINDING] : []), ...(sandbox ? [{ ...SANDBOX_BINDING, configurationDigest: sandbox.configurationDigest }] : []), ...(paotui ? [...reads.filter(x => !geoDiscovery || x.i !== 0).map(x => x.binding)].map(b => ({ ...b, configurationDigest: paotui.configurationDigest })) : [])],
    [new BriefAdapter(), ...domainProviders.map(p => new DomainServiceAdapter(p)), ...ucp, ...(options.csvInputDirectory ? [new CsvAuditAdapter(options.csvInputDirectory)] : []), ...(sandbox ? [sandbox] : []), ...(paotui ? [...reads.map(x => x.i === 0 && geoDiscovery ? geoDiscovery.adapter : new PaotuiReadAdapter(x.i, paotui, access))] : [])],
    geoDiscovery ? [geoDiscovery] : [], [...(didiBooking ? [didiBooking] : []), ...(didi ? [didi] : []), brief, ...(sandboxProgram ? [sandboxProgram] : []), ...(csv ? [csv] : []), ...(geo ? [geo] : []), ...domainPrograms, ...ucpPrograms, ...paotuiPrograms, ...(shopify ? [shopify] : []), ...(commerce ? [commerce] : []), ...(stripe ? [stripe] : []), ...(booking ? [booking] : []), ...(document ? [document] : [])], createDynamicOntologyProgram);
}
