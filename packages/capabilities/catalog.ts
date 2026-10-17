import { ExecutionCatalog } from '../core/catalog.js';
import { BRIEF_CAPABILITY, BRIEF_BINDING, BriefAdapter } from './brief.js';
import { CSV_CAPABILITY, CSV_BINDING, CsvAuditAdapter } from './csv-audit.js';
import { OfficialMcdTransport, type McdTransport } from './mcd/transport.js';
import { MCD_PICKUP_CAPABILITY, McdSupplySource, McdQuoteAdapter } from './mcd/supply.js';
import { SANDBOX_CAPABILITY, SANDBOX_BINDING, SandboxServiceAdapter } from './sandbox-service.js';
import { DocumentAdapter, DOCUMENT_CAPABILITY, DOCUMENT_BINDING } from './document.js';
import type { Executor } from './executor.js';
import { LocalPaotuiReader } from './paotui.js';
import { PAOTUI_READ_BINDINGS, PAOTUI_READ_CAPABILITIES, PaotuiReadAdapter } from './paotui-read.js';

export function createExecutionCatalog(options: { csvInputDirectory?: string; mcdTokenFile?: string; mcdTransport?: McdTransport; documentEnabled?: boolean; documentExecutor?: Executor; paotuiSkillDirectory?: string; sandbox?: { endpoint: string; tokenFile: string } } = {}): ExecutionCatalog {
  const mcd = options.mcdTransport ?? (options.mcdTokenFile ? new OfficialMcdTransport(options.mcdTokenFile) : undefined);
  const paotui = options.paotuiSkillDirectory ? new LocalPaotuiReader(options.paotuiSkillDirectory, false) : undefined;
  const sandbox = options.sandbox ? new SandboxServiceAdapter(options.sandbox.endpoint, options.sandbox.tokenFile) : undefined;
  return new ExecutionCatalog([BRIEF_CAPABILITY, ...(options.csvInputDirectory ? [CSV_CAPABILITY] : []), ...(mcd ? [MCD_PICKUP_CAPABILITY] : []), ...(options.sandbox ? [SANDBOX_CAPABILITY] : []), ...(options.documentEnabled ? [DOCUMENT_CAPABILITY] : []), ...(paotui ? PAOTUI_READ_CAPABILITIES : [])],
    [BRIEF_BINDING, ...(options.csvInputDirectory ? [CSV_BINDING] : []), ...(sandbox ? [{ ...SANDBOX_BINDING, configurationDigest: sandbox.configurationDigest }] : []), ...(options.documentEnabled ? [DOCUMENT_BINDING] : []), ...(paotui ? PAOTUI_READ_BINDINGS : [])],
    [new BriefAdapter(), ...(options.csvInputDirectory ? [new CsvAuditAdapter(options.csvInputDirectory)] : []), ...(mcd ? [new McdQuoteAdapter(mcd)] : []), ...(sandbox ? [sandbox] : []), ...(options.documentEnabled ? [new DocumentAdapter(options.documentExecutor)] : []), ...(paotui ? PAOTUI_READ_CAPABILITIES.map((_c, i) => new PaotuiReadAdapter(i, paotui)) : [])],
    mcd ? [new McdSupplySource(mcd)] : []);
}
