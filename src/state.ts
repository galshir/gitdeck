import * as fs from 'fs';
import * as path from 'path';

export interface State {
  /** worktree path -> port offset (main repo is always 0). */
  indexes: Record<string, number>;
  /** worktree path -> service name -> pid. */
  procs: Record<string, Record<string, number>>;
}

/** JSON file shared by every VS Code window of the same repo. */
export class Store {
  constructor(readonly dir: string) {}

  private get file(): string {
    return path.join(this.dir, 'state.json');
  }

  read(): State {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { indexes: s.indexes ?? {}, procs: s.procs ?? {} };
    } catch {
      return { indexes: {}, procs: {} };
    }
  }

  update<T>(fn: (s: State) => T): T {
    const s = this.read();
    const result = fn(s);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(s, null, 2));
    return result;
  }
}
