import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_FILE, templateConfig } from './config';
import { currentBranch, isValidBranchName } from './git';
import { Repo } from './repo';
import { BranchNode, BranchTree, Node } from './tree';

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const settings = vscode.workspace.getConfiguration('gitdeck');
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const dirSetting = settings.get<string>('worktreesDir')?.replace(/^~(?=$|\/)/, os.homedir()) || undefined;

  const repos = new Map<string, Repo>();
  const repoAt = async (dir: string): Promise<Repo | undefined> => {
    try {
      const found = await Repo.open(dir, dirSetting);
      if (!repos.has(found.mainRoot)) repos.set(found.mainRoot, found);
      return repos.get(found.mainRoot);
    } catch {
      return undefined;
    }
  };

  // When the window is the repo (or one of its worktrees) we stay on it and switch in place.
  // When it's a parent folder like ~/repos, follow the active editor and open branches in a new window.
  const folderRepo = folder ? await repoAt(folder) : undefined;
  const pinned = !!folderRepo;
  await vscode.commands.executeCommand('setContext', 'gitdeck.pinned', pinned);

  let repo: Repo | undefined;
  const tree = new BranchTree(undefined, folder);
  const view = vscode.window.createTreeView('gitdeck.branches', { treeDataProvider: tree, showCollapseAll: true });
  ctx.subscriptions.push(view);

  const refresh = async () => {
    await tree.reload();
    view.message = tree.error ? `⚠ ${tree.error}` : undefined;
  };

  let configWatcher: vscode.Disposable | undefined;
  const setRepo = async (next: Repo | undefined) => {
    if (next?.mainRoot === repo?.mainRoot) return;
    repo = next;
    tree.setRepo(next);
    view.description = next ? path.basename(next.mainRoot) : undefined;
    await vscode.commands.executeCommand('setContext', 'gitdeck.ready', !!next);
    configWatcher?.dispose();
    if (next) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(next.mainRoot, CONFIG_FILE));
      const subs = [watcher.onDidChange(refresh), watcher.onDidCreate(refresh), watcher.onDidDelete(refresh)];
      configWatcher = vscode.Disposable.from(watcher, ...subs);
    }
    await refresh();
  };

  const followEditor = async (editor: vscode.TextEditor | undefined) => {
    if (pinned || editor?.document.uri.scheme !== 'file') return;
    const found = await repoAt(path.dirname(editor.document.uri.fsPath));
    if (found) await setRepo(found);
  };

  const register = (id: string, fn: (repo: Repo, ...args: any[]) => unknown) =>
    ctx.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: any[]) => {
        if (!repo) {
          vscode.window.showWarningMessage('GitDeck: open a file from a git repository, or choose one.');
          return;
        }
        try {
          await fn(repo, ...args);
        } catch (e) {
          vscode.window.showErrorMessage(`GitDeck: ${(e as Error).message}`);
        }
        await refresh();
      }),
    );

  const openWorktree = async (target: string, notes: string[], newWindow: boolean) => {
    if (notes.length) await vscode.window.showWarningMessage(notes.join('\n\n'), { modal: true });
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), {
      forceNewWindow: newWindow || !pinned,
    });
  };

  const switchTo = async (repo: Repo, node: BranchNode, newWindow: boolean) => {
    const { path: target, notes } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Preparing ${node.info.name}…` },
      () => repo.ensureWorktree(node.info.name),
    );
    await openWorktree(target, notes, newWindow);
  };

  const portOf = (node: Node) => (node.kind === 'service' ? node.port : node.services[0]?.port);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('gitdeck.chooseRepo', async () => {
      const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      const candidates = roots.flatMap((root) => [
        root,
        ...fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name)),
      ]);
      const gitDirs = candidates.filter((dir) => fs.existsSync(path.join(dir, '.git')));
      if (!gitDirs.length) {
        vscode.window.showInformationMessage('No git repositories found in this workspace.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        gitDirs.map((dir) => ({ label: path.basename(dir), description: dir })),
        { title: 'Choose Repository' },
      );
      if (pick) await setRepo(await repoAt(pick.description));
    }),
  );

  register('gitdeck.refresh', () => {});

  register('gitdeck.open', (repo, node: BranchNode) => switchTo(repo, node, false));

  register('gitdeck.openNewWindow', (repo, node: BranchNode) => switchTo(repo, node, true));

  register('gitdeck.newBranch', async (repo) => {
    const from = pinned ? folder! : repo.mainRoot;
    const base = await currentBranch(from);
    const input = await vscode.window.showInputBox({
      title: 'New Branch',
      prompt: `Creates a branch from "${base}" in its own worktree and switches to it`,
      placeHolder: 'feature/my-change',
      validateInput: async (v) =>
        !v.trim() || (await isValidBranchName(from, v.trim())) ? undefined : 'Not a valid branch name',
    });
    const name = input?.trim();
    if (!name) return;
    const { path: target, notes } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating ${name}…` },
      () => repo.ensureWorktree(name, base),
    );
    await openWorktree(target, notes, false);
  });

  register('gitdeck.start', (repo, node: BranchNode) => {
    repo.start(node.info.worktree!);
    setTimeout(refresh, 1500);
  });

  register('gitdeck.stop', (repo, node: BranchNode) => repo.runner.stop(node.info.worktree!));

  register('gitdeck.openBrowser', (_repo, node: Node) => {
    const port = portOf(node);
    if (port) return vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}`));
  });

  register('gitdeck.showLogs', (repo, node: Node) => {
    if (node.kind !== 'service') return;
    const file = repo.runner.logFile(node.worktree, node.svc.name);
    if (!fs.existsSync(file)) {
      vscode.window.showInformationMessage(`No logs for ${node.svc.name} yet. Start the services first.`);
      return;
    }
    const name = `${node.branch} · ${node.svc.name}`;
    vscode.window.terminals.find((t) => t.name === name)?.dispose();
    vscode.window.createTerminal({ name, shellPath: 'tail', shellArgs: ['-n', '300', '-f', file] }).show();
  });

  register('gitdeck.relink', async (repo, node: BranchNode) => {
    const notes = await repo.relink(node.info.worktree!);
    vscode.window.showInformationMessage(notes.length ? notes.join('\n') : `Shared files linked into ${node.info.name}.`);
  });

  register('gitdeck.remove', async (repo, node: BranchNode) => {
    const { name, worktree } = node.info;
    const choice = await vscode.window.showWarningMessage(
      `Remove the worktree of "${name}"?`,
      {
        modal: true,
        detail: `${worktree}\n\nRunning services are stopped. Shared node_modules/.env in the main repo are not touched. The branch itself is kept unless you also delete it.`,
      },
      'Remove Worktree',
      'Remove Worktree & Delete Branch',
    );
    if (!choice) return;
    try {
      await repo.removeWorktree(worktree!, false);
    } catch (e) {
      const force = await vscode.window.showWarningMessage(
        `"${name}" has uncommitted changes.`,
        { modal: true, detail: (e as Error).message },
        'Discard Changes & Remove',
      );
      if (!force) return;
      await repo.removeWorktree(worktree!, true);
    }
    if (choice !== 'Remove Worktree & Delete Branch') return;
    try {
      await repo.deleteBranch(name, false);
    } catch (e) {
      const force = await vscode.window.showWarningMessage(
        `"${name}" is not fully merged.`,
        { modal: true, detail: (e as Error).message },
        'Delete Anyway',
      );
      if (force) await repo.deleteBranch(name, true);
    }
  });

  register('gitdeck.openConfig', async (repo) => {
    const file = path.join(repo.mainRoot, CONFIG_FILE);
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(templateConfig(repo.mainRoot), null, 2) + '\n');
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  });

  const interval = setInterval(() => view.visible && refresh(), Math.max(1000, settings.get<number>('pollInterval') ?? 5000));
  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(followEditor),
    view.onDidChangeVisibility((e) => e.visible && refresh()),
    vscode.window.onDidChangeWindowState((e) => e.focused && refresh()),
    { dispose: () => clearInterval(interval) },
    { dispose: () => configWatcher?.dispose() },
  );

  if (folderRepo) await setRepo(folderRepo);
  else await followEditor(vscode.window.activeTextEditor);
}

export function deactivate(): void {}
