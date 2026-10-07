import * as fs from 'fs';
import * as vscode from 'vscode';
import { ServiceConfig } from './config';
import { aggregate, serviceStatus, Status } from './health';
import { BranchInfo, Repo } from './repo';

export interface BranchNode {
  kind: 'branch';
  info: BranchInfo;
  current: boolean;
  active: boolean;
  status?: Status;
  services: ServiceNode[];
}

export interface ServiceNode {
  kind: 'service';
  branch: string;
  worktree: string;
  svc: ServiceConfig;
  port: number;
  status: Status;
}

export type Node = BranchNode | ServiceNode;

const STATUS_ICON: Record<Status, vscode.ThemeIcon> = {
  running: new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed')),
  starting: new vscode.ThemeIcon('loading~spin'),
  crashed: new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed')),
  stopped: new vscode.ThemeIcon('circle-outline'),
};

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function contextValue(flags: Record<string, boolean>): string {
  return ';' + Object.keys(flags).filter((k) => flags[k]).join(';') + ';';
}

export class BranchTree implements vscode.TreeDataProvider<Node> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  private nodes: BranchNode[] = [];
  private signature = '';
  private loading = false;
  error: string | undefined;

  constructor(private repo: Repo | undefined, private currentFolder: string | undefined) {}

  setRepo(repo: Repo | undefined): void {
    this.repo = repo;
    this.nodes = [];
    this.error = undefined;
    this.signature = '';
    this.changed.fire();
  }

  async reload(): Promise<void> {
    if (!this.repo || this.loading) return;
    this.loading = true;
    try {
      this.nodes = await this.load(this.repo);
      this.error = undefined;
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
    }
    const signature = JSON.stringify([this.error, this.nodes]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.changed.fire();
    }
  }

  private async load(repo: Repo): Promise<BranchNode[]> {
    const config = repo.config();
    const current = this.currentFolder && realpath(this.currentFolder);
    const nodes = await Promise.all(
      (await repo.branches()).map(async (info): Promise<BranchNode> => {
        const wt = info.worktree;
        let services: ServiceNode[] = [];
        if (wt && config.services.length) {
          const ports = repo.ports(wt, config);
          services = await Promise.all(
            config.services.map(async (svc) => ({
              kind: 'service' as const,
              branch: info.name,
              worktree: wt,
              svc,
              port: ports[svc.name],
              status: await serviceStatus(repo.runner.pid(wt, svc.name), ports[svc.name], svc.healthPath),
            })),
          );
        }
        return {
          kind: 'branch',
          info,
          current: !!wt && realpath(wt) === current,
          active: !!wt && repo.runner.isActive(wt),
          status: services.length ? aggregate(services.map((s) => s.status)) : undefined,
          services,
        };
      }),
    );
    // current branch first, then branches that already have a worktree, then the rest by recency
    const rank = (n: BranchNode) => (n.current ? 0 : n.info.worktree ? 1 : 2);
    return nodes.sort((a, b) => rank(a) - rank(b));
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.nodes;
    return node.kind === 'branch' ? node.services : [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node.kind === 'branch' ? this.branchItem(node) : this.serviceItem(node);
  }

  private branchItem(node: BranchNode): vscode.TreeItem {
    const { info, current, status } = node;
    const item = new vscode.TreeItem(
      info.name,
      node.services.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `branch:${info.name}`;

    if (status && status !== 'stopped') item.iconPath = STATUS_ICON[status];
    else if (current) item.iconPath = new vscode.ThemeIcon('check');
    else if (info.worktree) item.iconPath = new vscode.ThemeIcon('folder');
    else item.iconPath = new vscode.ThemeIcon('git-branch', new vscode.ThemeColor('disabledForeground'));

    const ports = node.services.map((s) => `:${s.port}`).join(' ');
    item.description = [current ? 'current' : '', ports || (info.worktree ? '' : info.updated)].filter(Boolean).join(' · ');

    const tooltip = new vscode.MarkdownString(`**${info.name}**\n\n`);
    tooltip.appendMarkdown(info.worktree ? `\`${info.worktree}\`` : 'No worktree yet. Click to create one and switch to it.');
    tooltip.appendMarkdown(`\n\nLast commit ${info.updated}`);
    item.tooltip = tooltip;

    if (!current) item.command = { command: 'gitdeck.open', title: 'Switch to Branch', arguments: [node] };
    item.contextValue = contextValue({
      branch: true,
      current,
      other: !current,
      svc: node.services.length > 0,
      active: node.active,
      idle: !node.active,
      removable: !!info.worktree && !info.isMain && !current,
    });
    return item;
  }

  private serviceItem(node: ServiceNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.svc.name);
    item.id = `service:${node.branch}:${node.svc.name}`;
    item.iconPath = STATUS_ICON[node.status];
    item.description = `:${node.port} · ${node.status}`;
    item.tooltip = `${node.svc.cmd}\nin ${node.svc.cwd}\nhttp://localhost:${node.port}`;
    item.command = { command: 'gitdeck.showLogs', title: 'Show Logs', arguments: [node] };
    item.contextValue = contextValue({ service: true });
    return item;
  }
}
