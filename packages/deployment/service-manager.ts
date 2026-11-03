import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, isAbsolute } from 'node:path';

export const PRIMARY_SERVICE_LABEL = 'com.eigos.primary';
export const RETIRED_PRIMARY_LABELS = ['com.eigos.grok-life', 'com.eigos.invite-beta', 'com.eigos.shopify-checkout-private', 'com.eigos.member-network'] as const;
export interface PrimaryServiceInput {
  platform: 'darwin' | 'linux';
  runtime: string;
  release: string;
  node: string;
  modelBinary: string;
  home?: string;
  uid?: number;
  /** Internal composition seam; deployment always uses com.eigos.primary. */
  label?: string;
}
export type ServiceCommand = (binary: string, args: string[], env?: NodeJS.ProcessEnv, timeoutMs?: number) => string;
const command: ServiceCommand = (binary, args, env, timeoutMs = 15000) => execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, maxBuffer: 65536, ...(env ? { env } : {}) });

function safePath(value: string): string {
  if (!isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Service paths must be absolute and contain no control characters');
  return value;
}
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
/** Unit syntax is not a shell. Escape systemd specifiers separately from argv
 * environment expansion so a literal path cannot become a second directive. */
const unitValue = (value: string, argv = false): string => {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('Service values cannot contain control characters');
  const text = value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return '"' + (argv ? text.replaceAll('$', () => '$$') : text) + '"';
};
// WorkingDirectory and append paths are literal single-path directives, not
// command-line words. Quotes would become part of the path on systemd 255.
const unitPath = (value: string): string => {
  if (value.trimEnd() !== value || value.endsWith('\\')) throw new Error('Systemd paths cannot end in whitespace or a continuation character');
  return value.replaceAll('%', '%%');
};

export function primaryService(input: PrimaryServiceInput, run: ServiceCommand = command) {
  const home = safePath(input.home ?? homedir()), uid = input.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) throw new Error('A Unix service owner is required');
  if (input.platform === 'linux' && uid === 0) throw new Error('Run the Linux primary as a dedicated non-root service owner');
  const label = input.label ?? PRIMARY_SERVICE_LABEL;
  if (!/^com\.eigos\.[a-z0-9][a-z0-9.-]{0,90}$/.test(label)) throw new Error('Invalid owned EIGOS service label');
  for (const path of [input.runtime, input.release, input.node, input.modelBinary]) safePath(path);
  const envPath = join(input.runtime, 'server.env'), unit = label + '.service';
  const args = [input.node, '--env-file=' + envPath, join(input.release, 'scripts/run-local.mjs'), '--built'];
  const path = [dirname(input.node), dirname(input.modelBinary), join(home, '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin'].join(':');
  const serviceFile = input.platform === 'darwin' ? join(home, 'Library/LaunchAgents', label + '.plist') : join(home, '.config/systemd/user', unit);
  const busEnv = { ...process.env, XDG_RUNTIME_DIR: '/run/user/' + uid, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/' + uid + '/bus' };
  const systemctl = (...values: string[]) => run('systemctl', ['--user', ...values], busEnv);
  const active = (value: string) => ['active', 'activating', 'deactivating', 'reloading'].includes(value.trim());
  const state = (name: string, user: boolean) => {
    try { return run('systemctl', [...(user ? ['--user'] : []), 'show', name + '.service', '--property=ActiveState', '--value'], user ? busEnv : undefined); }
    catch (error) {
      const failed = error as { status?: number; stdout?: string | Buffer };
      if (failed.status === 4 || [1, 3].includes(failed.status ?? 0) && String(failed.stdout ?? '').trim() === 'inactive') return 'inactive';
      throw new Error('Cannot determine the systemd service state', { cause: error });
    }
  };

  function isLoaded(name = label): boolean {
    try {
      if (input.platform === 'darwin') { run('launchctl', ['print', 'gui/' + uid + '/' + name]); return true; }
      return active(state(name, true));
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (input.platform === 'darwin' || status === 3 || status === 4) return false;
      throw new Error('Cannot determine the owned systemd service state', { cause: error });
    }
  }
  function assertReady(): void {
    if (input.platform === 'linux') {
      if (run('loginctl', ['show-user', String(uid), '--property=Linger', '--value']).trim() !== 'yes')
        throw new Error('Enable systemd user lingering for this service owner before deployment');
      systemctl('show-environment');
      // A system-level installation must be retired explicitly before adding a
      // user-level primary; a user manager cannot silently replace its owner.
      for (const name of [PRIMARY_SERVICE_LABEL, ...RETIRED_PRIMARY_LABELS]) {
        if (active(state(name, false)))
          throw new Error('Stop the existing system-level EIGOS runtime before user-service deployment');
      }
    }
    if (RETIRED_PRIMARY_LABELS.some(name => isLoaded(name))) throw new Error('Stop retired formal profiles before installing the single primary authority');
  }
  function render(): string {
    if (input.platform === 'darwin') {
      const macPath = [dirname(input.node), dirname(input.modelBinary), join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');
      return '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>' + label
        + '</string><key>ProgramArguments</key><array>' + args.map(arg => '<string>' + xml(arg) + '</string>').join('')
        + '</array><key>WorkingDirectory</key><string>' + xml(input.release)
        + '</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>' + xml(macPath)
        + '</string></dict><key>ExitTimeOut</key><integer>60</integer><key>RunAtLoad</key><true/><key>KeepAlive</key><true/>'
        + '<key>StandardOutPath</key><string>' + xml(join(input.runtime, 'stdout.log'))
        + '</string><key>StandardErrorPath</key><string>' + xml(join(input.runtime, 'stderr.log')) + '</string></dict></plist>';
    }
    return [
      '[Unit]', 'Description=EIGOS owned Gateway and Worker primary', '',
      '[Service]', 'Type=exec', 'WorkingDirectory=' + unitPath(input.release),
      'ExecStart=' + args.map(arg => unitValue(arg, true)).join(' '), 'Environment=' + unitValue('PATH=' + path),
      'Restart=on-failure', 'RestartSec=2s', 'TimeoutStopSec=60s', 'KillMode=control-group', 'UMask=0077', 'NoNewPrivileges=true',
      'StandardOutput=append:' + unitPath(join(input.runtime, 'stdout.log')),
      'StandardError=append:' + unitPath(join(input.runtime, 'stderr.log')),
      '', '[Install]', 'WantedBy=default.target', '',
    ].join('\n');
  }
  return {
    label, serviceFile, envPath, manager: input.platform === 'darwin' ? 'launchd' as const : 'systemd-user' as const,
    render, isLoaded, assertReady,
    ownsConfiguration: (contents: string) => contents.includes(input.platform === 'darwin' ? '<string>' + xml('--env-file=' + envPath) + '</string>' : unitValue('--env-file=' + envPath, true)),
    stop: () => { if (isLoaded()) { if (input.platform === 'darwin') run('launchctl', ['bootout', 'gui/' + uid + '/' + label], undefined, 75000); else run('systemctl', ['--user', 'stop', unit], busEnv, 75000); } },
    start: () => {
      if (input.platform === 'darwin') { run('launchctl', ['enable', 'gui/' + uid + '/' + label]); run('launchctl', ['bootstrap', 'gui/' + uid, serviceFile]); }
      else { systemctl('daemon-reload'); systemctl('enable', unit); run('systemctl', ['--user', 'restart', unit], busEnv, 75000); }
    },
  };
}
