import { loadMcpReadModule, mcpReadModuleRef } from './mcp-read.js';

// Source and built runtimes each carry a separate ontology data directory.
export const didiReadDefinition = loadMcpReadModule(new URL('../../ontology/didi-readonly.json', import.meta.url));
export const didiReadDefinitionRef = mcpReadModuleRef(didiReadDefinition);
