#!/usr/bin/env bun
// PM2 boot script — separate from cli.ts to avoid require() async module error.
// PM2's Bun container uses require() which fails on cli.ts's top-level imports.
export {};
const { cmdWakeAll } = await import("./commands/fleet");

const args = process.argv.slice(2);
await cmdWakeAll({
  kill: args.includes("--kill"),
  all: args.includes("--all"),
  resume: args.includes("--resume"),
  recapAll: args.includes("--recap-all"),
});
