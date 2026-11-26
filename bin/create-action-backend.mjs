#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const target=process.argv[2];
if (!target || process.argv.length!==3) { console.error('Usage: create-action-backend <new-or-empty-directory>'); process.exit(2); }
const [major,minor]=process.versions.node.split('.').map(Number);
if (!(major===22 && minor>=18 || major===24 || major===26)) {
  console.error('Action Workbench requires Node 22.18+ (22.x), 24.x or 26.x.');process.exit(1);
}
const root=fileURLToPath(new URL('../',import.meta.url)), out=resolve(target);
const existing=lstatSync(out,{throwIfNoEntry:false});
if (existing && (!existing.isDirectory() || readdirSync(out).length)) throw new Error('Target must be a new or empty directory; no files were changed.');
if (!existsSync(join(root,'dist/index.js'))) throw new Error('Build the framework with npm ci && npm run build first.');
mkdirSync(out,{recursive:true});
const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
// Ship the exact built package. The generated product does not need a registry release or a symlink to this repository.
const args=['pack','--offline','--ignore-scripts','--json','--pack-destination',out];
let npmCli=process.env.npm_execpath;
if (!npmCli || !isAbsolute(npmCli) || basename(npmCli)!=='npm-cli.js') npmCli=undefined;
if (process.platform==='win32' && !npmCli) {
  // npm.cmd isn't an executable. Run the JS supplied with Node, never interpolate a destination into cmd.exe.
  npmCli=join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js');
  if (!existsSync(npmCli)) throw new Error('Bundled npm not found. Run this CLI with npm exec.');
}
const packed=execFileSync(npmCli?process.execPath:'npm',npmCli?[npmCli,...args]:args,{cwd:root,encoding:'utf8'});
const [{filename}]=JSON.parse(packed);
const template=join(root,'starter');
for(const file of ['orders.ts','expenses.ts','server.ts','tsconfig.json','README.md']) {
  copyFileSync(join(template,file),join(out,file),constants.COPYFILE_EXCL);
}
copyFileSync(join(root,'LICENSE'),join(out,'LICENSE.action-workbench'),constants.COPYFILE_EXCL);
const name=basename(out).toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/^-+|-+$/g,'')||'my-product';
writeFileSync(join(out,'package.json'),JSON.stringify({name,private:true,type:'module',engines:pkg.engines,scripts:{start:'node server.ts','start:ai':'node server.ts --ai',check:'tsc -p tsconfig.json'},dependencies:{[pkg.name]:`file:./${filename}`,zod:pkg.dependencies.zod},devDependencies:pkg.devDependencies},null,2)+'\n',{flag:'wx'});
writeFileSync(join(out,'.gitignore'),'node_modules/\n.data/\n.env\n',{flag:'wx'});
console.log(`Created ${out}\nInstall: npm install\nStart: set WORKBENCH_TOKEN, then npm start. See README.md.`);
