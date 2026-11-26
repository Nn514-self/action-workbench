import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync,cpSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkCompatibility} from './compatibility.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)), example=join(root,'example','meeting-rooms');
const json=(dir,file='package.json')=>JSON.parse(readFileSync(join(dir,file),'utf8'));
const manifest=json(root), flags=new Set(process.argv.slice(2));
const registry='https://registry.npmjs.org/', tag=manifest.version.includes('-')?'next':'latest';
for(const flag of flags) assert.ok(['--public','--refresh-example','--with-codex'].includes(flag),`Unknown option: ${flag}`);
if(flags.has('--public')) {
  const blockers=[];
  if(manifest.private) blockers.push('package.json: private is true');
  if(!manifest.license || manifest.license==='UNLICENSED' || !existsSync(join(root,'LICENSE')) || !readFileSync(join(root,'LICENSE'),'utf8').trim()) blockers.push('owner-approved license and LICENSE file required');
  if(!(manifest.repository?.url || typeof manifest.repository==='string' && manifest.repository)) blockers.push('public source repository required');
  if(!(manifest.bugs?.url || manifest.bugs?.email)) blockers.push('maintainer issue or contact channel required');
  if(manifest.publishConfig?.registry!==registry || manifest.publishConfig?.access!=='public' || manifest.publishConfig?.tag!==tag) {
    blockers.push(`publishConfig must target the public npm registry with public access and tag ${tag}`);
  }
  if(blockers.length) {console.error('Public release blocked:\n- '+blockers.join('\n- '));process.exit(1);}
}
const cleanEnv={...process.env};delete cleanEnv.GITLEAKS_CONFIG;delete cleanEnv.GITLEAKS_CONFIG_TOML;
function run(cwd,cmd,args,output=false) {
  return execFileSync(cmd,args,{cwd,env:cleanEnv,stdio:output?['ignore','pipe','inherit']:'inherit',encoding:'utf8',timeout:600_000});
}
const npm=(dir,args,out=false)=>run(dir,process.execPath,[process.env.npm_execpath,...args],out);
if(!process.env.npm_execpath) throw Error('Use npm run release:check or npm run release:public-check.');
const install=['--engine-strict','--ignore-scripts','--no-audit','--no-fund',`--registry=${registry}`];
const audit=['audit','--audit-level=low',`--registry=${registry}`];
const tmp=mkdtempSync(join(tmpdir(),'aw-release-')), source=join(tmp,'build'), scanned=join(tmp,'scan'), rooms=join(tmp,'rooms');
function copyEntries(from,to,names){mkdirSync(to,{recursive:true});for(const name of names) cpSync(join(from,name),join(to,name),{recursive:true});}
function previewPublicArchive(archive,packed,integrity){
  // Preview the file in offline mode without the maintainer's npm configuration or lifecycle hooks.
  const home=join(tmp,'preview');mkdirSync(home);
  const env={HOME:home,USERPROFILE:home};
  for(const key of ['PATH','SystemRoot','TEMP','TMP','TMPDIR']) if(process.env[key]) env[key]=process.env[key];
  const args=[process.env.npm_execpath,'publish',archive,'--dry-run','--offline','--ignore-scripts','--json',
    `--registry=${registry}`,'--access=public',`--tag=${tag}`,`--userconfig=${join(home,'user.npmrc')}`,`--globalconfig=${join(home,'global.npmrc')}`];
  const result=JSON.parse(execFileSync(process.execPath,args,{cwd:home,env,encoding:'utf8',stdio:['ignore','pipe','inherit'],timeout:60_000}));
  assert.equal(result.name,manifest.name);assert.equal(result.version,manifest.version);
  assert.equal(result.integrity,integrity,'npm preview did not use the tested tarball');assert.equal(result.size,packed.size);
  console.log(`NPM DRY RUN ${result.id} | tag=${tag} | access=public | ${result.size} bytes | ${result.integrity}`);
}
try {
  const license=existsSync(join(root,'LICENSE'))?['LICENSE']:[];
  copyEntries(root,source,['src','starter','test','bin','tsconfig.json','package.json','package-lock.json','README.md',...license]);
  console.log('1. Clean locked install, compile and framework behavior');
  npm(source,['ci',...install]);npm(source,['test']);npm(source,audit);
  const files=manifest.files;
  assert.equal(new Set(files).size,files.length,'duplicate package allowlist entry');
  for(const file of files) {
    assert.match(file,/^(?:dist\/[a-z][a-z-]*\.(?:js|d\.ts)|dist\/decision\.schema\.json|bin\/create-action-backend\.mjs|starter\/(?:[a-z][a-z-]*\.ts|README\.md|tsconfig\.json))$/,'package files must be literal runtime or starter paths');
    assert.ok(lstatSync(join(source,file)).isFile(),`Missing clean build file: ${file}`);
  }
  mkdirSync(join(root,'dist'),{recursive:true});
  for(const file of files.filter(f=>f.startsWith('dist/'))) copyFileSync(join(source,file),join(root,file));
  console.log('2. Check real npm archive, clean-build bytes and extracted contents');
  const [packed]=JSON.parse(npm(root,['pack','--offline','--ignore-scripts','--json','--pack-destination',tmp],true));
  assert.equal(packed.name,manifest.name);assert.equal(packed.version,manifest.version);assert.equal(basename(packed.filename),packed.filename);
  const archive=join(tmp,packed.filename), expected=[...files,'package.json','README.md',...license].sort();
  assert.deepEqual(packed.files.map(f=>f.path).sort(),expected);
  assert.deepEqual(run(tmp,'tar',['-tzf',archive],true).trimEnd().split(/\r?\n/).sort(),expected.map(f=>'package/'+f));
  const integrity='sha512-'+createHash('sha512').update(readFileSync(archive)).digest('base64');assert.equal(integrity,packed.integrity);
  mkdirSync(scanned);run(scanned,'tar',['-xzf',archive]);const unpacked=join(scanned,'package');
  for(const path of expected){const file=join(unpacked,path);assert.ok(lstatSync(file).isFile());assert.ok(readFileSync(file).equals(readFileSync(join(source,path))),`Packed bytes differ: ${path}`);}
  for(const hook of ['preinstall','install','postinstall','prepare']) assert.ok(!Object.hasOwn(json(unpacked).scripts,hook),`Unexpected consumer install hook: ${hook}`);
  run(unpacked,'gitleaks',['dir','--redact','--no-banner','--ignore-gitleaks-allow','.']);
  console.log('3. Installed CLI, generated service, authentication and durable upgrade from the pinned 0.4 archive');
  await checkCompatibility({archive,integrity,verifyBuild:true,audit:true});
  console.log('4. Independent meeting-room product: locked install and behavior against the same archive');
  copyEntries(example,rooms,['package.json','package-lock.json','tsconfig.json','store.ts','access.ts','bookings.ts','manage.ts','server.ts','test','acceptance']);
  assert.equal(json(rooms).dependencies[manifest.name],'file:./'+packed.filename);copyFileSync(archive,join(rooms,packed.filename));
  if(flags.has('--refresh-example')) {
    const lock=json(rooms,'package-lock.json');delete lock.packages['node_modules/'+manifest.name];
    writeFileSync(join(rooms,'package-lock.json'),JSON.stringify(lock,null,2)+'\n');
    npm(rooms,['install','--package-lock-only',...install]);
  }
  assert.equal(json(rooms,'package-lock.json').packages['node_modules/'+manifest.name].integrity,integrity,'Example lock does not pin this build; review changes and use --refresh-example.');
  npm(rooms,['ci',...install]);npm(rooms,['test']);
  if(flags.has('--with-codex')) npm(rooms,['run','test:ai']);
  if(flags.has('--public')) previewPublicArchive(archive,packed,integrity);
  if(flags.has('--refresh-example')) {copyFileSync(archive,join(example,packed.filename));copyFileSync(join(rooms,'package-lock.json'),join(example,'package-lock.json'));}
  copyFileSync(archive,join(root,packed.filename));
  console.log(`PASS ${packed.filename} | ${expected.length} files | ${integrity}\nNo package was published.`);
} finally {rmSync(tmp,{recursive:true,force:true});}
