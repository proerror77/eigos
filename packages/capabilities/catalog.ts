import { ExecutionCatalog } from '../core/catalog.js';
import { BRIEF_CAPABILITY, BRIEF_BINDING, BriefAdapter } from './brief.js';
import { CSV_CAPABILITY, CSV_BINDING, CsvAuditAdapter } from './csv-audit.js';

export function createExecutionCatalog(options: { csvInputDirectory?: string } = {}): ExecutionCatalog {
  return new ExecutionCatalog([BRIEF_CAPABILITY, ...(options.csvInputDirectory ? [CSV_CAPABILITY] : [])],
    [BRIEF_BINDING, ...(options.csvInputDirectory ? [CSV_BINDING] : [])],
    [new BriefAdapter(), ...(options.csvInputDirectory ? [new CsvAuditAdapter(options.csvInputDirectory)] : [])]);
}
