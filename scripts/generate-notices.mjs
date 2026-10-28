import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const notices = ['Third-party notices for DBNook', 'Generated from production dependencies in package-lock.json. Build-time tools are not bundled runtime components.'];
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path.startsWith('node_modules/') || entry.dev) continue;
  let manifest;
  try {manifest=JSON.parse(await readFile(join(path,'package.json'),'utf8'));}
  catch(error){if(entry.optional&&error.code==='ENOENT')continue;throw error;}
  const entries = await readdir(path);
  const files = entries.filter(file => /^(licen[sc]e|copying|notice)(\.|$)/i.test(file));
  const licenseTexts = await Promise.all(files.map(file => readFile(join(path,file),'utf8')));
  if (!licenseTexts.length) {
    // Some dependencies ship their license declaration in a Markdown/Setext README section.
    const readme = entries.find(file=>/^readme(?:\.md)?$/i.test(file));
    const text = readme ? await readFile(join(path,readme),'utf8') : '';
    const section = /^#{1,6}\s+licen[cs]e\s*\r?$/im.exec(text) ?? /^licen[cs]e\s*\r?\n[-=]{3,}\s*\r?$/im.exec(text);
    const license = section ? text.slice(section.index+section[0].length).split(/^#{1,6}\s/m)[0].trim() : '';
    const completeMit=manifest.license==='MIT'&&/Copyright/i.test(license)&&/Permission is hereby granted/i.test(license)&&/THE SOFTWARE IS PROVIDED/i.test(license);
    const cc0=manifest.name==='railroad-diagrams'&&manifest.license==='CC0-1.0'&&/all associated files[\s\S]*licensed under \[CC0\]/i.test(license);
    if (!completeMit&&!cc0) throw new Error(`Missing runtime license notice: ${manifest.name}`);
    licenseTexts.push(license);
  }
  notices.push(`\n${'='.repeat(72)}\n${manifest.name} ${manifest.version}\nLicense: ${manifest.license ?? 'See included notice'}\n${'='.repeat(72)}`);
  notices.push(...licenseTexts);
}
await writeFile('THIRD_PARTY_NOTICES.txt', notices.join('\n\n') + '\n');
