# Fork Setup — maw-js

## Prerequisites
- [Bun](https://bun.sh) v1.1+
- [tmux](https://github.com/tmux/tmux) 3.0+
- [PM2](https://pm2.keymetrics.io/) (optional, for process management)
- [direnv](https://direnv.net/) (optional, for auto-env)

## Quick Start

1. **Clone and install**
   ```bash
   git clone <your-fork-url>
   cd maw-js
   bun install
   ```

2. **Configure**
   ```bash
   cp maw.config.example.json maw.config.json
   cp .envrc.example .envrc
   cp ecosystem.config.example.cjs ecosystem.config.cjs
   ```

   Edit `maw.config.json`:
   - `node`: your node name (used in federation)
   - `githubOrgs`: your GitHub org(s)
   - `dashboardUrl`: where the dashboard is served
   - `commands.default`: your Claude command
   - `namedPeers`: federation peers (optional)

3. **Set up fleet**
   ```bash
   # Copy and customize the example fleet files
   cp fleet/01-oracle.example.json fleet/01-bob.json
   cp fleet/02-oracle.example.json fleet/02-dev.json
   # Edit each file with your oracle names and repos
   ```

   Fleet file format:
   ```json
   {
     "name": "01-bob",
     "windows": [{"name": "BoB-Oracle", "repo": "YourOrg/BoB-Oracle"}],
     "sync_peers": []
   }
   ```

4. **Build**
   ```bash
   bun run build
   ```

5. **Run**
   ```bash
   # Direct
   bun src/server.ts

   # With PM2
   pm2 start ecosystem.config.cjs
   ```

6. **Federation** (optional)
   Add peers to `maw.config.json`:
   ```json
   "namedPeers": [{"name": "peer-name", "url": "http://peer-ip:3456"}],
   "federationToken": "shared-secret"
   ```

## Verify — Zero Data Leak Check

Before sharing your fork:
```bash
git grep -i 'iagencyaia\|petzdeals\|vuttipipat\|bankvutti' -- ':!FORK-SETUP.md'
```
Expected output: empty (0 matches).

## Building the Dashboard

The office/ directory contains the tmux dashboard (bubbles, tap-anywhere expand, live-activity, etc.).

```bash
cd office
bun install
bun run build    # outputs to dist-office/
```

Run the dashboard server alongside maw:
```bash
bun src/serve-bob.ts   # serves dist-office/ on port 3457
```

The dashboard reads `githubOrgs` from `/api/config` for ticket links. Set this in your `maw.config.json`.

## About docs/

The `docs/` directory contains deployment guides from the original installation.
These reference specific paths, domains, and org names from the original setup.
Adapt paths and org names to your environment when following these guides.
