// Runs ONLY commands declared in workspace.yaml (no shell, no user-supplied commands).
import { spawn } from 'node:child_process';
import { redact } from './safety.js';

export function runCheck(repo, checkName, timeoutSec) {
  const cmd = repo.checks[checkName];
  if (!Array.isArray(cmd) || !cmd.length) {
    return Promise.resolve({ ok: false, output: `No check "${checkName}" defined for ${repo.name}. Defined: ${Object.keys(repo.checks).join(', ') || 'none'}` });
  }
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd: repo.path, shell: false, env: process.env });
    let out = '';
    const add = (d) => { out += d.toString(); if (out.length > 200000) out = out.slice(-100000); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => { child.kill('SIGTERM'); out += `\n[timed out after ${timeoutSec}s]`; }, timeoutSec * 1000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: `Could not start ${cmd[0]}: ${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Return only the tail: enough to see failures, without flooding the model's context.
      const tail = out.split('\n').slice(-60).join('\n');
      resolve({ ok: code === 0, output: `$ ${cmd.join(' ')}\nexit ${code}\n${redact(tail)}` });
    });
  });
}
