// Detect bun path: BUN_INSTALL env → which bun fallback → default
let bunPath;
try {
  bunPath = process.env.BUN_INSTALL
    ? process.env.BUN_INSTALL + '/bin/bun'
    : require('child_process').execSync('which bun', { encoding: 'utf-8' }).trim();
} catch {
  bunPath = 'bun';
}

module.exports = {
  apps: [
    {
      name: 'maw',
      script: 'src/server.ts',
      interpreter: bunPath,
      kill_timeout: 5000,
      listen_timeout: 10000,
      env: {
        MAW_HOST: 'local',
        MAW_PORT: '3456',
      },
    },
    {
      name: 'maw-boot',
      script: 'src/boot.ts',
      args: '--recap-all',
      interpreter: bunPath,
      // One-shot: spawn fleet after server starts, don't restart
      autorestart: false,
      // Give maw server time to come up
      restart_delay: 5000,
    },
    {
      name: 'maw-bob',
      script: 'src/serve-bob.ts',
      interpreter: bunPath,
      env: {
        BOB_PORT: '3457',
        MAW_PORT: '3456',
      },
    },
    {
      name: 'maw-syslog',
      script: 'src/syslog.ts',
      interpreter: bunPath,
      // Don't watch — long-running listener, restart only on crash
      max_restarts: 10,
      min_uptime: '5s',
      restart_delay: 3000,
    },
    {
      name: 'maw-dev',
      script: 'node_modules/.bin/vite',
      args: '--host',
      cwd: './office',
      interpreter: bunPath,
      env: {
        NODE_ENV: 'development',
      },
      // Only start manually: pm2 start ecosystem.config.cjs --only maw-dev
      autorestart: false,
    },
  ],
};
