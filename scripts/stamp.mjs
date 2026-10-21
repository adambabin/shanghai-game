// Stamps a built copy of the site with a release version so phones fetch each release's files instead of a saved
// copy: every css/js/vendor reference (and every import between modules) gets "?v=<version>", index.html gets an
// app-version meta tag, and version.json holds the version for the game's update check (checkForUpdate in main.js).
// Run by the deploy workflow on the _site folder only; the files in the repo stay unstamped.
//   node scripts/stamp.mjs <site dir> <version>
import fs from 'node:fs';
import path from 'node:path';

export function stampSite(dir, version) {
  const v = encodeURIComponent(version);
  const indexPath = path.join(dir, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  html = html.replace(/((?:href|src)=")((?:css|js|vendor)\/[^"?]+)(")/g, `$1$2?v=${v}$3`);
  html = html.replace('<head>', `<head>\n    <meta name="app-version" content="${version}" />`);
  fs.writeFileSync(indexPath, html);

  const jsDir = path.join(dir, 'js');
  for (const name of fs.readdirSync(jsDir).filter((f) => f.endsWith('.js'))) {
    const file = path.join(jsDir, name);
    // every module must import the others by the same stamped URL, or a module would load twice
    const src = fs.readFileSync(file, 'utf8').replace(/(from\s+'\.\/[^'?]+\.js)(')/g, `$1?v=${v}$2`);
    fs.writeFileSync(file, src);
  }
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version }) + '\n');
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const [dir, version] = process.argv.slice(2);
  if (!dir || !version) {
    console.error('usage: node scripts/stamp.mjs <site dir> <version>');
    process.exit(1);
  }
  stampSite(dir, version);
  console.log(`Stamped ${dir} as ${version}`);
}
