import { expect, it } from 'vitest';
import { compileProject, type Compiled } from '../../src/core/compiler';
import { evaluateElectrical } from '../../src/core/electrical';
import { topology, selfhold, supply, lamp, button } from '../fixtures/topologies/build';
import type { Project } from '../../src/core/domain/types';
export function compile(p: Project): Compiled { const r = compileProject(p); if (!r.ok) throw Error(JSON.stringify(r)); return r.value; }
const states = (...closed: boolean[]) => closed.map((value,i) => ({ instanceId: `instance${i+1}`, closed: { quality:'known', value } }));
it('independent parallel loads including reversed nonpolar terminals', () => {
  const c = compile(topology([supply,lamp,lamp],[[0,0,1,0],[1,1,0,1],[0,1,2,0],[2,1,0,0]]));
  const r = evaluateElectrical(c,[]); expect(r.ok).toBe(true);
  if(r.ok) expect(r.loads.map(l=>l.powered)).toEqual([true,true]);
});
it.each([[[0,0,1,0]], [[0,1,1,1]], [], [[0,0,1,0],[0,0,1,1]]].map(links => ({links: links as [number,number,number,number][]})))('missing rail/disconnected/same rail valid off $links', ({links}) => {
  const r = evaluateElectrical(compile(topology([supply,lamp],links)),[]);
  expect(r.ok).toBe(true); if(r.ok) expect(r.loads[0]!.powered).toBe(false);
});
it('reversed nonpolar coil is powered independently of presentation or name', () => {
  const c = compile(topology([supply,'core.relay.coil'],[[0,1,1,0],[0,0,1,1]]));
  expect(evaluateElectrical(c,[])).toMatchObject({ok:true,loads:[{powered:true,a:'return',b:'positive'}]});
});
it('missing return stays floating without load-mediated propagation', () => {
  const r = evaluateElectrical(compile(topology([supply,lamp],[[0,0,1,0]])),[]);
  if(!r.ok) throw Error(); expect(r.loads[0]).toMatchObject({a:'positive',b:'floating',powered:false});
});
it('direct conductor short faults with no successful outputs', () => {
  const r = evaluateElectrical(compile(topology([supply,lamp],[[0,0,0,1],[0,0,1,0],[1,1,0,1]])),[]);
  expect(r).toMatchObject({ok:false,kind:'fault',diagnostics:[{code:'SOURCE_SHORT',objectIds:['instance0']}]}); expect(r).not.toHaveProperty('loads');
});
it('contact closure changes topology without stale nets and short has priority', () => {
  const c = compile(topology([supply,button,lamp],[[0,0,1,0],[1,1,0,1],[0,0,2,0],[2,1,0,1]]));
  expect(evaluateElectrical(c,states(false))).toMatchObject({ok:true,loads:[{powered:true}]});
  expect(evaluateElectrical(c,states(true))).toMatchObject({ok:false,kind:'fault'});
  expect(evaluateElectrical(c,states(false))).toMatchObject({ok:true,loads:[{powered:true}]});
});
it('series plus direct branch is evaluation unsupported, not compile rejection', () => {
  const c = compile(topology([supply,lamp,lamp,lamp],[[0,0,1,0],[1,1,2,0],[2,1,0,1],[0,0,3,0],[3,1,0,1]]));
  const r = evaluateElectrical(c,[]); expect(r).toMatchObject({ok:false,kind:'unsupported',diagnostics:[{code:'UNSUPPORTED_TOPOLOGY'}]}); expect(r).not.toHaveProperty('loads');
});
it('own selfhold electrical snapshots only (no behavior/time)', () => {
  const c = compile(selfhold());
  function evaluate(values: boolean[]) { return evaluateElectrical(c,[1,2,4,5].map((n,i)=>({instanceId:`instance${n}`,closed:{quality:'known',value:values[i]}}))); }
  expect(evaluate([true,false,false,false])).toMatchObject({ok:true,loads:[{powered:false},{powered:false}]});
  expect(evaluate([true,true,false,false])).toMatchObject({ok:true,loads:[{powered:true},{powered:false}]});
  expect(evaluate([true,false,true,true])).toMatchObject({ok:true,loads:[{powered:true},{powered:true}]});
  expect(evaluate([false,false,true,true])).toMatchObject({ok:true,loads:[{powered:false},{powered:true}]});
});
it('rejects incomplete, unknown, duplicated or unavailable contact state', () => {
  const c = compile(topology([supply,button],[]));
  for (const input of [[],states(false,false),[{instanceId:'wrong',closed:{quality:'known',value:false}}],[{instanceId:'instance1',closed:{quality:'unknown',code:'WAIT'}}], [{instanceId:'instance1',closed:{quality:'known',value:0}}]]) expect(evaluateElectrical(c,input)).toMatchObject({ok:false,kind:'invalid-input'});
  const two = compile(topology([supply,button,button],[])); expect(evaluateElectrical(two,[...states(false),...states(false)])).toMatchObject({ok:false});
});
it('bounds work, rejects forged compilation, freezes outputs and isolates contact input', () => {
  const c = compile(topology([supply,button],[])), input = states(true);
  const r = evaluateElectrical(c,input); input[0]!.closed.value = false;
  expect(Object.isFrozen(r)).toBe(true); if(r.ok) { expect(Object.isFrozen(r.nets[0]!.nodeIds)).toBe(true); expect(()=> (r.nets as unknown[]).pop()).toThrow(); }
  expect(evaluateElectrical(c,input,0)).toMatchObject({ok:false,kind:'resource-limit'});
  expect(evaluateElectrical({...c},input)).toMatchObject({ok:false,kind:'invalid-input'});
});
