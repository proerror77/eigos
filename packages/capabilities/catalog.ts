import { ExecutionCatalog } from '../core/catalog.js';
import { BRIEF_CAPABILITY, BRIEF_BINDING, BriefAdapter } from './brief.js';
import { CSV_CAPABILITY, CSV_BINDING, CsvAuditAdapter } from './csv-audit.js';
import { SANDBOX_CAPABILITY, SANDBOX_BINDING, SandboxServiceAdapter } from './sandbox-service.js';
import { DocumentAdapter, DOCUMENT_CAPABILITY, DOCUMENT_BINDING } from './document.js';
import type { Executor } from './executor.js';
import { OntologyMcpPaotuiReader } from './paotui-mcp.js';
import { PAOTUI_READ_BINDINGS, PAOTUI_READ_CAPABILITIES, PaotuiReadAdapter } from './paotui-read.js';

export function createExecutionCatalog(options: { csvInputDirectory?: string; documentEnabled?: boolean; documentExecutor?: Executor; paotuiSkillDirectory?: string; ontologyAuditPath?: string; sandbox?: { endpoint: string; tokenFile: string } } = {}): ExecutionCatalog {
  const paotui = options.paotuiSkillDirectory ? new OntologyMcpPaotuiReader(options.paotuiSkillDirectory, options.ontologyAuditPath) : undefined;
  const sandbox = options.sandbox ? new SandboxServiceAdapter(options.sandbox.endpoint, options.sandbox.tokenFile) : undefined;
  return new ExecutionCatalog([BRIEF_CAPABILITY, ...(options.csvInputDirectory ? [CSV_CAPABILITY] : []), ...(options.sandbox ? [SANDBOX_CAPABILITY] : []), ...(options.documentEnabled ? [DOCUMENT_CAPABILITY] : []), ...(paotui ? PAOTUI_READ_CAPABILITIES : [])],
    [BRIEF_BINDING, ...(options.csvInputDirectory ? [CSV_BINDING] : []), ...(sandbox ? [{ ...SANDBOX_BINDING, configurationDigest: sandbox.configurationDigest }] : []), ...(options.documentEnabled ? [DOCUMENT_BINDING] : []), ...(paotui ? PAOTUI_READ_BINDINGS.map(b => ({ ...b, configurationDigest: paotui.configurationDigest })) : [])],
    [new BriefAdapter(), ...(options.csvInputDirectory ? [new CsvAuditAdapter(options.csvInputDirectory)] : []), ...(sandbox ? [sandbox] : []), ...(options.documentEnabled ? [new DocumentAdapter(options.documentExecutor)] : []), ...(paotui ? PAOTUI_READ_CAPABILITIES.map((_c, i) => new PaotuiReadAdapter(i, paotui)) : [])]);
}
