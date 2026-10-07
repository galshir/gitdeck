# GitDeck

A VS Code sidebar that lists your git branches. Click a branch to switch to it.

Each branch is opened as its own **git worktree**, so you can keep several branches checked out (and running) at the same time, without the usual worktree pain:

- **No `npm install` per branch.** `node_modules`, `.env*` and venvs are symlinked from the main repo. If a branch changes `package.json` or the lockfile, its `node_modules` is cloned instead (copy-on-write on macOS), so installing there can't break other branches.
- **No port clashes.** Every worktree gets its own port offset (main = base port, then +1, +2…).
- **Live status.** Start/stop the React app and backend per branch and see 🟢 running / ⏳ starting / 🔴 crashed.

## Usage

| Action | How |
|---|---|
| Switch to a branch | Click it (creates the worktree on first use) |
| Open in a new window | Window icon next to the branch |
| New branch | `+` in the view title (branches from the current one) |
| Start / stop services | ▶ / ■ next to the branch |
| Open in browser / logs | Globe / output icon next to a service |
| Remove worktree | Right-click → Remove Worktree… |

Worktrees are created in `<repo parent>/.gitdeck/<repo name>/<branch>` (setting `gitdeck.worktreesDir`).

## Config: `.gitdeck.json` in the repo root

Click the gear icon to generate one from the folders that have a `dev`/`start` script.

```json
{
  "shared": [".env", "client/node_modules", "server/node_modules"],
  "services": [
    { "name": "server", "cwd": "server", "cmd": "npm run dev", "basePort": 5000 },
    {
      "name": "client", "cwd": "client", "cmd": "npm start", "basePort": 3000,
      "env": { "PORT": "${port}", "REACT_APP_API_URL": "http://localhost:${port:server}" }
    }
  ]
}
```

- `shared`: optional, auto-detected when omitted (`node_modules`, `.env*`, `.venv` in the root and direct subfolders).
- `env`: `${port}` is the service's port in this worktree, `${port:<name>}` another service's. Default `{ "PORT": "${port}" }`.
- Services run detached with logs in `.gitdeck/<repo>/.logs`, so they keep running when you switch windows.

## Development

```sh
npm install
npm run compile   # then F5 to launch an Extension Development Host
npm run package   # builds gitdeck-<version>.vsix
```
