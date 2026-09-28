import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'jev-test-'));
process.env.TMPDIR = dir;
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
