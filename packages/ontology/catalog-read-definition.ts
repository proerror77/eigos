import { parseBundledMcpReadModule, mcpReadModuleRef } from './mcp-read.js';
import definition from './definitions/shopify-catalog.json' with { type: 'json' };
export const catalogReadDefinition = parseBundledMcpReadModule(definition);
export const catalogReadDefinitionRef = mcpReadModuleRef(catalogReadDefinition);
