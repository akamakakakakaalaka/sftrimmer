import { copyFile, lstat, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Build-time only: copy a Vite build into the native resource folder, byte for byte. */
export async function syncIOSBundle(
  source = join(projectRoot, 'dist'),
  destination = join(projectRoot, 'ios', 'Project128', 'WebBundle'),
) {
  source = resolve(source);
  destination = resolve(destination);
  if (source === destination || destination.startsWith(source + sep) || source.startsWith(destination + sep)) {
    throw new Error('The build and native resource directories must be separate.');
  }
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) throw new Error('The build directory must be a real directory.');
  const index = await lstat(join(source, 'index.html'));
  if (!index.isFile() || index.isSymbolicLink()) throw new Error('Build the web app first: dist/index.html is missing or invalid.');
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), '.webbundle-'));
  const result = { files: 0, bytes: 0 };
  async function copyDirectory(from, to) {
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (entry.name === '.DS_Store') continue;
      const input = join(from, entry.name);
      const output = join(to, entry.name);
      const info = await lstat(input);
      if (info.isSymbolicLink()) throw new Error(`Symbolic links are not permitted in the offline build: ${entry.name}`);
      if (info.isDirectory()) {
        await mkdir(output);
        await copyDirectory(input, output);
      } else if (info.isFile()) {
        await copyFile(input, output);
        result.files++;
        result.bytes += info.size;
      } else throw new Error(`Unsupported offline asset: ${entry.name}`);
    }
  }
  try {
    await copyDirectory(source, staging);
    // A failed copy never removes the previous bundle. The source build is reproducible.
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    return result;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await syncIOSBundle();
  console.log(`iOS offline bundle: ${result.files} files, ${result.bytes.toLocaleString('en-US')} bytes`);
}
