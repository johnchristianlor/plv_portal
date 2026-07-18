import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const publicDir = path.join(root, 'public');
const htmlFiles = fs.readdirSync(publicDir)
  .filter((name) => name.endsWith('.html'));

function read(file) {
  return fs.readFileSync(path.join(publicDir, file), 'utf8');
}

function localTarget(raw) {
  const value = raw.split('#')[0].split('?')[0].trim();
  if (!value || value.includes('${') ||
      /^(?:https?:|mailto:|tel:|javascript:|data:)/i.test(value)) {
    return null;
  }
  return value.replace(/^\.\//, '');
}

test('all local page, script, and stylesheet references resolve', () => {
  const missing = [];
  for (const file of htmlFiles) {
    const source = read(file);
    const references = [
      ...source.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi),
    ];
    for (const match of references) {
      const target = localTarget(match[1]);
      if (!target || target === '#') continue;
      const resolved = path.resolve(publicDir, target);
      if (!resolved.startsWith(publicDir) || !fs.existsSync(resolved)) {
        missing.push(`${file}: ${match[1]}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('inline button handlers resolve to executable functions', () => {
  const ignored = new Set([
    'alert', 'confirm', 'setTimeout', 'clearTimeout', 'getElementById',
    'if', 'querySelector', 'querySelectorAll', 'add', 'remove', 'toggle', 'click',
  ]);
  const missing = [];
  for (const file of htmlFiles) {
    let source = read(file);
    for (const scriptMatch of source.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
      const target = localTarget(scriptMatch[1]);
      if (target && fs.existsSync(path.join(publicDir, target))) {
        source += `\n${read(target)}`;
      }
    }
    for (const match of source.matchAll(/onclick\s*=\s*["']([^"']+)["']/gi)) {
      const expression = match[1];
      const call = expression.match(/(?:window\.)?([A-Za-z_$][\w$]*)\s*\(/);
      if (!call || ignored.has(call[1])) continue;
      const name = call[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const definition = new RegExp(
        `(?:function\\s+${name}\\s*\\(|window\\.${name}\\s*=|(?:const|let|var)\\s+${name}\\s*=)`,
      );
      if (!definition.test(source)) missing.push(`${file}: ${call[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('admin and student navigation stays complete and consistent', () => {
  const adminPages = htmlFiles.filter((name) => name.startsWith('admin-'));
  const studentPages = htmlFiles.filter((name) => name.startsWith('student-'));
  const adminTargets = [
    'admin-dashboard.html', 'admin-records.html', 'admin-sections.html',
    'admin-subjects.html', 'admin-schedule.html', 'admin-accounts.html',
    'admin-activities.html', 'admin-grades.html', 'admin-attendance.html',
    'admin-settings.html',
  ];
  const studentTargets = [
    'student-dashboard.html', 'student-scores.html', 'student-grades.html',
    'student-attendance.html', 'student-settings.html',
  ];
  for (const file of adminPages) {
    const source = read(file);
    for (const target of adminTargets) assert.match(source, new RegExp(target));
  }
  for (const file of studentPages) {
    const source = read(file);
    for (const target of studentTargets) assert.match(source, new RegExp(target));
  }
});

test('portal logout closes the shared Supabase Auth session', () => {
  const portalPages = htmlFiles.filter((name) =>
    /^(?:admin|student)-/.test(name)
  );
  const incomplete = portalPages.filter((file) => {
    const source = read(file);
    return !source.includes('supabase.auth.signOut()');
  });
  assert.deepEqual(incomplete, []);
});
