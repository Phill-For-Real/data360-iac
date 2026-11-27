import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, lstatSync } from 'node:fs';

const history = process.argv.includes('--history');
if (process.argv.slice(2).some((arg) => arg !== '--history')) {
  throw new Error('Usage: node scripts/check-public-source.mjs [--history]');
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const splitPaths = (value) => value.split('\0').filter(Boolean);
const files = new Set(splitPaths(git('ls-files', '--cached', '--others', '--exclude-standard', '-z')));
const index = new Map(
  splitPaths(git('ls-files', '--stage', '-z')).map((entry) => {
    const tab = entry.indexOf('\t');
    return [entry.slice(tab + 1), entry.slice(0, tab).split(' ')];
  })
);
const localPath =
  /(^|\/)(?:\.sf|\.sfdx|\.aws|\.codex|\.agents|\.claude|\.data360|\.info|data360-discovery|snapshots)(\/|$)|(^|\/)data360\..*\.state\.json(?:\..*)?$|(^|\/)\.env(?:\..*)?$|\.(?:pem|key|p12|pfx|jks|keystore|log|report\.json)$|(^|\/)(?:credentials|service-account[^/]*)\.json$/;
const exampleEnvironment = /(^|\/)\.env(?:\.[^/]+)?\.example$/;
const patterns = [
  ['internal hostname', /\b[A-Za-z0-9.-]+\.internal\.[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ['absolute home path', /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['Salesforce session token', /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._-]{30,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}/],
  [
    'org URL',
    /\b(?!(?:example\.my\.salesforce\.com)\b)[A-Za-z0-9.-]+\.(?:my\.salesforce\.com|lightning\.force\.com|my\.site\.com)\b/,
  ],
  ['live org resource ID', /\b[A-Za-z0-9]{3}ak000[A-Za-z0-9]{7,12}\b/],
];
const emails = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const orgIds = /\b00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?\b/g;
const findings = new Set();
const safeLabel = (label) => label.replace(emails, '<email>').replace(/[\r\n\t]/g, '?');
const report = (label, message) => findings.add(`${safeLabel(label)}: ${message}`);
function checkPath(path, label) {
  if (localPath.test(path) && !exampleEnvironment.test(path)) report(label, 'local data or credentials path');
  if (/[\r\n\t]/.test(path)) report(label, 'unsupported control character in path');
}
function checkContent(content, label, { metadata = false, syntheticFixture = false } = {}) {
  for (const [message, pattern] of patterns) if (pattern.test(content)) report(label, message);
  for (const email of content.match(emails) ?? []) {
    const domain = email.split('@')[1];
    if (/^example\.(?:com|org|net|invalid)$/.test(domain)) continue;
    if (metadata && (domain === 'users.noreply.github.com' || email === 'noreply' + '@github.com')) continue;
    report(label, 'email address');
  }
  for (const id of content.match(orgIds) ?? []) {
    // Only the established mock-org IDs are permitted, and only in test files.
    if (syntheticFixture && ['00D' + 'xx0000000001EAA', '00D' + 'xx0000000999EAA'].includes(id)) continue;
    report(label, 'Salesforce org ID');
  }
}
for (const file of files) {
  checkPath(file, file);
  if (existsSync(file)) {
    if (lstatSync(file).isSymbolicLink()) report(file, 'symlink must be reviewed before publication');
    else
      checkContent(readFileSync(file, 'utf8'), `${file} (working file)`, {
        syntheticFixture: file.startsWith('test/'),
      });
  }
  // Inspect every index blob so a clean working file cannot hide a sensitive staged version.
  const entry = index.get(file);
  if (entry) {
    const [mode, oid, stage] = entry;
    if (stage !== '0') report(file, 'unresolved Git index conflict');
    if (mode === '120000' || mode === '160000') report(file, 'symlink or submodule in Git index');
    if (mode !== '160000')
      checkContent(git('cat-file', 'blob', oid), `${file} (index)`, { syntheticFixture: file.startsWith('test/') });
  }
}
if (history) {
  const historicalBlobs = new Map();
  for (const commit of git('rev-list', '--all').split('\n').filter(Boolean)) {
    checkContent(git('cat-file', '-p', commit), `Git commit ${commit.slice(0, 12)}`, { metadata: true });
    for (const entry of splitPaths(git('ls-tree', '-rz', '--full-tree', commit))) {
      const tab = entry.indexOf('\t');
      const [mode, type, oid] = entry.slice(0, tab).split(' ');
      const path = entry.slice(tab + 1);
      const label = `Git ${type} ${oid.slice(0, 12)}`;
      checkPath(path, label);
      if (mode === '120000' || mode === '160000') report(label, 'historical symlink or submodule');
      if (type === 'blob') {
        const allPathsAreFixtures = (historicalBlobs.get(oid) ?? true) && path.startsWith('test/');
        historicalBlobs.set(oid, allPathsAreFixtures);
      }
    }
  }
  for (const [oid, syntheticFixture] of historicalBlobs) {
    checkContent(git('cat-file', 'blob', oid), `Git blob ${oid.slice(0, 12)}`, { syntheticFixture });
  }
  // Annotated tags can carry identifying messages independently of commit metadata.
  for (const line of git('rev-list', '--objects', '--all').split('\n').filter(Boolean)) {
    const space = line.indexOf(' ');
    const oid = space === -1 ? line : line.slice(0, space);
    const type = git('cat-file', '-t', oid).trim();
    const label = `Git ${type} ${oid.slice(0, 12)}`;
    if (type === 'tag') {
      checkContent(git('cat-file', '-p', oid), label, { metadata: true });
    }
  }
}
if (findings.size) {
  console.error([...findings].join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Public source check passed (working files and index${history ? ', all local Git history' : ''}).`);
}
