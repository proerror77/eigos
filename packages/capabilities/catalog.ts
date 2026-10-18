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

export function createExecutionCatalog(options: { store?: JobStore; csvInputDirectory?: string; documentEnabled?: boolean; documentExecutor?: Executor; paotuiSkillDirectory?: string; ontologyAuditPath?: string; sandbox?: { endpoint: string; tokenFile: string } } = {}): ExecutionCatalog {
  const paotui = options.paotuiSkillDirectory ? new OntologyMcpPaotuiReader(options.paotuiSkillDirectory, options.ontologyAuditPath) : undefined;
  const sandbox = options.sandbox ? new SandboxServiceAdapter(options.sandbox.endpoint, options.sandbox.tokenFile) : undefined;
  if (paotui && !options.store) throw new Error('Address selection requires the owned persistent task store');
  const reads = PAOTUI_READ_CAPABILITIES.map((c, i) => ({ capability: c, binding: PAOTUI_READ_BINDINGS[i]!, i })).filter(x => x.i !== 1);
  return new ExecutionCatalog([BRIEF_CAPABILITY, ...(options.csvInputDirectory ? [CSV_CAPABILITY] : []), ...(options.sandbox ? [SANDBOX_CAPABILITY] : []), ...(options.documentEnabled ? [DOCUMENT_CAPABILITY] : []), ...(paotui ? [...reads.map(x => x.capability), DELIVERY_REQUEST_CAPABILITY] : [])],
    [BRIEF_BINDING, ...(options.csvInputDirectory ? [CSV_BINDING] : []), ...(sandbox ? [{ ...SANDBOX_BINDING, configurationDigest: sandbox.configurationDigest }] : []), ...(options.documentEnabled ? [DOCUMENT_BINDING] : []), ...(paotui ? [...reads.map(x => x.binding), DELIVERY_REQUEST_BINDING].map(b => ({ ...b, configurationDigest: paotui.configurationDigest })) : [])],
    [new BriefAdapter(), ...(options.csvInputDirectory ? [new CsvAuditAdapter(options.csvInputDirectory)] : []), ...(sandbox ? [sandbox] : []), ...(options.documentEnabled ? [new DocumentAdapter(options.documentExecutor)] : []), ...(paotui ? [...reads.map(x => new PaotuiReadAdapter(x.i, paotui)), new PaotuiRequestAdapter(paotui, options.store!, paotui.configurationDigest)] : [])]);
}
