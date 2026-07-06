export function isAgentPane(cmd: string): boolean {
  const bare = (cmd || "").trim().toLowerCase().replace(/^-/, "");
  return bare !== "" && !/^(bash|zsh|fish|sh|ksh|csh|tcsh|login|tmux)$/.test(bare);
}
