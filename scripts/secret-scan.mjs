import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const patterns = [
  /\bsb_secret_[A-Za-z0-9._-]{20,}\b/,
  /\bservice_role_[A-Za-z0-9._-]{20,}\b/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
  /(?:B2_APPLICATION_KEY|TURSO_AUTH_TOKEN|CLOUDFLARE_API_TOKEN)\s*=\s*(?!YOUR_)[^\s<]+/i
];
const allowed = new Set(['.dev.vars.example','.env.example']);
const findings = [];
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git','node_modules'].includes(item.name)) continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walk(full);
    else {
      const rel = path.relative(root, full).replace(/\\/g, '/');
      const text = fs.readFileSync(full, 'utf8');
      patterns.forEach((re, i) => { if (re.test(text) && !allowed.has(rel)) findings.push({ file: rel, pattern: i }); });
    }
  }
}
walk(root);
if (findings.length) {
  console.error('Potential secret patterns found (values hidden):');
  findings.forEach(f => console.error('-', f.file, 'pattern', f.pattern));
  process.exit(1);
}
console.log('Secret scan passed for current files.');
