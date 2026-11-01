// Path and content safety: nothing outside allowed repos/knowledge dirs, no secrets, no .git.
import fs from 'node:fs';
import path from 'node:path';

// .env.example / .sample / .template / .dist are committed templates, not secrets.
export const SECRET_NAME = /(^|\/)(\.env(\.(?!(example|sample|template|dist)$)[^/]*)?|.*\.pem|.*\.p12|.*\.key|id_rsa.*|.*\.tfstate(\.backup)?|.*credentials.*\.json|GoogleService-Info\.plist|Config-.*\.plist|terraform\.tfvars)$/i;
const BLOCKED_DIR = /(^|\/)(\.git|node_modules|\.terraform|Pods|DerivedData|build|dist|\.venv|venv|__pycache__)(\/|$)/;
const SECRET_VALUE = /(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[0-9A-Za-z-]{10,}|ghp_[0-9A-Za-z]{36}|AIza[0-9A-Za-z_-]{35})/g;

/** Resolve a user-supplied relative path inside an allowed root. Throws on escape or blocked paths. */
export function safeResolve(root, rel) {
  const real = fs.realpathSync(root);
  const target = path.resolve(real, rel || '.');
  let resolved = target;
  try { resolved = fs.realpathSync(target); } catch { /* may not exist yet */ }
  const relPath = path.relative(real, resolved);
  if (relPath.startsWith('..') || path.isAbsolute(relPath)) throw new Error('Path is outside the allowed repository');
  if (BLOCKED_DIR.test(relPath)) throw new Error('Path is in a blocked directory');
  if (SECRET_NAME.test(relPath)) throw new Error('Path looks like a secret or state file and is not shared');
  return resolved;
}

export function isBlocked(relPath) {
  return BLOCKED_DIR.test(relPath) || SECRET_NAME.test(relPath);
}

export function redact(text) {
  return String(text).replace(SECRET_VALUE, '[REDACTED]');
}

export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'item';
