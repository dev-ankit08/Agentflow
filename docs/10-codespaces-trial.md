# Run a free AgentFlow trial on GitHub Codespaces

Codespaces runs the whole app (database, API, builder, demo model and orders server) in a cloud machine you open
from the browser. Nothing is installed on your own computer, so no admin rights are needed. Testers get a public
link and sign in with their own email plus a shared trial access code.

> Free personal GitHub accounts include a monthly allowance of Codespaces hours (about 60 hours on the 2-core
> machine this uses) and storage. Check your current allowance under GitHub → Settings → Billing before a long trial.

## 1. Create the codespace (once, about 10 minutes)

1. Open the repository on GitHub (`dev-ankit08/Agentflow`) and switch to the branch you want to trial.
2. Click **Code → Codespaces → Create codespace on <branch>**.
3. Wait while it installs and builds (the terminal shows progress). When it finishes, the app starts by itself and
   the terminal prints:

   ```
   AgentFlow is running.
     Link to share:      https://<your-codespace>-3100.app.github.dev
     Trial access code:  abcd23efgh
   ```

## 2. Make the link public

The script tries to do this for you. If it says "Make the link public":

1. Open the **Ports** tab (next to Terminal).
2. Right-click port **3100 · AgentFlow (share this)** → **Port Visibility → Public**.
3. Do the same for port **4000 · AgentFlow API (widget)**. The website widget and live co-editing use it.

Private ports only work for you while signed in to GitHub; public ports work for anyone with the link.

## 3. Sign in and invite testers

- Share the **link** and the **trial access code**. Each tester enters their own work email and the code, then
  names their organization. Everyone gets their own workspace.
- To use the demo workspace (Order support and the other seeded flows) yourself, sign in as
  `demo@agentflow.local` with the code.
- To choose your own code (and keep it across new codespaces), add a Codespaces secret named `TRIAL_ACCESS_CODE`
  (GitHub → Settings → Codespaces → Secrets, at least 8 characters) before creating the codespace.

## 4. Add a real model

Until a model key is added, replies come from the bundled mock model. Each workspace adds its own key in
**Settings → Model provider keys** (see the User Guide), then picks the model on each AI step. If you share your
own key, set a monthly budget in **Settings → Budget and ROI baseline** first.

## Day to day

- **Stops when idle.** A codespace stops after a period without activity (30 minutes by default; up to 4 hours in
  GitHub → Settings → Codespaces → Default idle timeout). The link stops working while it is stopped. Data is kept.
- **Start it again:** open github.com/codespaces and click the codespace. The app restarts by itself; if not, run
  `bash .devcontainer/start.sh` in the terminal. The link stays the same; port visibility may need setting again.
- **After pulling new code:** run `corepack pnpm install && corepack pnpm build`, then `bash .devcontainer/start.sh`.
- **Logs:** `.data/logs/<service>.log` (builder, api, worker, db, mock-llm, demo-mcp).
- **Delete it** from github.com/codespaces when the trial ends; that deletes its data too.

## What to know before sharing

- The trial access code is the only gate, and emails are not verified: anyone with the code can sign in as any
  email address, including the demo account. Share it only with people you trust. If it leaks, change
  `TRIAL_ACCESS_CODE` in `.env` (or the Codespaces secret, which wins) and run `bash .devcontainer/start.sh`.
- `ALLOW_PRIVATE_HTTP` is on so the demo model and orders server work; flows can call addresses inside the
  codespace. Fine for a trial, not for production.
- One small machine serves everyone: fine for a handful of testers, not for load. For an always-on trial or
  production, deploy with `infra/` on a server with real sign-in (Google or email) instead.
