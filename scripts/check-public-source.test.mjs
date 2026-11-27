import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const scanner = fileURLToPath(new URL('./check-public-source.mjs', import.meta.url));
function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'public-source-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Test Maintainer');
  git('config', 'user.email', 'maintainer@example.invalid');
  const write = (path, content) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  };
  const scan = (...args) => spawnSync(process.execPath, [scanner, ...args], { cwd, encoding: 'utf8' });
  return { cwd, git, write, scan };
}
test('accepts fictional fixtures and environment templates', (t) => {
  const { write, scan } = repository(t);
  write(
    'test/fixture.json',
    JSON.stringify({ orgId: '00D' + 'xx0000000001EAA', url: 'https://example.my.salesforce.com' })
  );
  write('.env.example', 'API_KEY=\n');
  write('.env.local.example', 'API_KEY=\n');
  assert.equal(scan().status, 0);
});
test('blocks a sensitive staged value masked by a clean working file', (t) => {
  const { write, git, scan } = repository(t);
  write('config.json', 'https://' + ['private-tenant', 'my', 'salesforce', 'com'].join('.'));
  git('add', 'config.json');
  write('config.json', '{}');
  const result = scan();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /index.*org URL/);
  assert.doesNotMatch(result.stderr, /private-tenant/);
});
test('blocks tracked local data even when an ignore rule matches', (t) => {
  const { write, git, scan } = repository(t);
  write('.claude/settings.local.json', '{}');
  git('add', '-f', '.claude/settings.local.json');
  write('.gitignore', '.claude/\n');
  assert.equal(scan().status, 1);
});
test('ignores local files protected by repository rules', (t) => {
  const { write, scan } = repository(t);
  write('.gitignore', '.claude/\n.env\n');
  write('.claude/settings.local.json', '{}');
  write('.env', 'PRIVATE=local\n');
  assert.equal(scan().status, 0);
});
test('detects removed private metadata in history', (t) => {
  const { write, git, scan } = repository(t);
  write('config.json', 'https://' + ['private-tenant', 'my', 'salesforce', 'com'].join('.'));
  git('add', 'config.json');
  git('commit', '-qm', 'Initial fixture');
  write('config.json', '{}');
  git('add', 'config.json');
  git('commit', '-qm', 'Replace fixture');
  assert.equal(scan().status, 0);
  assert.equal(scan('--history').status, 1);
});
test('rejects real-shaped org IDs and limits mock IDs to tests', (t) => {
  const { write, scan } = repository(t);
  write('config.json', JSON.stringify({ orgId: '00D' + 'xx0000000001EAA' }));
  assert.equal(scan().status, 1);
  write('config.json', '{}');
  write('test/fixture.json', JSON.stringify({ orgId: '00D' + 'ab0000000001EAA' }));
  assert.equal(scan().status, 1);
});
test('checks every historical path when private and public files share a blob', (t) => {
  const { write, git, scan } = repository(t);
  write('public.json', '{}');
  write('.claude/settings.local.json', '{}');
  git('add', '-f', 'public.json', '.claude/settings.local.json');
  git('commit', '-qm', 'Shared content fixture');
  git('rm', '-q', '.claude/settings.local.json');
  git('commit', '-qm', 'Remove private path');
  assert.equal(scan().status, 0);
  const result = scan('--history');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /local data or credentials path/);
});
test('rejects symlinks without reading their target', (t) => {
  const { cwd, write, scan } = repository(t);
  write('target.txt', 'safe');
  symlinkSync('target.txt', join(cwd, 'linked.txt'));
  assert.equal(scan().status, 1);
});
test('redacts email addresses in findings and checks commit messages', (t) => {
  const { write, git, scan } = repository(t);
  const email = 'person@' + 'private.invalid';
  write(`${email}.txt`, email);
  const result = scan();
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, new RegExp(email));
  git('add', '.');
  git('commit', '-qm', `Contact ${email}`);
  assert.equal(scan('--history').status, 1);
});
