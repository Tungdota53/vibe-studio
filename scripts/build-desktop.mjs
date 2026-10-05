import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
fs.mkdirSync('build/runtime', { recursive: true });
fs.copyFileSync(process.execPath, path.resolve('build/runtime/node.exe'));
await build({ entryPoints: ['src/studio/desktop-host.ts'], outfile: 'build/runtime/desktop-host.mjs', bundle: true, platform: 'node', target: 'node22', format: 'esm', external: ['better-sqlite3'], banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
function copyTree(source, destination) {
  if (fs.statSync(source).isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) copyTree(path.join(source, name), path.join(destination, name));
  } else fs.copyFileSync(source, destination);
}
copyTree('src/studio/public', 'build/runtime/public');
copyTree('src/skills', 'build/runtime/skills');
copyTree('src/vendor-skills', 'build/runtime/vendor-skills');
copyTree('src/template-assets', 'build/runtime/template-assets');
for (const name of ['better-sqlite3', 'bindings', 'file-uri-to-path']) {
  const destination = path.join('build/runtime/node_modules', name);
  fs.mkdirSync(destination, { recursive: true });
  const source = path.join('node_modules', name);
  // Ship the existing Node ABI binary alongside the exact Node runtime used to build.
  for (const entry of ['package.json', 'lib', 'bindings.js', 'index.js', 'build/Release/better_sqlite3.node']) {
    if (fs.existsSync(path.join(source, entry))) copyTree(path.join(source, entry), path.join(destination, entry));
  }
}
