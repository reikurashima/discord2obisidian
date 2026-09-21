/**
 * src/ と test/ の全 .js を `node --check` にかける。
 * 依存を入れていない環境でも動く（構文チェックは import を解決しないため）。
 *   node scripts/syntax-check.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

const files = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'test')), ...walk(path.join(root, 'scripts'))];
let failed = 0;

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`OK   ${path.relative(root, file)}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${path.relative(root, file)}`);
    console.error(error.stderr?.toString() ?? error.message);
  }
}

console.log(`\n${files.length - failed}/${files.length} files passed`);
process.exit(failed === 0 ? 0 : 1);
