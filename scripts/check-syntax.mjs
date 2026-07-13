import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = process.cwd();
const files = [];
function walk(dir){ for(const item of fs.readdirSync(dir,{withFileTypes:true})){ if(item.name==='.git'||item.name==='node_modules') continue; const full=path.join(dir,item.name); if(item.isDirectory()) walk(full); else if(/\.js$|\.mjs$/.test(item.name)) files.push(full); }}
walk(root);
let ok = true;
for (const file of files) {
  try { execFileSync(process.execPath, ['--check', file], { stdio:'pipe' }); }
  catch (e) { ok=false; console.error('Syntax failed:', path.relative(root,file)); console.error(String(e.stderr||e.message)); }
}
if (!ok) process.exit(1);
console.log('Syntax check passed for', files.length, 'JavaScript files.');
