// Resolve existing host types only; never install or load a Pi runtime/provider.
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
let host = process.env.PI_TPS_HOST_PACKAGE;
if (!host) {
  try { host = dirname(require.resolve('@earendil-works/pi-coding-agent/package.json')); }
  catch { host = resolve(dirname(process.execPath), '../lib/node_modules/@earendil-works/pi-coding-agent'); }
}
if (!existsSync(join(host, 'dist/index.d.ts'))) throw new Error('Set PI_TPS_HOST_PACKAGE to the existing host package directory');
let nodeTypes;
for (const base of [root, host]) {
  try { nodeTypes = dirname(createRequire(join(base, 'package.json')).resolve('@types/node/package.json')); break; } catch {}
}
if (!nodeTypes) throw new Error('Existing @types/node required');
const scratch = mkdtempSync(join(tmpdir(), 'ft28-typecheck-'));
try {
  writeFileSync(join(scratch, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      strict: true, noEmit: true, allowImportingTsExtensions: true,
      skipLibCheck: true, types: ['node'], typeRoots: [dirname(nodeTypes)],
      paths: { '@earendil-works/pi-coding-agent': [join(host, 'dist/index.d.ts')] }
    },
    files: ['index.ts', 'metrics.ts', 'storage.ts'].map(file => join(root, file))
  }));
  const result = spawnSync('tsc', ['--project', join(scratch, 'tsconfig.json')], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(scratch, { recursive: true, force: true }); }
