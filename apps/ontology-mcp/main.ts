import { closeSync, constants, openSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { LocalPaotuiReader } from '../../packages/capabilities/paotui.js';
import { createPaotuiOntologyServer } from '../../packages/capabilities/paotui-mcp-server.js';

const directory = process.env.EIGOS_PAOTUI_SKILL_DIR;
const audit = process.env.EIGOS_ONTOLOGY_AUDIT_PATH;
if (!directory || !isAbsolute(directory) || (audit && !isAbsolute(audit))) throw new Error('Ontology MCP requires absolute private local paths');
const calls: string[] = [];
const reader = new LocalPaotuiReader(directory, command => calls.push(command));
const server = createPaotuiOntologyServer(reader, {
  evidenceKind: 'live_readonly', sourceCalls: () => calls.splice(0),
  record: audit ? receipt => {
    const file = openSync(audit, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeSync(file, JSON.stringify(receipt) + '\n'); } finally { closeSync(file); }
  } : undefined,
});
await server.connect(new StdioServerTransport());
