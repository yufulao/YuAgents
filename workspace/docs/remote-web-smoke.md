# Remote Web Smoke Test

Use this before deploying changes that affect the public/remote Web entry.
It simulates the production relay mode locally:

- workspace creation disabled
- workspace directory disabled
- existing workspace name/slug + token login only
- frontend talks to a remote-mode backend URL

## Windows

From the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File workspace\scripts\test-remote-web.ps1
```

Expected result:

```text
Remote-mode Web smoke passed.
remote smoke ports clean
```

The script starts temporary services on:

- backend: `127.0.0.1:18000`
- frontend: `localhost:13000`
- Chrome DevTools: `127.0.0.1:19225`

It seeds a temporary workspace in `workspace/.remote-web-test/workspace_remote_test.db`,
checks that a wrong token shows an explicit error, then checks that a correct
workspace name + token resolves to the canonical slug and loads the workbench.

Logs are written to `workspace/.remote-web-test/`.

Use `-KeepRunning` when debugging:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File workspace\scripts\test-remote-web.ps1 -KeepRunning
```

## Acceptance

Before a remote deploy, this smoke test must pass together with:

```powershell
python -m pytest workspace\backend\tests\test_workspaces.py -q
cd workspace\frontend
npx tsc --noEmit
npm run build
```
