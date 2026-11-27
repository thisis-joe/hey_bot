import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';

const [version, outputArg] = process.argv.slice(2);
if (!version || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version) || !outputArg) {
  throw new Error('Usage: node scripts/package-release.mjs VERSION OUTPUT_DIRECTORY');
}
const output = resolve(outputArg);
const compose = parse(await readFile('compose.yaml', 'utf8'));
const services = ['controller', 'runner'];
const images = services.map(service => ({ service, ref: `hey-${service}:${version}` }));
const docker = (args, capture = false) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
// Create a new release directory to avoid overwriting an existing bundle.
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
for (const image of images) {
  const { service, ref } = image;
  docker(['build', '--target', service, '--tag', ref, '.']);
  image.id = docker(['image', 'inspect', '--format', '{{.Id}}', ref], true).trim();
  delete compose.services[service].build;
  compose.services[service].image = ref;
  compose.services[service].pull_policy = 'never';
}
const archive = join(output, 'images.tar');
docker(['image', 'save', '--output', archive, ...images.map(image => image.ref)]);
const hash = createHash('sha256');
for await (const part of createReadStream(archive)) hash.update(part);
const platform = docker(['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', images[0].ref], true).trim();
const files = ['.env.example', 'LICENSE', 'scripts/install.mjs', 'scripts/setup.mjs', 'scripts/bootstrap-n8n.mjs',
  'config/repositories.example.yaml', 'n8n/workflows.json', 'ops/init-db.sh', 'ops/cloudflared.example.yml'];
for (const file of files) {
  const target = join(output, file);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(file, target);
}
await copyFile('docs/self-hosted-install.md', join(output, 'README.md'));
await writeFile(join(output, 'compose.yaml'), stringify(compose));
await writeFile(join(output, 'release.json'), JSON.stringify({ version, platform, images, archiveSha256: hash.digest('hex') }, null, 2) + '\n');
console.log(`Packaged Heybot ${version} for ${platform} in ${output}`);
