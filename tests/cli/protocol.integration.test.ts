import { spawn, spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { validateShape } from '../../src/contracts/validation';
import { createProject } from '../../src/core/domain/project';
import { applyOperations } from '../../src/core/commands';
import { serializeProject } from '../../src/core/persistence';
import type { Project, Scenario } from '../../src/core/domain/types';
import type { RunReport } from '../../src/core/scenario';
import { feedback, scenario, selfhold, supply, topology, cascade } from '../fixtures/scenarios/build';
const entry = resolve('dist/cli/index.js');
const operations = JSON.parse(readFileSync('design/contracts/examples/build-selfhold.operations.json', 'utf8'));
const startStop = JSON.parse(readFileSync('design/contracts/examples/start-stop.scenario.json', 'utf8'));
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'circuit-cli-')); });
afterEach(() => rmSync(dir, {recursive:true,force:true}));
function put(name: string, data: unknown) { writeFileSync(join(dir,name), typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data)); return name; }
// Vitest's timeout cannot interrupt spawnSync; bound the OS subprocess itself.
function boundedSpawn(command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) {
  const child = spawnSync(command, args, { ...options, timeout: 30000, killSignal: 'SIGKILL' });
  const diagnostic = JSON.stringify({ command, args, status: child.status, signal: child.signal,
    error: child.error?.message, stdout: child.stdout, stderr: child.stderr });
  expect(child.error, diagnostic).toBeUndefined();
  expect(child.signal, diagnostic).toBeNull();
  return child;
}
function cli(args: string[], exit = 0, input?: string | Buffer) {
  const child = boundedSpawn(process.execPath, [entry, ...args], { cwd:dir, encoding:'utf8', env:{...process.env, DISPLAY:'', WAYLAND_DISPLAY:''}, ...(input === undefined ? {} : {input}) });
  expect(child.error).toBeUndefined(); expect(child.signal).toBeNull();
  expect(child.status, child.stdout + child.stderr).toBe(exit);
  const lines = child.stdout.trim().split('\n'); expect(lines).toHaveLength(1);
  const out = JSON.parse(lines[0]!);
  expect(validateShape(out.command === null ? 'hostError' : 'response', out),child.stdout).toMatchObject({valid:true});
  expect(out.exitCode).toBe(child.status); expect(out.ok).toBe(exit === 0);
  if (exit) expect(out.diagnostics.some((d: {severity:string})=>d.severity === 'error')).toBe(true);
  return out;
}
function build() {
  cli(['new','--output','blank','--project-id','project_selfhold','--sheet-id','sheet_control','--title','Relay self-hold']);
  put('ops',operations);
  cli(['edit','apply','blank','--operations','ops','--output','wired']);
  put('scenario',startStop);
  return JSON.parse(readFileSync(join(dir,'wired'),'utf8')) as Project;
}
it('built executable has shebang/mode, all discovery commands and explicit human meta formats', () => {
  expect(readFileSync(entry,'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
  const direct = boundedSpawn(entry,['library','list'],{cwd:dir,encoding:'utf8'}); expect(direct.status).toBe(0); expect(JSON.parse(direct.stdout).command).toBe('library.list');
  const list=cli(['library','list']); expect(list.result.profile.definitions).toHaveLength(7); expect(list.result.profile.status).toBe('proposed-not-implemented'); expect(list.diagnostics[0].code).toBe('PROFILE_STATUS');
  for(const d of list.result.profile.definitions) expect(cli(['library','describe',d.id]).result.definition).toEqual(d);
  for(const args of [['--help'],['--version'],['inspect','--help'],['verify','--version']]) {
    const r=boundedSpawn(process.execPath,[entry,...args],{encoding:'utf8',cwd:dir});expect(r.status).toBe(0);expect(r.stderr).toBe('');expect(r.stdout).not.toMatch(/^\{/);
  }
});
it.each([[],['constructor'],['toString'],['unknown','--help'],['library','constructor'],['edit','constructor']].map(args=>[args]))('rejects unknown command %j as command:null exit2', (args) => { expect(cli(args!,2).command).toBeNull(); expect(readdirSync(dir)).toEqual([]); });
it.each([
 ['new','--output','x','--output','y'],['new','--output'],['new','--constructor','x'],['new','--toString','x'],['new','--output','x','--force'],['new','--output','x','extra'],
 ['validate','p','--scope','constructor'],['inspect','p','--help','extra'],['library','list','--version','extra'],['library','describe','constructor'],['simulate','p'],['edit','apply','p','--operations','q','--output','x','--dry-run','true']
].map(args=>[args]))('strict known command options reject without writes: %j', (args) => { expect(cli(args!,2).command).not.toBeNull(); expect(readdirSync(dir)).toEqual([]); });
it('new→29 shared additions→inspect→validate→simulate/verify; exact defaults, canonical output, deterministic terminal projection', () => {
 const p=build(); const blank=createProject('project_selfhold','sheet_control','Relay self-hold');if(!blank.ok)throw Error('fixture');
 expect(JSON.parse(readFileSync(join(dir,'blank'),'utf8'))).toEqual(blank.value);
 const applied=applyOperations(blank.value,operations);if(!applied.ok)throw Error('fixture');
 expect(p).toEqual(JSON.parse((serializeProject(applied.value.project) as {value:string}).value));
 expect(p.sheets[0]!.page.width).toBe(1000);expect(p.sheets[0]!.name).toBe('Sheet 1');
 expect(cli(['inspect','wired']).result.project).toEqual(p);
 for(const scope of ['document','run']) expect(cli(['validate','wired','--scope',scope]).result.valid).toBe(true);
 const first=cli(['simulate','wired','--scenario','scenario']);expect(cli(['simulate','wired','--scenario','scenario'])).toEqual(first);
 expect(Object.keys(first.result).sort()).toEqual(['project','validationOutcome','runOutcome','untilMs','finalTimeMs','trace'].sort());
 expect(first.result.runOutcome).toBe('completed');expect(first.result.finalTimeMs).toBe(50);
 expect(cli(['verify','wired','--scenario','scenario']).result.verificationOutcome).toBe('passed');
 const saved=readFileSync(join(dir,'wired'),'utf8');expect(saved).not.toContain('runOutcome');expect(saved).not.toContain('trace');
 const trace: RunReport['trace'] = first.result.trace;
 const entries = trace.entries.map(({ atMs, observations }) => {
   const relay = observations.find(o => o.target.kind === 'device' && o.target.id === 'device_relay' && o.observable === 'energized')?.value;
   const lamp = observations.find(o => o.target.kind === 'instance' && o.target.id === 'instance_lamp' && o.observable === 'lit')?.value;
   return { atMs, relayEnergized: relay?.quality === 'known' ? relay.value : undefined, lampLit: lamp?.quality === 'known' ? lamp.value : undefined };
 });
 expect({ complete: trace.complete, entries }).toEqual({ complete: true, entries: [
   { atMs: 0, relayEnergized: false, lampLit: false },
   { atMs: 10, relayEnergized: true, lampLit: true },
   { atMs: 20, relayEnergized: true, lampLit: true },
   { atMs: 30, relayEnergized: false, lampLit: false },
   { atMs: 40, relayEnergized: false, lampLit: false },
 ] });
});
it('rename/hide uses stable bindings; semantic no-op summaries and dry-run never claim persistence',()=>{
 const p=build(); const before=readFileSync(join(dir,'wired'),'utf8'); const relay=p.devices.find(d=>d.kind==='relay')!; const i=p.sheets[0]!.instances.find(i=>i.deviceId===relay.id)!;
 put('rename',{format:'circuit-operations',formatVersion:1,target:{projectId:p.projectId,expectedRevision:p.revision},operations:[{op:'device.rename',deviceId:relay.id,name:'Renamed'},{op:'instance.presentation.replace',instanceId:i.id,label:'https://example.invalid/$(inert)',markings:{...i.markings,showDeviceName:false}}]});
 cli(['edit','apply','wired','--operations','rename','--output','renamed']);
 put('renamed-scenario',{...startStop,target:{...startStop.target,revision:2}});cli(['verify','renamed','--scenario','renamed-scenario']);
 put('noop',{format:'circuit-operations',formatVersion:1,target:{projectId:p.projectId,expectedRevision:1},operations:[{op:'device.rename',deviceId:relay.id,name:relay.name}]});
 const dry=cli(['edit','apply','wired','--operations','noop','--output','wired','--dry-run']);expect(dry.result).toMatchObject({dryRun:true,project:{revision:2},operationCount:1});expect(dry.result).not.toHaveProperty('outputPath');expect(dry.diagnostics).toContainEqual(expect.objectContaining({code:'NO_OP',operationIndex:0}));expect(dry.result.changes[0]).not.toHaveProperty('changed');
 expect(readFileSync(join(dir,'wired'),'utf8')).toBe(before);
 const inventory=readdirSync(dir);cli(['edit','apply','wired','--operations','noop','--output','planned','--dry-run']);expect(readdirSync(dir)).toEqual(inventory);
});
it('late-batch, stale revision, wrong type, malformed request and existing/alias outputs preserve all source bytes',()=>{
 const p=build(), bytes=readFileSync(join(dir,'wired'),'utf8');
 for(const [n,batch,exit] of [
  ['late',{...operations,target:{projectId:p.projectId,expectedRevision:1},operations:[{op:'device.rename',deviceId:p.devices[0]!.id,name:'Changed'},{op:'device.remove',deviceId:'missing'}]},4],
  ['stale',operations,4], ['wrong',{...operations,target:{projectId:p.projectId,expectedRevision:1},operations:[{op:'wire.remove',wireId:p.devices[0]!.id}]},4], ['bad','{"format":1,"format":2}',2]
 ] as const){put(n,batch);cli(['edit','apply','wired','--operations',n,'--output','out'],exit);expect(readdirSync(dir)).not.toContain('out');expect(readFileSync(join(dir,'wired'),'utf8')).toBe(bytes);}
 symlinkSync(join(dir,'wired'),join(dir,'sym'));linkSync(join(dir,'wired'),join(dir,'hard'));symlinkSync(dir,join(dir,'alias'));
 for(const output of ['wired','./wired','sym','hard','alias/wired']) cli(['new','--output',output],7);
 expect(readFileSync(join(dir,'wired'),'utf8')).toBe(bytes);
});
function request(p: Project, changes: Partial<Scenario> = {}) {
 const s={...scenario(p),inputs:[],expect:{outcome:{stage:'run',status:'completed'},observations:[]},...changes};put('project',p);put('run',s);return s;
}
it('blank and unbound saves are loadable, run preflight rejected, expected validation-negative preserves actual stage',()=>{
 cli(['new','--output','blank']);const blank=cli(['inspect','blank']).result.project;request(blank,{expect:{outcome:{stage:'validation',status:'rejected',code:'SOURCE_COUNT'},observations:[]}});
 cli(['validate','project','--scope','document']);cli(['validate','project','--scope','run'],4);
 expect(cli(['simulate','project','--scenario','run'],4).result).toMatchObject({validationOutcome:'rejected',runOutcome:'notStarted',finalTimeMs:null});
 expect(cli(['verify','project','--scenario','run']).result.observed.runOutcome).toBe('notStarted');
});
it('SOURCE_SHORT actual run fault, expected negative success, mismatch6 without disguising fault',()=>{
 const p=topology([supply],[[0,0,0,1]]);request(p,{expect:{outcome:{stage:'run',status:'faulted',code:'SOURCE_SHORT'},observations:[]}});
 expect(cli(['simulate','project','--scenario','run'],5).diagnostics[0].code).toBe('SOURCE_SHORT');
 const v=cli(['verify','project','--scenario','run']);expect(v.result).toMatchObject({verificationOutcome:'passed',observed:{runOutcome:'faulted',validationOutcome:'accepted'}});expect(v.diagnostics[0].severity).toBe('error');
 request(p);expect(cli(['verify','project','--scenario','run'],6).result.observed.runOutcome).toBe('faulted');
});
it('missing lamp return remains off, NC feedback modeled failure vs small settling resource incomplete',()=>{
 const p=selfhold();const missing={...p,sheets:p.sheets.map(s=>({...s,wires:s.wires.filter(w=>w.id!=='wire8')}))};
 request(missing,{inputs:scenario(missing).inputs,expect:{outcome:{stage:'run',status:'completed'},observations:[{atMs:20,target:{kind:'device',id:'device6'},observable:'lit',expected:{quality:'known',value:false}}]}});cli(['verify','project','--scenario','run']);
 request(feedback(),{expect:{outcome:{stage:'run',status:'faulted',code:'NONCONVERGENT'},observations:[]}});cli(['simulate','project','--scenario','run'],5);cli(['verify','project','--scenario','run']);
 request(cascade(),{limits:{maxDeltaCycles:1,maxEvents:100,maxTraceEntries:100},expect:{outcome:{stage:'run',status:'faulted',code:'SETTLING_LIMIT'},observations:[]}});
 for(const cmd of ['simulate','verify']){const out=cli([cmd,'project','--scenario','run'],7);expect(out.diagnostics[0].code).toBe('SETTLING_LIMIT');if(cmd==='verify')expect(out.result.verificationOutcome).toBe('incomplete');}
});
it('resource trace incomplete, missing expect and inherited probe syntax reject, unavailable expectations cannot pass',()=>{
 const p=selfhold();request(p,{inputs:scenario(p).inputs,limits:{maxEvents:100,maxDeltaCycles:128,maxTraceEntries:1}});
 const r=cli(['verify','project','--scenario','run'],7);expect(r.result).toMatchObject({verificationOutcome:'incomplete',observed:{trace:{complete:false}}});expect(r.result.observed.finalTimeMs).toBeLessThan(50);
 const {expect:_e,...without}=scenario(p);put('run',without);cli(['verify','project','--scenario','run'],2);
 for(const observable of ['constructor','toString','valueOf']){put('run',{...scenario(p),probes:[{atMs:0,target:{kind:'device',id:'device3'},observable}]});cli(['simulate','project','--scenario','run'],2);}
 request(topology([supply],[]),{expect:{outcome:{stage:'run',status:'faulted',code:'SOURCE_SHORT'},observations:[]}});cli(['verify','project','--scenario','run'],6);
});
it.each(['{','{"format":1,"format":2}',JSON.stringify({format:'circuit-project',formatVersion:2}),Buffer.from([0xff,0xfe])])('rejects malformed/future/duplicate/invalid UTF-8 project as3',data=>{put('bad',data);cli(['inspect','bad'],3);});
it('semantic document4, oversized ingress7, inert labels and stdin bounds',()=>{
 const p=selfhold();put('semantic',{...p,devices:[p.devices[0],p.devices[0]]});cli(['inspect','semantic'],4);
 put('big',' '.repeat(10*1024*1024+1));cli(['inspect','big'],7);
 expect(cli(['inspect','-'],0,JSON.stringify({...p,title:'<script>fetch("https://example.invalid")</script> $(touch BAD)'})).result.project.title).toContain('<script>');
 cli(['inspect','-'],7,' '.repeat(10*1024*1024+1));
 expect(readdirSync(dir)).not.toContain('BAD');
});
it('checked-in sample is the CLI-built shared-command result, with truthful new defaults, and really verifies',()=>{
 const p=build();const sample=JSON.parse(readFileSync(resolve('examples/p0/selfhold.circuit.json'),'utf8'));expect(sample).toEqual(p);
 put('sample',sample);put('sample-scenario',JSON.parse(readFileSync(resolve('examples/p0/start-stop.scenario.json'),'utf8')));cli(['verify','sample','--scenario','sample-scenario']);
 expect(JSON.parse(readFileSync(resolve('examples/p0/build-selfhold.operations.json'),'utf8'))).toEqual(operations);
 // Raw wired bytes captured from the v1 Core CLI at 015d4c0b, not the pretty-printed sample.
 expect(createHash('sha256').update(readFileSync(join(dir,'wired'))).digest('hex'))
  .toBe('42b6663816eb260db19286b1d60a66cdf1ddcd34394211ebd3c0025d5e0b2842');
});
it('shared new identity validation, original extension indifference, scenario syntax, stdin conflict and inert requests',()=>{
 for(const extra of [['--project-id','bad id'],['--project-id','same','--sheet-id','same'],['--sheet-id','0invalid']])cli(['new','--output','new',...extra],2);
 expect(readdirSync(dir)).toEqual([]);
 const p=selfhold();put('own.CAD',p);cli(['inspect','own.CAD']);put('unsupported.CAD','not our JSON');cli(['inspect','unsupported.CAD'],3);
 put('project',p);
 for(const invalid of ['{','{"format":1,"for\\u006dat":2}',Buffer.from([0xff]),{...scenario(p),formatVersion:2},{...scenario(p),target:{...scenario(p).target,revision:99}}]){put('bad-scenario',invalid);cli(['simulate','project','--scenario','bad-scenario'],2);}
 cli(['edit','apply','-','--operations','-','--output','conflict'],2,'{}');cli(['simulate','-','--scenario','-'],2,'{}');
 expect(readdirSync(dir)).not.toContain('conflict');
});
it('SIGINT during a meaningful streaming run calls core cancel, returns130 incomplete, never untilMs',async()=>{
 const p=topology([supply,'core.pushbutton.no'],[]);
 request(p,{untilMs:10000,inputs:Array.from({length:10000},(_,n)=>({atMs:n,sequence:n+1,actions:[{instanceId:'instance1',action:n%2?'release':'press',payload:{}}]}))});
 const child=spawn(process.execPath,[entry,'verify','project','--scenario','run'],{cwd:dir,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',sent=false;
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',c=>stdout+=c);
 child.stderr.on('data',c=>{stderr+=c;if(!sent&&stderr.includes('Running bounded scenario')){sent=true;child.kill('SIGINT');}});
 const closed = new Promise<{code:number|null;signal:string|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
 let timer: ReturnType<typeof setTimeout> | undefined;
 try {
  const status = await Promise.race([closed, new Promise<never>((_resolve,reject) => {
   timer = setTimeout(() => reject(new Error(`SIGINT child timed out; stdout=${stdout}; stderr=${stderr}`)), 20000);
  })]);
  expect(sent).toBe(true);expect(status).toEqual({code:130,signal:null});const out=JSON.parse(stdout);expect(validateShape('response',out).valid).toBe(true);expect(out.result).toMatchObject({verificationOutcome:'incomplete',observed:{runOutcome:'interrupted',trace:{complete:false}}});expect(out.result.observed.finalTimeMs).toBeGreaterThanOrEqual(0);expect(out.result.observed.finalTimeMs).toBeLessThan(10000);expect(out.diagnostics.some((d:{severity:string})=>d.severity==='error')).toBe(true);
 } finally {
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await closed;
 }
});
