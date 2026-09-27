import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function makeRepo(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\n');
  execFileSync('git', ['-C', dir, 'add', 'a.js']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
