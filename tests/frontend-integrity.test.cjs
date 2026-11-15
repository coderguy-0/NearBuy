'use strict';
// Static checks on the browser code. These catch the failures that make a page look "dead" in a browser while every
// HTTP test still passes: an ES-module import that names something a module does not export (the whole module graph
// refuses to load, so the page renders nothing) and API calls pointed at a path the server does not serve.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENTRIES = ['/customer/app.js', '/runner/app.js', '/seller/app/main.js', '/control-tower/app.js', '/fleet/app.js', '/delivery/kit.js'];
const read = (file) => fs.readFileSync(file, 'utf8');

function exportedNames(file) {
  const source = read(file);
  const names = new Set();
  for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) names.add(match[1]);
  for (const match of source.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  if (/^export\s+default\b/m.test(source)) names.add('default');
  return names;
}

function importGraph() {
  const seen = new Set();
  const problems = [];
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const match of read(file).matchAll(/import\s+(?:\*\s+as\s+[A-Za-z0-9_$]+\s+|\{([^}]*)\}\s*|\s*)(?:from\s*)?['"]([^'"]+)['"]/g)) {
      const named = match[1];
      const spec = match[2];
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
      const target = spec.startsWith('/') ? path.join(ROOT, spec) : path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target)) { problems.push(`${path.relative(ROOT, file)}: cannot resolve '${spec}'`); continue; }
      if (named) {
        const available = exportedNames(target);
        for (const part of named.split(',')) {
          const name = part.trim().split(/\s+as\s+/)[0].trim();
          if (name && !available.has(name)) problems.push(`${path.relative(ROOT, file)}: imports '${name}' from '${spec}', which does not export it`);
        }
      }
      if (target.endsWith('.js')) walk(target);
    }
  };
  for (const entry of ENTRIES) walk(path.join(ROOT, entry));
  return { problems, visited: seen };
}

test('every browser module import resolves to a real export (otherwise the whole page fails to load)', () => {
  const { problems, visited } = importGraph();
  assert.ok(visited.size >= 12, `expected the import graph to cover the app modules, visited ${visited.size}`);
  assert.deepEqual(problems, [], `broken ES module imports:\n${problems.join('\n')}`);
});

test('customer storefront calls the /api/customer paths the server serves', () => {
  const source = read(path.join(ROOT, 'customer', 'app.js'));
  // The page prefixes every call with /api, so the literals must not repeat the prefix themselves.
  // EventSource is not routed through api(), so it legitimately names the full path.
  const apiCalls = [...source.matchAll(/api\('(?:GET|POST|PATCH|DELETE|PUT)',\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  const wrongPrefix = apiCalls.filter((p) => p.startsWith('/api/'));
  assert.deepEqual(wrongPrefix, [], 'the api() helper already prefixes /api; callers must not repeat it');
  assert.ok(apiCalls.length >= 20, `expected the storefront to make its API calls through api(), found ${apiCalls.length}`);
  const server = read(path.join(ROOT, 'server', 'routes', 'customer.js'));
  const called = [...new Set([...source.matchAll(/api\('(?:GET|POST|PATCH|DELETE|PUT)',\s*`?\/([a-z]+\/[a-z-]+)/g)].map((m) => `/${m[1]}`))];
  for (const route of called) {
    const pattern = new RegExp(`route\\('(?:GET|POST|PATCH|DELETE|PUT)', '/api${route.replace(/[/\\]/g, '\\$&')}`);
    assert.match(server, pattern, `customer/app.js calls /api${route} but the server has no such route`);
  }
});

test('no page waits on a third-party font host', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'data'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(html|css)$/.test(entry.name)) continue;
      // A comment may mention the old host; only a real request (link/import/@import) counts.
      if (/(?:<link|@import|url\()\s*\(?[^;]*fonts\.(?:googleapis|gstatic)\.com/.test(read(full))) offenders.push(path.relative(ROOT, full));
    }
  };
  walk(ROOT);
  assert.deepEqual(offenders, [], `pages that block first paint on Google Fonts: ${offenders.join(', ')}`);
});

test('every page script and stylesheet it links is actually served from this repository', async () => {
  const server = read(path.join(ROOT, 'server', 'index.js'));
  const pages = ['index.html', 'portal.html', 'classic.html', 'business.html', 'customer/index.html', 'seller/index.html', 'runner/index.html', 'control-tower/index.html', 'fleet/index.html'];
  for (const page of pages) {
    const html = read(path.join(ROOT, page));
    for (const match of html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)) {
      const target = path.join(ROOT, match[1]);
      assert.ok(fs.existsSync(target), `${page} links ${match[1]}, which does not exist`);
    }
  }
  assert.match(server, /Content-Encoding/, 'the static server should gzip text assets so the bundles arrive quickly');
});
