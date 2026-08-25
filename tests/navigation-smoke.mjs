import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const publicDir = path.join(root, 'public');
const pages = fs.readdirSync(publicDir)
    .filter(file => file.endsWith('.html'))
    .filter(file => fs.readFileSync(path.join(publicDir, file), 'utf8').includes('mobile-nav-bar'));

assert.equal(pages.length >= 16, true, 'all admin and student portal pages should be covered');
for (const page of pages) {
    const source = fs.readFileSync(path.join(publicDir, page), 'utf8');
    assert.match(source, /<script src="\.\/plv-navigation\.v1\.js" defer><\/script>/, `${page} must load shared navigation behavior`);
}

const css = fs.readFileSync(path.join(publicDir, 'plv-responsive.css'), 'utf8');
assert.match(css, /\.mobile-nav-bar ul>li\{flex:0 0 72px!important/, 'mobile links must never collapse into each other');
assert.match(css, /overflow-x:auto!important/, 'large admin navigation must remain swipeable');
assert.match(css, /env\(safe-area-inset-bottom\)/, 'bottom navigation must respect phone safe areas');

const script = fs.readFileSync(path.join(publicDir, 'plv-navigation.v1.js'), 'utf8');
assert.match(script, /aria-current/);
assert.match(script, /centerItem/);
assert.match(script, /prefers-reduced-motion/);

console.log('shared navigation smoke checks passed');
