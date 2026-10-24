import { loadMcpReadModule, mcpReadModuleRef } from './mcp-read.js';
export const catalogReadDefinition = loadMcpReadModule(new URL('./definitions/shopify-catalog.json', import.meta.url));
export const catalogReadDefinitionRef = mcpReadModuleRef(catalogReadDefinition);
