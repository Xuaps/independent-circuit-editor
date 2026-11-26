import { describe, expect, it } from 'vitest';
import { validateShape } from '../../src/contracts/validation';
import { createScenarioRun, runScenario } from '../../src/core/scenario';
import { observe, verifyReport, verifyScenario } from '../../src/core/verification';
import type { Project, Scenario } from '../../src/core/domain/types';
import { action, feedback, lamp, scenario, selfhold, supply, topology } from '../fixtures/scenarios/build';
function run(p:Project,s:Scenario,lower={}){const r=runScenario(p,s,'run',lower);if(!r.ok)throw Error(JSON.stringify(r));return r.value;}
function negative(p:Project,code:string,stage:'run'|'validation'='run'):Scenario{return{...scenario(p),inputs:[],expect:{outcome:stage==='run'?{stage,status:'faulted',code}:{stage,status:'rejected',code},observations:[]}};}
describe('truthful stage/outcome and observation verification',()=>{
  it.each([
    ['SOURCE_SHORT',()=>topology([supply],[[0,0,0,1]])],
    ['UNSUPPORTED_TOPOLOGY',()=>topology([supply,lamp,lamp],[[0,0,1,0],[1,1,2,0],[2,1,0,1]])],
    ['NONCONVERGENT',feedback]
  ] as const)('passes expected modeled %s without disguising observed fault or diagnostics', (code,build)=>{
    const p=build(),s=negative(p,code),r=run(p,s),v=verifyReport(r,s)!;expect(v.verificationOutcome).toBe('passed');expect(v.observed).toBeDefined();expect(r.runOutcome).toBe('faulted');expect(r.trace.complete).toBe(true);expect(r.diagnostics[0]!.code).toBe(code);expect(r.finalTimeMs).toBe(0);expect(r.lastCommittedTimeMs).toBeNull();expect(r.trace.entries).toEqual([]);
    const mismatch={...s,expect:{...s.expect!,outcome:{stage:'run' as const,status:'faulted' as const,code:'WRONG_CODE'}}};expect(verifyReport(r,mismatch)!.verificationOutcome).toBe('failed');
  });
  it.each(['source','unbound','missing','duplicate'] as const)('matches genuinely loadable preflight-rejected %s draft, not malformed requests',kind=>{
    const base=structuredClone(selfhold());let p:Project=base;
    if(kind==='source')p={...base,sheets:[{...base.sheets[0]!,instances:base.sheets[0]!.instances.filter(i=>i.id!=='instance0'),wires:base.sheets[0]!.wires.filter(w=>!(w.from.kind==='port'&&w.from.instanceId==='instance0')&&!(w.to.kind==='port'&&w.to.instanceId==='instance0'))}]};
    if(kind==='unbound')p={...base,sheets:[{...base.sheets[0]!,instances:base.sheets[0]!.instances.map(i=>i.id==='instance4'?{...i,deviceId:null}:i)}]};
    if(kind==='missing')p={...base,sheets:[{...base.sheets[0]!,instances:base.sheets[0]!.instances.filter(i=>i.id!=='instance3'),wires:base.sheets[0]!.wires.filter(w=>!(w.from.kind==='port'&&w.from.instanceId==='instance3')&&!(w.to.kind==='port'&&w.to.instanceId==='instance3'))}]};
    if(kind==='duplicate'){const coil=base.sheets[0]!.instances.find(i=>i.id==='instance3')!;p={...base,sheets:[{...base.sheets[0]!,instances:[...base.sheets[0]!.instances,{...coil,id:'secondCoil'}]}]};}
    const s=negative(p,'PLACEHOLDER','validation'),r=run(p,s);expect(r.validationOutcome).toBe('rejected');expect(r.runOutcome).toBe('notStarted');expect(r.finalTimeMs).toBeNull();expect(r.diagnostics.length).toBeGreaterThan(0);
    const actual={...s,expect:{...s.expect!,outcome:{stage:'validation' as const,status:'rejected' as const,code:r.diagnostics[0]!.code}}};expect(verifyReport(r,actual)!.verificationOutcome).toBe('passed');expect(verifyReport(r,negative(p,r.diagnostics[0]!.code))!.verificationOutcome).toBe('failed');
  });
  it('verification requires expect but simulation does not',()=>{const s=scenario();const {expect:_e,...without}=s;expect(run(selfhold(),without).runOutcome).toBe('completed');expect(verifyReport(run(selfhold(),without),without)).toBeUndefined();});
  it('known false is a real assertion, not the default for unknown/faulted/missing',()=>{
    const p=selfhold(),s=scenario(p),r=run(p,s);expect(verifyReport(r,s)!.checks.every(c=>c.passed)).toBe(true);
    const changed={...s,expect:{...s.expect!,observations:[{...s.expect!.observations[0]!,expected:{quality:'known' as const,value:true}}]}};expect(verifyReport(r,changed)!.verificationOutcome).toBe('failed');
    const missing={...s,expect:{...s.expect!,observations:[{atMs:51,target:{kind:'device' as const,id:'device3'},observable:'energized',expected:{quality:'known' as const,value:false}}]}};expect(verifyReport(r,missing)!.verificationOutcome).toBe('incomplete');
  });
  it('expected-negative fault cannot pass with unavailable required later observations',()=>{
    const p=topology([supply],[[0,0,0,1]]),s=negative(p,'SOURCE_SHORT'),withProbe={...s,expect:{...s.expect!,observations:[{atMs:10,target:{kind:'device' as const,id:'device0'},observable:'enabled',expected:{quality:'known' as const,value:false}}]}};
    const r=run(p,withProbe),v=verifyReport(r,withProbe)!;expect(v.verificationOutcome).toBe('incomplete');expect(v.checks).toHaveLength(2);expect(v.checks[0]!.passed).toBe(true);expect(v.checks[1]!.passed).toBe(false);
  });
  it('metadata-only unused devices have unknown observables, never a passing normal false assertion',()=>{
    const base=selfhold(),p:Project={...base,devices:[...base.devices,{id:'unusedRelay',name:'Unused',kind:'relay',parameters:{},initial:{}}]},s:Scenario={...scenario(p),expect:{outcome:{stage:'run',status:'completed'},observations:[{atMs:50,target:{kind:'device',id:'unusedRelay'},observable:'energized',expected:{quality:'known',value:false}}]}};
    const r=run(p,s);expect(r.runOutcome).toBe('completed');expect(observe(r,s.expect!.observations[0]!)).toEqual({quality:'unknown',code:'UNPLACED_DEVICE'});expect(verifyReport(r,s)!.verificationOutcome).toBe('incomplete');
  });
  it('required unavailable values cannot pass even when the assertion expects matching unavailable quality',()=>{
    const p=topology([supply],[[0,0,0,1]]),s=negative(p,'SOURCE_SHORT');const withProbe={...s,expect:{...s.expect!,observations:[{atMs:0,target:{kind:'device' as const,id:'device0'},observable:'enabled',expected:{quality:'faulted' as const,code:'SOURCE_SHORT'}}]}};expect(verifyReport(run(p,withProbe),withProbe)!.verificationOutcome).toBe('incomplete');
  });
  it.each([{maxEvents:1},{maxTraceEntries:1},{traceBytes:1},{maxDeltaCycles:1}])('resource exhaustion %j is incomplete, never expected-negative success',lower=>{
    const p=selfhold(),s=scenario(p),r=run(p,s,lower);expect(r.runOutcome).toBe('resourceLimited');expect(r.trace.complete).toBe(false);
    const expected={...s,expect:{outcome:{stage:'run' as const,status:'faulted' as const,code:r.diagnostics[0]!.code},observations:[]}};expect(verifyReport(r,expected)!.verificationOutcome).toBe('incomplete');
  });
  it('a fault after earlier committed history ends at actual attempt, no later probe or normal-off claim',()=>{
    const p=topology([supply,'core.pushbutton.no'],[[0,0,1,0],[1,1,0,1]]),s:Scenario={...negative(p,'SOURCE_SHORT'),inputs:[{atMs:10,sequence:1,actions:[action('instance1')]}]};const r=run(p,s);expect(r).toMatchObject({finalTimeMs:10,lastCommittedTimeMs:0,runOutcome:'faulted'});expect(r.trace.entries.map(f=>f.atMs)).toEqual([0]);expect(observe(r,{atMs:9,target:{kind:'device',id:'device1'},observable:'pressed'})).toEqual({quality:'known',value:false});expect(observe(r,{atMs:10,target:{kind:'device',id:'device1'},observable:'pressed'})).toEqual({quality:'faulted',code:'SOURCE_SHORT'});expect(observe(r,{atMs:11,target:{kind:'device',id:'device1'},observable:'pressed'}).quality).toBe('unknown');
  });
  it('canceled execution never passes even without required observations',()=>{const s=scenario(),d=createScenarioRun(selfhold(),s,'run');if(!d.ok)throw Error('fixture');d.value.drive(2);const r=d.value.cancel();expect(verifyReport(r,{...s,expect:{outcome:{stage:'run',status:'completed'},observations:[]}})!.verificationOutcome).toBe('incomplete');});
  it('projects actual positive and expected-negative reports into the unchanged response wire shape',()=>{
    for(const p of [selfhold(),topology([supply],[[0,0,0,1]])]){
      const s=p.devices.length===1?negative(p,'SOURCE_SHORT'):scenario(p),r=run(p,s),v=verifyReport(r,s)!;
      const {lastCommittedTimeMs:_time,diagnostics,...wire}=r;
      const envelope={apiVersion:1,command:'verify',ok:true,exitCode:0,diagnostics,result:{observed:wire,verificationOutcome:v.verificationOutcome,checks:v.checks,expectedOutcome:v.expectedOutcome}};
      expect(validateShape('response',envelope).valid).toBe(true);
      expect(validateShape('response',{...envelope,result:{...envelope.result,observed:r}}).valid).toBe(false);
    }
  });
  it('verification use case rejects missing expect before executing, and reuses actual validated run',()=>{
    const s=scenario(),{expect:_e,...without}=s;
    expect(verifyScenario(selfhold(),without,'run')).toMatchObject({ok:false,diagnostics:[{code:'EXPECT_REQUIRED'}]});
    expect(verifyScenario(selfhold(),s,'run')).toMatchObject({ok:true,value:{verificationOutcome:'passed',observed:{runOutcome:'completed'}}});
  });
  it('does not verify a report against a different project identity or end time',()=>{
    const s=scenario(),r=run(selfhold(),s);
    expect(verifyReport(r,{...s,target:{...s.target,revision:1}})!.verificationOutcome).toBe('failed');
    expect(verifyReport(r,{...s,untilMs:51})!.verificationOutcome).toBe('failed');
  });
  it('check IDs/counts and repeated reports are deterministic and plain cloneable',()=>{const s=scenario(),r=run(selfhold(),s),v=verifyReport(r,s)!;expect(v.checks.map(c=>c.id)).toEqual(['outcome',...s.expect!.observations.map((_,n)=>`observation_${n}`)]);expect(structuredClone(v)).toEqual(v);expect(verifyReport(r,s)).toEqual(v);});
});
