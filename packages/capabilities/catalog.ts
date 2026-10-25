import { ParticipantBookingProgram, type ParticipantBookingSource } from './free-booking/program.js';
import { ParticipantBrowserConnector, type ParticipantBrowserOptions } from './free-booking/connector.js';
import { DidiAgentProgram } from './didi/program.js';
import type { DidiBinding } from './didi/contracts.js';
import type { DidiConnector } from './didi/connector.js';
import { BookingAgentProgram } from './booking/program.js';
import type { BookingSandboxOptions } from './booking/connector.js';
import { DomainServiceAdapter, domainBinding, domainCapability, type DomainSandboxProvider } from './domain-service.js';
import { ExecutionCatalog } from '../core/catalog.js';
import { BRIEF_CAPABILITY, BRIEF_BINDING, BriefAdapter } from './brief.js';
import { CSV_CAPABILITY, CSV_BINDING, CsvAuditAdapter } from './csv-audit.js';
import { SANDBOX_CAPABILITY, SANDBOX_BINDING, SandboxServiceAdapter } from './sandbox-service.js';
import { DocumentAdapter, DOCUMENT_CAPABILITY, DOCUMENT_BINDING } from './document.js';
import type { Executor } from './executor.js';
import { OntologyMeituanMcpReader } from './meituan-mcp.js';
import { MeituanReadProgram } from './meituan-agent.js';
import type { MeituanPrimitiveReader } from './meituan-primitives.js';
import type { JobStore } from '../core/store.js';
import type { PublicGeoQuery } from './paotui-contracts.js';
import { UcpSandboxAdapter, ucpCapabilities, type UcpSandboxOptions } from './ucp/adapter.js';
import { CatalogAgentProgram } from './catalog-agent.js';
import type { ShopifyMerchant } from './shopify/contracts.js';
import type { CatalogConnector } from './shopify/connector.js';
import { CommerceAgentProgram } from './commerce-agent.js';
import type { CommerceSandboxOptions, CommerceSandboxConnector } from './commerce-sandbox/connector.js';
import type { StripeTestOptions } from './stripe/client.js';
import { CalendarProgram, type CalendarSource } from './calendar/program.js';
import { CalendarSandboxSource } from './calendar/sandbox.js';
import { PersonalCalendarFactsProgram } from './personal-context.js';

export function createExecutionCatalog(options: { calendarSource?: CalendarSource; calendarSandboxPath?: string; meituan?: MeituanPrimitiveReader; didi?: DidiBinding & { connector?: DidiConnector }; store?: JobStore; csvInputDirectory?: string; documentEnabled?: boolean; documentExecutor?: Executor; paotuiSkillDirectory?: string; ontologyAuditPath?: string; publicGeoDiscoveryQueries?: readonly PublicGeoQuery[]; sandbox?: { endpoint: string; tokenFile: string }; domainSandboxProviders?: DomainSandboxProvider[]; ucpSandbox?: UcpSandboxOptions; bookingSandbox?: BookingSandboxOptions; participantBooking?: ParticipantBrowserOptions; participantBookingSource?: ParticipantBookingSource; stripeTest?: StripeTestOptions; commerceSandbox?: CommerceSandboxOptions & { connector?: CommerceSandboxConnector }; shopifyCatalog?: { merchants: ShopifyMerchant[]; auditDirectory?: string; connector?: CatalogConnector } } = {}): ExecutionCatalog {
  if ([options.calendarSource, options.calendarSandboxPath].filter(Boolean).length > 1) throw new Error('Select one exact calendar source binding');
  const calendarSource = options.calendarSource ?? (options.calendarSandboxPath ? new CalendarSandboxSource({ databasePath: options.calendarSandboxPath, owner: JSON.stringify(['local-development', 'local', 'developer']), accountRef: 'synthetic-local-calendar', calendarId: 'synthetic-personal-calendar' }) : undefined);
  const calendar = calendarSource ? new CalendarProgram(calendarSource) : undefined;
  const personalCalendar = options.store ? new PersonalCalendarFactsProgram(options.store) : undefined;
  const didi = options.didi ? new DidiAgentProgram({ bindingId: options.didi.bindingId, keyFile: options.didi.keyFile, keySha256: options.didi.keySha256, environment: options.didi.environment, auditDirectory: options.didi.auditDirectory }, { connector: options.didi.connector }) : undefined;
  const shopify = options.shopifyCatalog?.merchants.length ? new CatalogAgentProgram(options.shopifyCatalog.merchants, options.shopifyCatalog) : undefined;
  const registrationSource = options.participantBookingSource ?? (options.participantBooking ? new ParticipantBrowserConnector(options.participantBooking) : undefined);
  const registration = registrationSource ? new ParticipantBookingProgram(registrationSource) : undefined;
  const booking = options.bookingSandbox ? new BookingAgentProgram(options.bookingSandbox) : undefined;
  const commerce = options.commerceSandbox ? new CommerceAgentProgram(options.commerceSandbox) : undefined;
  if (options.stripeTest && !options.commerceSandbox) throw new Error('Stripe test payment requires an isolated commerce order source');
  if (options.stripeTest && !options.stripeTest.transport) throw new Error('Merchant Stripe execution is retained only for injected fixtures; use PA-owned payment handoff in EIGOS');
  const stripe = options.stripeTest ? new CommerceAgentProgram({ ...options.commerceSandbox!, stripe: options.stripeTest }) : undefined;
  if (options.ucpSandbox && !options.store) throw new Error('UCP checkout ownership requires the shared task store');
  const ucp = options.ucpSandbox ? (['prepare', 'confirm'] as const).map(mode => new UcpSandboxAdapter(mode, options.store!, options.ucpSandbox!)) : [];
  const domainProviders = options.domainSandboxProviders ?? [];
  const domainCapabilities = [...new Map(domainProviders.map(p => [p.domain, domainCapability(p.domain)])).values()];
  const paotui = options.meituan ?? (options.paotuiSkillDirectory ? new OntologyMeituanMcpReader(options.paotuiSkillDirectory, options.ontologyAuditPath) : undefined);
  const sandbox = options.sandbox ? new SandboxServiceAdapter(options.sandbox.endpoint, options.sandbox.tokenFile) : undefined;
  if (paotui && !options.store) throw new Error('Address selection requires the owned persistent task store');
  if (options.publicGeoDiscoveryQueries?.length && !paotui) throw new Error('Public-location discovery requires the existing personal Meituan reader');
  const meituan = paotui ? (['geo', 'addresses', 'delivery'] as const).map(mode => new MeituanReadProgram(mode, paotui, options.store!, options.publicGeoDiscoveryQueries)) : [];
  return new ExecutionCatalog([BRIEF_CAPABILITY, ...(calendar ? [calendar.capability()] : []), ...(personalCalendar ? [personalCalendar.capability()] : []), ...domainCapabilities, ...(registration ? [registration.capability()] : []), ...(didi ? [didi.capability()] : []), ...(shopify ? [shopify.capability()] : []), ...(commerce ? [commerce.capability()] : []), ...(stripe ? [stripe.capability()] : []), ...(booking ? [booking.capability()] : []), ...(options.ucpSandbox ? ucpCapabilities(options.ucpSandbox) : []), ...(options.csvInputDirectory ? [CSV_CAPABILITY] : []), ...(options.sandbox ? [SANDBOX_CAPABILITY] : []), ...(options.documentEnabled ? [DOCUMENT_CAPABILITY] : []), ...meituan.map(p => p.capability())],
    [BRIEF_BINDING, ...domainProviders.map(domainBinding), ...ucp.map(adapter => adapter.binding()), ...(options.csvInputDirectory ? [CSV_BINDING] : []), ...(sandbox ? [{ ...SANDBOX_BINDING, configurationDigest: sandbox.configurationDigest }] : []), ...(options.documentEnabled ? [DOCUMENT_BINDING] : [])],
    [new BriefAdapter(), ...domainProviders.map(p => new DomainServiceAdapter(p)), ...ucp, ...(options.csvInputDirectory ? [new CsvAuditAdapter(options.csvInputDirectory)] : []), ...(sandbox ? [sandbox] : []), ...(options.documentEnabled ? [new DocumentAdapter(options.documentExecutor)] : [])],
    [], [...(calendar ? [calendar] : []), ...(personalCalendar ? [personalCalendar] : []), ...(registration ? [registration] : []), ...meituan, ...(didi ? [didi] : []), ...(shopify ? [shopify] : []), ...(commerce ? [commerce] : []), ...(stripe ? [stripe] : []), ...(booking ? [booking] : [])]);
}
