// Auth0 matches this native client's callback port exactly. Codex must bind
// the same per-server listener instead of selecting an ephemeral port.
export const INVITE_BETA_MCP_CALLBACK_PORT = 64517;
export const INVITE_BETA_MCP_CALLBACK_URL = `http://127.0.0.1:${INVITE_BETA_MCP_CALLBACK_PORT}/callback`;
export const GROK_MCP_CALLBACK_URL = 'https://www.cursor.com/agents/mcp/oauth/callback';

export function inviteBetaCodexConfig(publicUrl: string, clientId: string): string {
  return `[mcp_servers.eigos]\nurl = ${JSON.stringify(publicUrl + '/mcp')}\n\n[mcp_servers.eigos.oauth]\nclient_id = ${JSON.stringify(clientId)}\ncallback_url = ${JSON.stringify(INVITE_BETA_MCP_CALLBACK_URL)}\ncallback_port = ${INVITE_BETA_MCP_CALLBACK_PORT}`;
}
