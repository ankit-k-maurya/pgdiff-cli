#!/usr/bin/env node
/**
 * Run several long-lived commands side by side, on any platform.
 *
 *   node scripts/run-parallel.mjs "npm run dev -w @pgdiff/server" "npm run dev -w @pgdiff/web"
 *
 * The shell one-liner this replaces (`trap 'kill 0' EXIT INT; a & b`) only works
 * in POSIX shells, and npm runs scripts through cmd.exe on Windows.
 *
 * Output is inherited, so the commands interleave on this terminal. The first
 * one to exit takes the others down with it, and Ctrl-C stops the whole set, so
 * no watcher is ever left running in the background.
 */
import { spawn } from 'node:child_process';

const commands = process.argv.slice(2);
if (commands.length === 0) {
  console.error('usage: run-parallel.mjs <command> [command ...]');
  process.exit(1);
}

let stopping = false;

/**
 * `child.kill()` only signals the shell we spawned, not the tools underneath it;
 * on Windows nothing else reaches the grandchildren, so ask Windows for the tree.
 */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

const children = commands.map((command) =>
  spawn(command, { stdio: 'inherit', shell: true }),
);

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) killTree(child);
  process.exitCode = code;
}

children.forEach((child, index) => {
  child.on('error', (error) => {
    console.error(`${commands[index]}: ${error.message}`);
    shutdown(1);
  });
  // A dev command that exits on its own has failed, or was interrupted; either
  // way the rest of the set is no longer useful. npm reports a signalled script
  // as 130/143 rather than as a signal, so those count as an interruption too.
  child.on('exit', (code, signal) => {
    const interrupted = Boolean(signal) || code === 130 || code === 143;
    if (!stopping && !interrupted) {
      console.error(`${commands[index]} exited with code ${code}`);
    }
    shutdown(interrupted ? 0 : (code ?? 0));
  });
});

// Ctrl-C is an ordinary way to stop a dev server, so it is not a failure.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}
