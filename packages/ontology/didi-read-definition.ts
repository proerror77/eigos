import { parseBundledMcpReadModule, mcpReadModuleRef } from './mcp-read.js';
import definition from './definitions/didi-readonly.json' with { type: 'json' };

// One editable definition source; builds package the same validated bytes.
export const didiReadDefinition = parseBundledMcpReadModule(definition);
export const didiReadDefinitionRef = mcpReadModuleRef(didiReadDefinition);
