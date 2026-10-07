// Release manifest helper. No dependencies; see docs/RELEASING.md.
//
//   node scripts/release-manifest.js create <version> --change "<summary>" --tests <n>
//   node scripts/release-manifest.js publish <version> --digest sha256:... --config-digest sha256:...
//   node scripts/release-manifest.js verify releases/<version>.json
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IMAGE = 'docker.io/skorcius/cliproxy-dashboard';
const sha256 = data => createHash('sha256').update(data).digest('hex');

// Exactly the files the Dockerfile copies into the image, plus the build recipe itself.
function buildInputs() {
  const listed = ['.dockerignore', 'Dockerfile', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json'];
  const tree = dir => fs.readdirSync(path.join(ROOT, dir)).map(name => `${dir}/${name}`);
  return [...listed, ...tree('public'), ...tree('src')].sort()
    .map(file => ({ path: file, sha256: sha256(fs.readFileSync(path.join(ROOT, file))) }));
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) throw new Error(`Missing ${name}`);
  return args[index + 1];
}

const manifestPath = version => path.join(ROOT, 'releases', `${version}.json`);
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

function create(version, args) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (pkg.version !== version) throw new Error(`package.json version is ${pkg.version}, not ${version}`);
  if (fs.existsSync(manifestPath(version))) throw new Error(`releases/${version}.json already exists; release tags are immutable`);
  const inputs = buildInputs();
  const tests = Number(option(args, '--tests'));
  if (!Number.isSafeInteger(tests) || tests < 1) throw new Error('--tests must be a positive integer');
  write(manifestPath(version), {
    version, image: `${IMAGE}:${version}`, platform: 'linux/amd64', visibility: 'public',
    sourceManifestSha256: sha256(JSON.stringify(inputs)), buildInputs: inputs,
    createdAt: new Date().toISOString(), change: option(args, '--change'),
    digest: null, pinnedImage: null, imageConfigDigest: null,
    sourceStatus: `Git tag v${version} of https://github.com/jcarcaboso/cliproxy-dashboard`,
    validation: { nodeTests: tests, containerTests: tests, targetArchitecture: 'x86_64-linux' }
  });
}

function publish(version, args) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath(version), 'utf8'));
  if (manifest.digest) throw new Error(`releases/${version}.json already records a digest`);
  const digest = option(args, '--digest');
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid --digest');
  const configDigest = option(args, '--config-digest');
  if (!/^sha256:[a-f0-9]{64}$/.test(configDigest)) throw new Error('Invalid --config-digest');
  manifest.digest = digest;
  manifest.pinnedImage = `${manifest.image}@${digest}`;
  manifest.imageConfigDigest = configDigest;
  write(manifestPath(version), manifest);
}

function verify(file) {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const current = new Map(buildInputs().map(input => [input.path, input.sha256]));
  const mismatched = manifest.buildInputs.filter(input => current.get(input.path) !== input.sha256).map(input => input.path);
  const unlisted = [...current.keys()].filter(file => !manifest.buildInputs.some(input => input.path === file));
  if (sha256(JSON.stringify(manifest.buildInputs)) !== manifest.sourceManifestSha256) mismatched.push('(sourceManifestSha256)');
  if (mismatched.length || unlisted.length) {
    console.error(`Mismatched: ${mismatched.join(', ') || 'none'}; not in manifest: ${unlisted.join(', ') || 'none'}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Working tree matches ${manifest.version} (${manifest.buildInputs.length} build inputs).`);
}

const [command, target, ...args] = process.argv.slice(2);
try {
  if (command === 'create') create(target, args);
  else if (command === 'publish') publish(target, args);
  else if (command === 'verify') verify(target);
  else throw new Error('Usage: create <version> | publish <version> | verify <manifest>');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
