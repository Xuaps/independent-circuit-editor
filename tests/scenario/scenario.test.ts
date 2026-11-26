import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createScenarioRun, runScenario, validateScenario } from '../../src/core/scenario';
import { observe, verifyReport } from '../../src/core/verification';
import type { Project, Scenario } from '../../src/core/domain/types';
import { action, button, cascade, feedback, lamp, scenario, selfhold, supply, topology } from '../fixtures/scenarios/build';
function execute(p=selfhold(),s:Scenario=scenario(p),chunk=1) { const run=createScenarioRun(p,s,'run'); if(!run.ok)throw Error(JSON.stringify(run)); while(!run.value.done()){const step=run.value.drive(chunk);if(!step.ok)throw Error(JSON.stringify(step));}return run.value.report(); }
describe('bounded incremental scenario services',()=>{
  it('actually runs authored selfhold observations and verifies them through shared models',()=>{const p=selfhold(),s=scenario(p),r=execute(p,s);expect(r).toMatchObject({validationOutcome:'accepted',runOutcome:'completed',finalTimeMs:50,lastCommittedTimeMs:40,trace:{complete:true}});expect(verifyReport(r,s)!.verificationOutcome).toBe('passed');expect(r.trace.entries.map(f=>f.atMs)).toEqual([0,10,20,30,40]);});
  it('normalizes entity order/hidden labels/names and host chunks without erasing semantic differences, seed20261118/200',()=>{
    fc.assert(fc.property(fc.integer({min:1,max:20}),fc.array(fc.integer(),{minLength:30,maxLength:30}),(chunk,keys)=>{
      const p=structuredClone(selfhold()); const sort=<T>(xs:readonly T[],offset:number)=>xs.map((v,n)=>({v,k:keys[(offset+n)%keys.length]!})).sort((a,b)=>a.k-b.k).map(x=>x.v);
      const renamed:Project={...p,devices:sort(p.devices.map((d,n)=>({...d,name:`Renamed${n}`})),0),sheets:p.sheets.map(sh=>({...sh,instances:sort(sh.instances.map(i=>({...i,label:'hidden',markings:{...i.markings,showDeviceName:false,showLabel:false}})),7),wires:sort(sh.wires,14)}))};
      expect(execute(renamed,scenario(renamed),chunk)).toEqual(execute(p,scenario(p),1));
    }),{seed:20261118,numRuns:200});
  });
  it('host chunk boundaries preserve genuine fault/resource outcomes, times and diagnostics too',()=>{
    const cases=[
      {p:feedback(),code:'NONCONVERGENT',lower:{}},
      {p:cascade(),code:'SETTLING_LIMIT',lower:{maxDeltaCycles:3}},
      {p:topology([supply],[[0,0,0,1]]),code:'SOURCE_SHORT',lower:{}},
      {p:topology([supply,lamp,lamp],[[0,0,1,0],[1,1,2,0],[2,1,0,1]]),code:'UNSUPPORTED_TOPOLOGY',lower:{}}
    ];
    for(const {p,code,lower}of cases){const s:Scenario={...scenario(p),inputs:[],expect:{outcome:{stage:'run',status:'faulted',code},observations:[]}};const reports=[1,2,73].map(chunk=>{const d=createScenarioRun(p,s,'run',lower);if(!d.ok)throw Error('fixture');while(!d.value.done())d.value.drive(chunk);return d.value.report();});expect(reports[0]!.diagnostics[0]!.code).toBe(code);expect(reports[1]).toEqual(reports[0]);expect(reports[2]).toEqual(reports[0]);}
    for(const lower of [{maxEvents:2},{maxTraceEntries:2},{traceBytes:1}]){const reports=[1,3,100].map(chunk=>{const d=createScenarioRun(selfhold(),scenario(),'run',lower);if(!d.ok)throw Error('fixture');while(!d.value.done())d.value.drive(chunk);return d.value.report();});expect(reports[0]!.runOutcome).toBe('resourceLimited');expect(reports[1]).toEqual(reports[0]);expect(reports[2]).toEqual(reports[0]);}
  });
  it('stream-feeds all10000 same-time inputs rather than overflowing online1024; coalesces one final frame',()=>{
    const p=topology([supply,button],[]),s:Scenario={...scenario(p),untilMs:0,expect:{outcome:{stage:'run',status:'completed'},observations:[]},inputs:Array.from({length:10000},(_,n)=>({atMs:0,sequence:n+1,actions:[action('instance1',n%2?'release':'press')]}))};
    const r=execute(p,s,73);expect(r.runOutcome).toBe('completed');expect(r.trace.entries).toHaveLength(1);expect(observe(r,{atMs:0,target:{kind:'device',id:'device1'},observable:'pressed'})).toEqual({quality:'known',value:false});
  });
  it('bounded drive yields without claiming final time while events remain, cancel is truthful',()=>{
    const run=createScenarioRun(selfhold(),scenario(),'run');if(!run.ok)throw Error('fixture');expect(run.value.drive(1)).toMatchObject({ok:true,value:{done:false,processed:1}});expect(run.value.report().finalTimeMs).toBe(0);expect(run.value.report().runOutcome).toBe('running');expect(run.value.report().trace.complete).toBe(false);const canceled=run.value.cancel();expect(canceled.runOutcome).toBe('interrupted');expect(canceled.trace.complete).toBe(false);expect(verifyReport(canceled,scenario())!.verificationOutcome).toBe('incomplete');expect(run.value.drive(1)).toMatchObject({ok:true,value:{done:true,processed:0}});
  });
  it('t=0 external inputs precede first solve, and same-time transactions are not collapsed',()=>{
    const p=topology([supply,'core.pushbutton.nc'],[[0,0,1,0],[1,1,0,1]]),s:Scenario={...scenario(p),untilMs:0,inputs:[{atMs:0,sequence:1,actions:[action('instance1')]}],expect:undefined} as unknown as Scenario;
    // Remove optional expect instead of writing an undefined JSON property.
    const {expect:_e,...without}=s;const r=execute(p,without);expect(r.runOutcome).toBe('completed');expect(r.trace.entries).toHaveLength(1);
    const withRelease={...without,inputs:[...s.inputs,{atMs:0,sequence:2,actions:[action('instance1','release')]}]};const fault=execute(p,withRelease);expect(fault.diagnostics[0]!.code).toBe('SOURCE_SHORT');expect(fault.lastCommittedTimeMs).toBe(0);expect(fault.trace.entries).toEqual([]);
    const partial=createScenarioRun(p,withRelease,'run');if(!partial.ok)throw Error('fixture');partial.value.drive(1);expect(partial.value.report()).toMatchObject({runOutcome:'running',trace:{complete:false,entries:[]}});partial.value.drive(1);expect(partial.value.report().runOutcome).toBe('faulted');
  });
  it('probes observe final same-time state and observer-only probes never change physical trace or budgets',()=>{
    const p=selfhold(),base=scenario(p),s:Scenario={...base,inputs:[{atMs:10,sequence:1,actions:[action('instance2')]},{atMs:10,sequence:2,actions:[action('instance2','release')]}]};
    const r=execute(p,s),q={...s,probes:Array.from({length:51},(_,atMs)=>({atMs,target:{kind:'device' as const,id:'device3'},observable:'energized'}))};expect(execute(p,q,10)).toEqual(r);expect(observe(r,{atMs:10,target:{kind:'device',id:'device2'},observable:'pressed'})).toEqual({quality:'known',value:false});expect(observe(r,{atMs:11,target:{kind:'device',id:'device3'},observable:'energized'})).toEqual({quality:'known',value:true});
  });
  it.each([
    ['SCENARIO_TARGET',(s:Scenario)=>({...s,target:{...s.target,revision:1}})],
    ['SCENARIO_ORDER',(s:Scenario)=>({...s,inputs:[s.inputs[1]!,s.inputs[0]!]} )],
    ['SCENARIO_ORDER',(s:Scenario)=>({...s,inputs:[s.inputs[0]!,{...s.inputs[1]!,sequence:1}]} )],
    ['SCENARIO_ORDER',(s:Scenario)=>({...s,untilMs:5})],
    ['INVALID_ACTION',(s:Scenario)=>({...s,inputs:[{...s.inputs[0]!,actions:[action('instance3')]}]})],
    ['INVALID_ACTION',(s:Scenario)=>({...s,inputs:[{...s.inputs[0]!,actions:[action('instance2'),action('instance2')]}]})],
    ['INVALID_PROBE',(s:Scenario)=>({...s,probes:[{atMs:0,target:{kind:'device',id:'missing'},observable:'energized'}]})],
    ['INVALID_PROBE',(s:Scenario)=>({...s,probes:[{atMs:51,target:{kind:'device',id:'device3'},observable:'energized'}]})],
    ['INVALID_PROBE',(s:Scenario)=>({...s,probes:[{atMs:0,target:{kind:'instance',id:'instance3'},observable:'energized'}]})],
    ['EXPECTED_TYPE',(s:Scenario)=>({...s,expect:{...s.expect!,observations:[{...s.expect!.observations[0]!,expected:{quality:'known',value:null}}]}})]
  ] as const)('rejects semantic scenario error %s before execution', (code,change)=>{const result=validateScenario(selfhold(),change(scenario()));expect(result).toMatchObject({ok:false,diagnostics:[{code}]});});
  it('strict codec rejects malformed/duplicate/future/unsafe scenario ingress rather than fabricating a validation-negative run',()=>{for(const input of ['{"format":1,"format":1}',{...scenario(),extra:1},{...scenario(),formatVersion:2},{...scenario(),untilMs:NaN}])expect(createScenarioRun(selfhold(),input,'run').ok).toBe(false);});
  it('malformed project is a request failure, not an invented project identity or expected-negative report',()=>{expect(runScenario({title:'broken'},scenario(),'run').ok).toBe(false);});
  it('reaches a sparse maximum end time without iterating milliseconds or adding empty tick frames',()=>{const p=topology([supply],[]),s:Scenario={...scenario(p),untilMs:86400000,inputs:[],probes:[],expect:{outcome:{stage:'run',status:'completed'},observations:[]}};const r=execute(p,s);expect(r.finalTimeMs).toBe(86400000);expect(r.trace.entries).toHaveLength(1);});
  it('atomic action array order is irrelevant, but separate transaction order remains meaningful',()=>{
    const p=selfhold(),s:Scenario={...scenario(p),inputs:[{atMs:0,sequence:1,actions:[action('instance1'),action('instance2')]}]};
    expect(execute(p,s)).toEqual(execute(p,{...s,inputs:[{...s.inputs[0]!,actions:[...s.inputs[0]!.actions].reverse()}]}));
    const pressed:Scenario={...scenario(p),inputs:[{atMs:0,sequence:1,actions:[action('instance2')]},{atMs:0,sequence:2,actions:[action('instance2','release')]}]};
    const reversed:Scenario={...pressed,inputs:[{...pressed.inputs[1]!,sequence:1},{...pressed.inputs[0]!,sequence:2}]};
    expect(observe(execute(p,pressed),{atMs:0,target:{kind:'device',id:'device2'},observable:'pressed'})).not.toEqual(observe(execute(p,reversed),{atMs:0,target:{kind:'device',id:'device2'},observable:'pressed'}));
  });
  it('invalid execution options cannot masquerade as a successful validation-negative run',()=>{
    const p=topology([supply],[]),draft={...p,sheets:[{...p.sheets[0]!,instances:[]}]};
    expect(createScenarioRun(draft,{...scenario(draft),inputs:[],expect:undefined},'bad id').ok).toBe(false);
    const s:Scenario={...scenario(draft),inputs:[],expect:{outcome:{stage:'validation',status:'rejected',code:'SOURCE_COUNT'},observations:[]}};
    expect(createScenarioRun(draft,s,'bad id')).toMatchObject({ok:false,diagnostics:[{code:'INVALID_RUNTIME_OPTIONS'}]});
    expect(createScenarioRun(draft,s,'run',{maxEvents:100001})).toMatchObject({ok:false,diagnostics:[{code:'INVALID_RUNTIME_OPTIONS'}]});
  });
  it('malformed work command is rejected without changing in-progress report',()=>{const d=createScenarioRun(selfhold(),scenario(),'run');if(!d.ok)throw Error('fixture');const before=d.value.report();expect(d.value.drive(0).ok).toBe(false);expect(d.value.report()).toEqual(before);});
});
