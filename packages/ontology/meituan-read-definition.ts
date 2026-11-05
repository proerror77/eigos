import { parseBundledMcpReadModule, mcpReadModuleRef } from './mcp-read.js';
import definition from './definitions/meituan-readonly.json' with { type: 'json' };
export const meituanReadDefinition = parseBundledMcpReadModule(definition);
export const meituanReadDefinitionRef = mcpReadModuleRef(meituanReadDefinition);
