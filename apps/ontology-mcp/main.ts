import { DatabaseSync } from 'node:sqlite';
import { PersonalSourceAccess, personalSourceAdmitted } from '../../packages/core/personal-source.js';
import { closeSync, constants, openSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { LocalPaotuiReader } from '../../packages/capabilities/paotui.js';
import { createPaotuiOntologyServer } from '../../packages/capabilities/paotui-mcp-server.js';

const directory = process.env.EIGOS_PAOTUI_SKILL_DIR;
const audit = process.env.EIGOS_ONTOLOGY_AUDIT_PATH;
if (!directory || !isAbsolute(directory) || (audit && !isAbsolute(audit))) throw new Error('Ontology MCP requires absolute private local paths');
const connectionFile = process.env.EIGOS_PAOTUI_MEMBER_CONNECTION_FILE;
const expectedDigest = process.env.EIGOS_PAOTUI_CONNECTION_DIGEST;
const businessPath = process.env.EIGOS_SOURCE_DATABASE_PATH;
let sourceDb: DatabaseSync | undefined, access: PersonalSourceAccess | undefined;
if (connectionFile || expectedDigest || businessPath) {
  if (!connectionFile || !expectedDigest || !businessPath || !isAbsolute(businessPath)) throw new Error('Incomplete member source context');
  sourceDb = new DatabaseSync(businessPath, { readOnly: true });
  sourceDb.exec('PRAGMA busy_timeout=5000');
  access = new PersonalSourceAccess(connectionFile, (c, hash) => personalSourceAdmitted(sourceDb!, c, hash), directory);
  if (access.configurationDigest !== expectedDigest) throw new Error('Member source context changed');
  access.assert();
  process.on('exit', () => sourceDb?.close());
}
const calls: string[] = [];
const reader = new LocalPaotuiReader(directory, command => calls.push(command), access ? () => access!.assert() : undefined);
const server = createPaotuiOntologyServer(reader, {
  evidenceKind: 'live_readonly', allowedActions: access ? ['addresses', 'preview'] : undefined, sourceConnectionDigest: access?.configurationDigest, sourceCalls: () => calls.splice(0),
  record: audit ? receipt => {
    const file = openSync(audit, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeSync(file, JSON.stringify(receipt) + '\n'); } finally { closeSync(file); }
  } : undefined,
});
await server.connect(new StdioServerTransport());
