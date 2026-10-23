import { closeSync, constants, openSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { LocalMeituanPrimitives } from '../../packages/capabilities/meituan-primitives.js';
import { createMeituanPrimitiveServer } from '../../packages/capabilities/meituan-mcp.js';

const directory = process.env.EIGOS_PAOTUI_SKILL_DIR;
const audit = process.env.EIGOS_ONTOLOGY_AUDIT_PATH;
if (!directory || !isAbsolute(directory) || (audit && !isAbsolute(audit))) throw new Error('Ontology MCP requires absolute private local paths');
const reader = new LocalMeituanPrimitives(directory);
const server = createMeituanPrimitiveServer(reader, audit ? receipt => {
  const file = openSync(audit, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeSync(file, JSON.stringify(receipt) + '\n'); } finally { closeSync(file); }
} : undefined);
await server.connect(new StdioServerTransport());
