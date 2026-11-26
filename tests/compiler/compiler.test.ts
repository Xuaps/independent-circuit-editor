import { expect, it } from 'vitest';
import fc from 'fast-check';
import { compileProject, terminalKey } from '../../src/core/compiler';
import { evaluateElectrical } from '../../src/core/electrical';
import { topology, selfhold, supply, lamp, button } from '../fixtures/topologies/build';
function compile(p: Project) { const r = compileProject(p); if (!r.ok) throw Error(JSON.stringify(r)); return r.value; }
import type { Project, Wire } from '../../src/core/domain/types';
function normalized(p: Project) {
  const c = compile(p);
  return { projectId:c.projectId, revision:c.revision, modelSet:c.modelSet, nodes:c.nodes, wires:c.wires, source:c.source, contacts:c.contacts, loads:c.loads, nets:c.nets };
}
it('normalizes entity permutations and evaluations seed20261117/500', () => {
  const base = selfhold();
  const p: Project = { ...base, sheets: [{ ...base.sheets[0]!,
    junctions: [{id:'junctionB',position:{x:800,y:100}},{id:'junctionA',position:{x:700,y:100}}],
    annotations: [{id:'noteB',position:{x:800,y:200},text:'Own B'},{id:'noteA',position:{x:700,y:200},text:'Own A'}],
    wires: [...base.sheets[0]!.wires,{id:'extraWire',from:{kind:'junction',junctionId:'junctionA'},to:{kind:'junction',junctionId:'junctionB'},waypoints:[]}]
  }] };
  const expected = normalized(p), states = [1,2,4,5].map(n=>({instanceId:`instance${n}`,closed:{quality:'known',value:true}}));
  const result = evaluateElectrical(compile(p),states);
  fc.assert(fc.property(fc.array(fc.integer(),{minLength:32,maxLength:32}), keys => {
    let k = 0;
    const shuffle = <T,>(items: readonly T[]): T[] => items.map(x=>({x,key:keys[(k++)%keys.length]!})).sort((a,b)=>a.key-b.key).map(a=>a.x);
    const candidate = {...p,devices:shuffle(p.devices),sheets:p.sheets.map(s=>({...s,instances:shuffle(s.instances),junctions:shuffle(s.junctions),wires:shuffle(s.wires),annotations:shuffle(s.annotations)}))};
    expect(normalized(candidate)).toEqual(expected);
    expect(evaluateElectrical(compile(candidate),shuffle(states))).toEqual(result);
  }),{seed:20261117,numRuns:500});
});
it('exposes frozen private membership queries isolated from caller mutation', () => {
  const input = structuredClone(topology([supply,lamp],[[0,0,1,0],[1,1,0,1]]));
  const c = compile(input), node = c.terminal('instance1','p1')!;
  expect(c.node(node.id)).toBe(node); expect(c.net(node.id)).toBe(c.wireNet('wire0'));
  expect(c.net(node.id)!.wireIds).toEqual(['wire0']);
  expect(Object.isFrozen(c)).toBe(true); expect(Object.isFrozen(c.nets[0])).toBe(true);
  expect(()=> (c.loads as unknown[]).push({})).toThrow();
  (input as unknown as {revision:number}).revision = 99;
  (input.sheets[0]!.wires as Wire[]).pop();
  expect(c.revision).toBe(0); expect(c.wires).toHaveLength(2);
  expect(evaluateElectrical(c,[])).toMatchObject({ok:true,loads:[{powered:true}]});
  expect(c.node('constructor')).toBeUndefined(); expect(c.wireNet('toString')).toBeUndefined();
});
it('legal prototype-like instance and device identities remain safe and separate', () => {
  const p = topology([supply,lamp],[]), s = p.sheets[0]!;
  const q = {...p,devices:p.devices.map((d,i)=>({...d,id:i?'hasOwnProperty':'valueOf'})),sheets:[{...s,instances:s.instances.map((x,i)=>({...x,id:i?'toString':'constructor',deviceId:i?'hasOwnProperty':'valueOf'}))}]};
  const c = compile(q); expect(c.terminal('constructor','plus')!.id).toBe(terminalKey('constructor','plus'));
  expect(c.net(terminalKey('constructor','plus'))).not.toBe(c.net(terminalKey('toString','p1')));
});
it('crossing routes and coincident dangling positions never connect; explicit junction does', () => {
  const p = topology([supply,lamp],[]), s = p.sheets[0]!;
  const wires: Wire[] = [
    {id:'horizontal',from:{kind:'dangling',position:{x:100,y:100}},to:{kind:'dangling',position:{x:300,y:100}},waypoints:[]},
    {id:'vertical',from:{kind:'dangling',position:{x:200,y:50}},to:{kind:'dangling',position:{x:200,y:150}},waypoints:[]},
    {id:'coincident',from:{kind:'dangling',position:{x:100,y:100}},to:{kind:'dangling',position:{x:50,y:100}},waypoints:[]}
  ];
  const c = compile({...p,sheets:[{...s,wires}]});
  expect(c.wireNet('horizontal')).not.toBe(c.wireNet('vertical')); expect(c.wireNet('horizontal')).not.toBe(c.wireNet('coincident'));
  const joined = compile({...p,sheets:[{...s,junctions:[{id:'join',position:{x:100,y:100}}],wires:wires.filter(w=>w.id!=='vertical').map(w=>({...w,from:{kind:'junction' as const,junctionId:'join'}}))}]});
  expect(joined.wireNet('horizontal')).toBe(joined.wireNet('coincident'));
});
it('coincident terminals, labels and shared device observer identity do not conduct', () => {
  const p = selfhold(), s = p.sheets[0]!;
  const c = compile({...p,sheets:[{...s,wires:[],instances:s.instances.map(i=>({...i,label:'same',transform:{...i.transform,position:{x:200,y:200}}}))}]});
  expect(c.net(terminalKey('instance4','p1'))).not.toBe(c.net(terminalKey('instance5','p1')));
  expect(c.net(terminalKey('instance1','p1'))).not.toBe(c.net(terminalKey('instance2','p1')));
  expect(c.contacts.filter(x=>x.deviceId==='device3')).toHaveLength(2);
});
it('checked ingress separates malformed/document/preflight rejection from electrical faults', () => {
  expect(compileProject({})).toMatchObject({ok:false,diagnostics:[{code:'INVALID_SHAPE'}]});
  const p = topology([supply,button],[]), s = p.sheets[0]!;
  expect(compileProject({...p,sheets:[{...s,instances:s.instances.map(i=>({...i,deviceId:null}))}]})).toMatchObject({ok:false});
  expect(compileProject(topology([lamp],[]))).toMatchObject({ok:false,diagnostics:[{code:'SOURCE_COUNT'}]});
  expect(compileProject(topology([supply,supply],[]))).toMatchObject({ok:false,diagnostics:[{code:'SOURCE_COUNT'}]});
  const unknown = {...p,sheets:[{...s,instances:s.instances.map(i=>({...i,definition:{id:'unknown',version:1 as const}}))}]};
  expect(compileProject(unknown)).toMatchObject({ok:false,diagnostics:[{code:'INVALID_SHAPE'}]});
  expect(compileProject({...p,sheets:[{...s,instances:[s.instances[0]!,{...s.instances[1]!,deviceId:'device0'}]}]})).toMatchObject({ok:false,diagnostics:[{code:'INCOMPATIBLE_DEVICE'}]});
  const h = selfhold();
  const missing = {...h,sheets:[{...h.sheets[0]!,instances:h.sheets[0]!.instances.filter(i=>i.id!=='instance3'),wires:[]}]};
  expect(compileProject(missing)).toMatchObject({ok:false,diagnostics:[{code:'MISSING_CONTROLLER'}]});
  const duplicate = {...h,sheets:[{...h.sheets[0]!,instances:[...h.sheets[0]!.instances,{...h.sheets[0]!.instances[3]!,id:'secondCoil'}]}]};
  expect(compileProject(duplicate)).toMatchObject({ok:false,diagnostics:[{code:'DUPLICATE_CONTROLLER'}]});
});
it('diagnostics are deterministic under invalid entity permutations', () => {
  const p = topology([supply,button,button],[]), s = p.sheets[0]!;
  const instances = s.instances.map(i=>({...i,deviceId:null}));
  expect(compileProject({...p,sheets:[{...s,instances}]})).toEqual(compileProject({...p,devices:[...p.devices].reverse(),sheets:[{...s,instances:[...instances].reverse()}]}));
});
it('large bounded conductor chain compiles and evaluates without recursive traversal', () => {
  const p = topology([supply],[]), s = p.sheets[0]!;
  const junctions = Array.from({length:9000},(_,i)=>({id:`junction${i}`,position:{x:100+i,y:200}}));
  const wires: Wire[] = junctions.slice(1).map((j,i)=>({id:`wire${i}`,from:{kind:'junction',junctionId:junctions[i]!.id},to:{kind:'junction',junctionId:j.id},waypoints:[]}));
  const c = compile({...p,sheets:[{...s,junctions,wires}]});
  expect(c.wireNet('wire0')!.wireIds).toHaveLength(8999); expect(evaluateElectrical(c,[])).toMatchObject({ok:true});
});
