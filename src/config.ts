import * as fs from 'fs';
import * as path from 'path';

export interface ServiceConfig {
  name: string;
  /** Folder relative to the repo root. */
  cwd: string;
  cmd: string;
  /** Port in the main repo; worktree N uses basePort + N. */
  basePort: number;
  /** Extra env vars. `${port}` is this service's port, `${port:<name>}` another service's. Default: { PORT: "${port}" }. */
  env?: Record<string, string>;
  healthPath?: string;
}

export interface Config {
  /** Paths (relative to the repo root) shared from the main repo into every worktree. */
  shared: string[];
  services: ServiceConfig[];
}

export const CONFIG_FILE = '.gitdeck.json';

const SHARED_NAMES = new Set(['node_modules', '.venv', 'venv']);
const ENV_FILE = /^\.env(\..+)?$/;

export function loadConfig(mainRoot: string): Config {
  const file = path.join(mainRoot, CONFIG_FILE);
  let raw: Partial<Config> = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`${CONFIG_FILE} is not valid JSON: ${(e as Error).message}`);
    }
  }
  return { shared: raw.shared ?? detectShared(mainRoot), services: raw.services ?? [] };
}

/** node_modules / venvs / .env files in the repo root and its direct subfolders. */
export function detectShared(mainRoot: string): string[] {
  const found: string[] = [];
  const scan = (rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(mainRoot, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = rel ? `${rel}/${ent.name}` : ent.name;
      if (SHARED_NAMES.has(ent.name) || ENV_FILE.test(ent.name)) found.push(p);
      else if (!rel && ent.isDirectory() && !ent.name.startsWith('.')) scan(p);
    }
  };
  scan('');
  return found;
}

/** Starting point for .gitdeck.json: every folder with a dev/start script becomes a service. */
export function templateConfig(mainRoot: string): Config {
  const services: ServiceConfig[] = [];
  const dirs = ['', ...fs.readdirSync(mainRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
    .map((d) => d.name)];
  for (const dir of dirs) {
    let scripts: Record<string, string> = {};
    try {
      scripts = JSON.parse(fs.readFileSync(path.join(mainRoot, dir, 'package.json'), 'utf8')).scripts ?? {};
    } catch {
      continue;
    }
    const script = scripts.dev ? 'dev' : scripts.start ? 'start' : undefined;
    if (!script) continue;
    services.push({
      name: dir || path.basename(mainRoot),
      cwd: dir || '.',
      cmd: `npm run ${script}`,
      basePort: 3000 + services.length * 1000,
      env: { PORT: '${port}' },
      healthPath: '/',
    });
  }
  return { shared: detectShared(mainRoot), services };
}
