import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ServiceConfig } from './config';
import { Store } from './state';

export function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function buildEnv(svc: ServiceConfig, ports: Record<string, number>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
  for (const [key, value] of Object.entries(svc.env ?? { PORT: '${port}' })) {
    env[key] = value.replace(/\$\{port(?::([\w-]+))?\}/g, (_, name?: string) => String(ports[name ?? svc.name]));
  }
  return env;
}

/**
 * Services run as detached process groups with output in log files, so they keep
 * running when the window switches to another worktree (which restarts the extension).
 */
export class Runner {
  constructor(private store: Store, private logDir: string) {}

  logFile(worktree: string, service: string): string {
    const id = createHash('sha1').update(worktree).digest('hex').slice(0, 6);
    return path.join(this.logDir, `${path.basename(worktree)}-${id}-${service}.log`);
  }

  pid(worktree: string, service: string): number | undefined {
    return this.store.read().procs[worktree]?.[service];
  }

  isActive(worktree: string): boolean {
    return Object.values(this.store.read().procs[worktree] ?? {}).some(alive);
  }

  start(worktree: string, services: ServiceConfig[], ports: Record<string, number>): void {
    fs.mkdirSync(this.logDir, { recursive: true });
    const pids: Record<string, number> = {};
    const errors: string[] = [];
    for (const svc of services) {
      if (alive(this.pid(worktree, svc.name))) continue;
      const cwd = path.resolve(worktree, svc.cwd);
      if (!fs.existsSync(cwd)) {
        errors.push(`${svc.name}: folder "${svc.cwd}" doesn't exist in this branch`);
        continue;
      }
      const out = fs.openSync(this.logFile(worktree, svc.name), 'w');
      const child = spawn(svc.cmd, {
        cwd,
        env: buildEnv(svc, ports),
        shell: true,
        detached: true,
        stdio: ['ignore', out, out],
      });
      fs.closeSync(out);
      child.on('error', () => {});
      child.unref();
      if (child.pid) pids[svc.name] = child.pid;
      else errors.push(`${svc.name}: failed to start "${svc.cmd}"`);
    }
    this.store.update((s) => {
      s.procs[worktree] = { ...s.procs[worktree], ...pids };
    });
    if (errors.length) throw new Error(errors.join('; '));
  }

  stop(worktree: string): void {
    for (const pid of Object.values(this.store.read().procs[worktree] ?? {})) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // already gone
        }
      }
    }
    this.store.update((s) => {
      delete s.procs[worktree];
    });
  }
}
