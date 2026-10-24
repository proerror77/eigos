import { loadMcpReadModule, mcpReadModuleRef } from './mcp-read.js';
export const meituanReadDefinition = loadMcpReadModule(new URL('./definitions/meituan-readonly.json', import.meta.url));
export const meituanReadDefinitionRef = mcpReadModuleRef(meituanReadDefinition);
