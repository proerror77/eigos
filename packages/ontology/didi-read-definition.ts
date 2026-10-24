import { loadMcpReadModule, mcpReadModuleRef } from './mcp-read.js';

// One editable definition source; builds package the same validated bytes.
export const didiReadDefinition = loadMcpReadModule(new URL('./definitions/didi-readonly.json', import.meta.url));
export const didiReadDefinitionRef = mcpReadModuleRef(didiReadDefinition);
