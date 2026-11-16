interface SandboxConfiguration {
  EIGOS_AUTH_MODE?: string;
  EIGOS_AGENT_SANDBOX_ENABLED?: string;
  HOST?: string;
  NODE_ENV?: string;
}

/** Sandbox capabilities are available only in an explicitly enabled loopback development runtime. */
export function developmentSandboxEnabled(config: SandboxConfiguration = process.env): boolean {
  return config.EIGOS_AGENT_SANDBOX_ENABLED === 'true' && config.EIGOS_AUTH_MODE === 'development'
    && config.NODE_ENV !== 'production' && ['127.0.0.1', 'localhost'].includes(config.HOST ?? '127.0.0.1');
}
