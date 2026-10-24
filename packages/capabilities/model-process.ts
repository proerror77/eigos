/** One policy for both bounded model transports. Gateway/provider credentials
 * never enter a model subprocess. Codex owns its existing authentication. */
export const modelFeatureArgs = Object.freeze(['shell_tool', 'apps', 'plugins', 'hooks', 'memories', 'multi_agent', 'multi_agent_v2', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'image_generation', 'code_mode'].flatMap(name => ['--disable', name]));
export function modelEnvironment() {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'CODEX_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
