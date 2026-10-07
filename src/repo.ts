import * as fs from 'fs';
import * as path from 'path';
import { Config, loadConfig } from './config';
import { git, listBranches, listWorktrees } from './git';
import { Runner } from './runner';
import { linkShared } from './shared';
import { Store } from './state';

export interface BranchInfo {
  name: string;
  updated: string;
  worktree?: string;
  isMain: boolean;
}

export function slug(branch: string): string {
  return branch.replace(/[^\w.-]+/g, '-');
}

export class Repo {
  readonly store: Store;
  readonly runner: Runner;

  private constructor(readonly mainRoot: string, readonly dir: string) {
    this.store = new Store(dir);
    this.runner = new Runner(this.store, path.join(dir, '.logs'));
  }

  /** Works from the main repo or from any of its worktrees. */
  static async open(folder: string, worktreesDir?: string): Promise<Repo> {
    const [main] = await listWorktrees(folder);
    const mainRoot = main.path;
    return new Repo(mainRoot, worktreesDir || path.join(path.dirname(mainRoot), '.gitdeck', path.basename(mainRoot)));
  }

  config(): Config {
    return loadConfig(this.mainRoot);
  }

  async branches(): Promise<BranchInfo[]> {
    const [refs, worktrees] = await Promise.all([listBranches(this.mainRoot), listWorktrees(this.mainRoot)]);
    const byBranch = new Map(worktrees.filter((w) => w.branch).map((w) => [w.branch!, w.path]));
    return refs.map((r) => {
      const wt = byBranch.get(r.name);
      return { ...r, worktree: wt && fs.existsSync(wt) ? wt : undefined, isMain: wt === this.mainRoot };
    });
  }

  /** Returns the branch's worktree, creating it (and the branch, when `base` is given) if needed. */
  async ensureWorktree(branch: string, base?: string): Promise<{ path: string; notes: string[] }> {
    await git(this.mainRoot, ['worktree', 'prune']);
    if (!base) {
      const existing = (await listWorktrees(this.mainRoot)).find((w) => w.branch === branch);
      if (existing) return { path: existing.path, notes: [] };
    }
    const target = path.join(this.dir, slug(branch));
    if (fs.existsSync(target)) throw new Error(`${target} already exists`);
    fs.mkdirSync(this.dir, { recursive: true });
    await git(this.mainRoot, base ? ['worktree', 'add', '-b', branch, target, base] : ['worktree', 'add', target, branch]);
    return { path: target, notes: await this.relink(target) };
  }

  async relink(worktree: string): Promise<string[]> {
    const { shared } = this.config();
    await this.excludeFromGit(shared);
    return linkShared(this.mainRoot, worktree, shared);
  }

  /**
   * A symlinked node_modules is a file, not a folder, so `node_modules/` in .gitignore
   * doesn't cover it. Without this it shows as untracked and blocks `git worktree remove`.
   */
  private async excludeFromGit(entries: string[]): Promise<void> {
    const commonDir = path.resolve(this.mainRoot, (await git(this.mainRoot, ['rev-parse', '--git-common-dir'])).trim());
    const file = path.join(commonDir, 'info', 'exclude');
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const lines = new Set(current.split('\n'));
    const missing = entries.map((e) => '/' + e.replace(/\\/g, '/')).filter((l) => !lines.has(l));
    if (!missing.length) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const sep = current && !current.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(file, `${sep}# gitdeck shared links\n${missing.join('\n')}\n`);
  }

  async removeWorktree(worktree: string, force: boolean): Promise<void> {
    this.runner.stop(worktree);
    await git(this.mainRoot, ['worktree', 'remove', ...(force ? ['--force'] : []), worktree]);
    this.store.update((s) => {
      delete s.indexes[worktree];
      delete s.procs[worktree];
    });
  }

  async deleteBranch(name: string, force: boolean): Promise<void> {
    await git(this.mainRoot, ['branch', force ? '-D' : '-d', name]);
  }

  /** Stable per-worktree port offset; the main repo keeps the base ports. */
  portIndex(worktree: string): number {
    if (worktree === this.mainRoot) return 0;
    const known = this.store.read().indexes[worktree];
    if (known !== undefined) return known;
    return this.store.update((s) => {
      if (s.indexes[worktree] === undefined) {
        const used = new Set(Object.values(s.indexes));
        let n = 1;
        while (used.has(n)) n++;
        s.indexes[worktree] = n;
      }
      return s.indexes[worktree];
    });
  }

  ports(worktree: string, config = this.config()): Record<string, number> {
    const idx = this.portIndex(worktree);
    return Object.fromEntries(config.services.map((s) => [s.name, s.basePort + idx]));
  }

  start(worktree: string): void {
    const config = this.config();
    if (!config.services.length) throw new Error('No services configured. Add them in .gitdeck.json (gear icon).');
    this.runner.start(worktree, config.services, this.ports(worktree, config));
  }
}
