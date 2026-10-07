import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const DEP_FILES = ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'];

function readOrUndefined(file: string): Buffer | undefined {
  try {
    return fs.readFileSync(file);
  } catch {
    return undefined;
  }
}

function sameDeps(dirA: string, dirB: string): boolean {
  return DEP_FILES.every((f) => {
    const a = readOrUndefined(path.join(dirA, f));
    const b = readOrUndefined(path.join(dirB, f));
    return a === b || (a !== undefined && b !== undefined && a.equals(b));
  });
}

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function cp(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile('cp', args, (err) => (err ? reject(err) : resolve())));
}

/** Copy-on-write clone where the filesystem supports it (APFS / reflink), plain copy otherwise. */
async function cloneDir(src: string, dst: string): Promise<void> {
  try {
    await cp(process.platform === 'darwin' ? ['-cR', src, dst] : ['-R', '--reflink=auto', src, dst]);
  } catch {
    fs.rmSync(dst, { recursive: true, force: true });
    await cp(['-R', src, dst]);
  }
}

/**
 * Symlink each shared path from the main repo into the worktree. A node_modules whose
 * package.json / lockfile differ from the main repo is cloned instead, so installing
 * in this branch can't break the others. Returns notes for anything that wasn't linked.
 */
export async function linkShared(mainRoot: string, worktree: string, entries: string[]): Promise<string[]> {
  const notes: string[] = [];
  for (const entry of entries) {
    const src = path.join(mainRoot, entry);
    const dst = path.join(worktree, entry);
    if (!fs.existsSync(src) || lexists(dst) || !fs.existsSync(path.dirname(dst))) continue;
    if (path.basename(entry) === 'node_modules' && !sameDeps(path.dirname(src), path.dirname(dst))) {
      await cloneDir(src, dst);
      notes.push(`${entry}: dependencies differ from the main repo, so it was copied instead of shared. Run install in ${path.dirname(entry)}.`);
    } else {
      fs.symlinkSync(src, dst);
    }
  }
  return notes;
}
