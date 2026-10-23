import { loadMcpReadModule, mcpReadModuleRef } from './mcp-read.js';
export const meituanReadDefinition = loadMcpReadModule(new URL('../../ontology/meituan-readonly.json', import.meta.url));
export const meituanReadDefinitionRef = mcpReadModuleRef(meituanReadDefinition);
