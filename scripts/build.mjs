import { mkdir, copyFile, rm } from 'node:fs/promises';
const output = new URL('../dist/', import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(new URL('assets/', output), { recursive: true });
for (const file of ['index.html', 'config.js', 'assets/app.js', 'assets/style.css', 'assets/upload.js']) {
  await copyFile(new URL('../' + file, import.meta.url), new URL(file, output));
}
console.log('Built static website: dist/');
