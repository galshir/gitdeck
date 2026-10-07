import { execFile } from 'child_process';

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

export interface Worktree {
  path: string;
  branch?: string;
}

/** The first entry is always the main worktree. */
export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  const out = await git(cwd, ['worktree', 'list', '--porcelain']);
  const list: Worktree[] = [];
  for (const block of out.split('\n\n')) {
    let wt: Worktree | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) wt = { path: line.slice('worktree '.length) };
      else if (line.startsWith('branch refs/heads/') && wt) wt.branch = line.slice('branch refs/heads/'.length);
    }
    if (wt) list.push(wt);
  }
  return list;
}

export async function listBranches(cwd: string): Promise<{ name: string; updated: string }[]> {
  const out = await git(cwd, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:lstrip=2)%09%(committerdate:relative)',
    'refs/heads',
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, updated] = line.split('\t');
      return { name, updated };
    });
}

export async function currentBranch(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

export async function isValidBranchName(cwd: string, name: string): Promise<boolean> {
  try {
    await git(cwd, ['check-ref-format', '--branch', name]);
    return true;
  } catch {
    return false;
  }
}
