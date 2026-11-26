import { describe, expect, it } from 'vitest';
import { createEngine, getModel, models, RUNTIME_LIMITS, runtimeLimits, type Engine, type RuntimeLimits } from '../../src/core/engine';
import { definitions, profileStatus } from '../../src/core/catalog';
import type { Project } from '../../src/core/domain/types';
import { action, button, cascade, feedback, lamp, selfhold, supply, topology } from '../fixtures/scenarios/build';
function engine(p = selfhold(), limits: Partial<RuntimeLimits> = {}): Engine { const e = createEngine(p, 'run', limits); if (!e.ok) throw Error(JSON.stringify(e)); return e.value; }
const input = (e: Engine, sequence: number, atMs: number, actions = [action('instance2')]) => e.request({ runId: 'run', revision: 0, sequence, atMs, actions });
function value(e: Engine, id: string, observable: string) { return e.view().live.find(o => o.target.id === id && o.observable === observable)?.value; }
const k = (v: boolean) => ({ quality: 'known', value: v });
describe('trusted models and private deterministic settling', () => {
  it('covers each catalog/version/ports/actions/channel without changing preserved metadata', () => {
    expect(models).toHaveLength(7); expect(profileStatus).toBe('proposed-not-implemented');
    for (const d of definitions) {
      const m = getModel(d.id, d.version)!;
      expect(m.definition).toBe(d); expect(d.behavior.implementation).toBe('implemented');
      expect(Object.keys(m.instanceValues(false, false)).sort()).toEqual(Object.keys(d.observables).sort());
      expect(m.definition.ports).toEqual(d.ports); expect(m.definition.actions).toEqual(d.actions);
      expect(getModel(d.id, 2)).toBeUndefined();
    }
    expect(getModel('constructor')).toBeUndefined();
  });
  it('executes exact selfhold and all device/instance channels', () => {
    const e = engine(); expect(e.view().live.every(o => o.value.quality === 'unknown')).toBe(true);
    e.initialize(); expect(value(e,'device0','enabled')).toEqual(k(true)); expect(value(e,'device2','pressed')).toEqual(k(false));
    expect(value(e,'instance1','closed')).toEqual(k(true)); expect(value(e,'instance2','closed')).toEqual(k(false));
    expect(value(e,'device3','energized')).toEqual(k(false)); expect(value(e,'instance3','powered')).toEqual(k(false));
    [10,20,30,40].forEach((t,n) => { expect(input(e,n+1,t,[action(n < 2 ? 'instance2' : 'instance1', n % 2 ? 'release' : 'press')]).ok).toBe(true); e.drive(t); const on = n < 2; expect(value(e,'device3','energized')).toEqual(k(on)); expect(value(e,'instance5','closed')).toEqual(k(on)); expect(value(e,'device6','lit')).toEqual(k(on)); expect(value(e,'instance6','lit')).toEqual(k(on)); });
    e.drive(50); expect(e.view().timeMs).toBe(50); expect(e.view().history.map(f => f.atMs)).toEqual([0,10,20,30,40]);
  });
  it('initializes a directly powered relay before first public frame', () => {
    const e = engine(topology([supply,'core.relay.coil'],[[0,0,1,0],[1,1,0,1]])); e.initialize(); expect(value(e,'device1','energized')).toEqual(k(true)); expect(e.view().history).toHaveLength(1);
  });
  it('opens a rest-state NC short with requested zero-time input before any solve', () => {
    const p = topology([supply,'core.pushbutton.nc'],[[0,0,1,0],[1,1,0,1]]);
    const e = engine(p); expect(input(e,1,0,[action('instance1')]).ok).toBe(true); e.drive(0); expect(e.view().status).toBe('active'); expect(value(e,'instance1','closed')).toEqual(k(false)); expect(e.view().processedEvents).toBe(1);
    const rest = engine(p); rest.initialize(); expect(rest.view().status).toBe('faulted'); expect(rest.view().history).toEqual([]);
  });
  it('keeps missing lamp return off even while relay control energizes', () => {
    const p = structuredClone(selfhold()); const s = p.sheets[0]!;
    const e = engine({ ...p, sheets: [{ ...s, wires: s.wires.filter(w => w.id !== 'wire8') }] });
    input(e,1,0); e.drive(0); expect(value(e,'device3','energized')).toEqual(k(true)); expect(value(e,'device6','lit')).toEqual(k(false));
    expect(e.view().electrical!.loads.find(l => l.instanceId==='instance6')).toMatchObject({powered:false,a:'positive',b:'floating'});
  });
  it('projects explicit NC observer inversion, not UI/name inversion', () => {
    const p = topology([supply,'core.relay.coil','core.relay.contact.nc'],[[0,0,1,0],[1,1,0,1]]);
    const e = engine({ ...p, devices: p.devices.slice(0,2), sheets: [{ ...p.sheets[0]!, instances: p.sheets[0]!.instances.map((i,n) => n===2 ? {...i,deviceId:'device1'} : i) }] });
    e.initialize(); expect(value(e,'device1','energized')).toEqual(k(true)); expect(value(e,'instance2','closed')).toEqual(k(false));
  });
  it('detects repeated complete state as NONCONVERGENT with no candidate commit', () => {
    const e = engine(feedback()); e.initialize(); const v = e.view(); expect(v.status).toBe('faulted'); expect(v.diagnostics[0]!.code).toBe('NONCONVERGENT'); expect(v.history).toEqual([]); expect(v.lastCommittedTimeMs).toBeNull(); expect(v.live.every(o => o.value.quality === 'faulted')).toBe(true);
  });
  it('distinguishes acyclic lower-delta exhaustion from repeated state', () => {
    const e = engine(cascade(),{maxDeltaCycles:3}); e.initialize(); expect(e.view().status).toBe('resourceLimited'); expect(e.view().diagnostics[0]!.code).toBe('SETTLING_LIMIT'); expect(e.view().complete).toBe(false); expect(e.view().history).toEqual([]);
    const full = engine(cascade()); full.initialize(); expect(full.view().status).toBe('active'); expect(value(full,'device9','energized')).toEqual(k(true));
  });
  it('direct short fails before the first energized public payload', () => {
    const e = engine(topology([supply,lamp],[[0,0,0,1],[0,0,1,0],[1,1,0,1]])); e.initialize(); expect(e.view().diagnostics[0]!.code).toBe('SOURCE_SHORT'); expect(e.view().live.every(o => o.value.quality === 'faulted')).toBe(true); expect(e.view().history).toEqual([]);
  });
  it('rolls back a later dynamic short and reports attempted rather than requested target time', () => {
    const e = engine(topology([supply,button],[[0,0,1,0],[1,1,0,1]])); e.initialize(); input(e,1,10,[action('instance1')]); input(e,2,20,[action('instance1','release')]); e.drive(50,10);
    const v=e.view(); expect(v.status).toBe('faulted'); expect(v.timeMs).toBe(10); expect(v.lastCommittedTimeMs).toBe(0); expect(v.pending).toEqual([]); expect(v.history).toHaveLength(1); expect(v.history[0]!.observations.find(o => o.observable==='pressed')!.value).toEqual(k(false));
    expect(e.drive(50).ok).toBe(false); expect(value(e,'device1','pressed')!.quality).toBe('faulted');
  });
  it('rechecks unsupported series after a button closes and preserves unsupported quality', () => {
    const e = engine(topology([supply,lamp,button,lamp],[[0,0,1,0],[1,1,2,0],[2,1,3,0],[3,1,0,1]])); e.initialize(); expect(e.view().status).toBe('active'); input(e,1,8); e.drive(50); const v=e.view(); expect(v.timeMs).toBe(8); expect(v.diagnostics[0]!.code).toBe('UNSUPPORTED_TOPOLOGY'); expect(v.live.every(o => o.value.quality==='unsupported')).toBe(true);
  });
  it('applies distinct buttons atomically and does not collapse ordered press/release pairs', () => {
    const e = engine(); e.initialize(); input(e,1,10,[action('instance1'),action('instance2')]); e.drive(10); expect(value(e,'device3','energized')).toEqual(k(false));
    input(e,2,20,[action('instance1','release')]); input(e,3,20,[action('instance2','release')]); e.drive(20,10);
    expect(value(e,'device3','energized')).toEqual(k(true)); expect(e.view().processedEvents).toBe(3); expect(e.view().history.map(f=>f.atMs)).toEqual([0,10,20]);
  });
  it.each([
    {runId:'wrong'}, {revision:1}, {sequence:0}, {sequence:1}, {sequence:1.1}, {atMs:-1}, {atMs:1.1}, {atMs:86400001}, {atMs:0}, {actions:[action('instance3')]}, {actions:[action('instance2'),action('instance2','release')]}, {actions:[{...action('instance2'),payload:{x:1}}]}, {actions:[]}, {actions:[{...action('instance2'),action:{}}]}, {actions:[{...action('instance2'),action:null}]}, {actions:[{...action('instance2'),action:'toggle'}]}, {extra:true}
  ])('rejects stale/malformed requests without any state, time or queue mutation: %j', bad => {
    const e=engine(); e.initialize(); input(e,1,1); e.drive(1); const before=e.view();
    expect(e.request({runId:'run',revision:0,sequence:2,atMs:1,actions:[action('instance2')],...bad}).ok).toBe(false); expect(e.view()).toEqual(before);
  });
  it('hostile actions/cycles/getters reject without invoking code, changing state or throwing',()=>{
    const e=engine();e.initialize();const before=e.view();let read=false;const getter={get action(){read=true;return 'press';},instanceId:'instance2',payload:{}};const cyclic:Record<string,unknown>={};cyclic.self=cyclic;
    for(const actions of [[getter],[cyclic],[{...action('instance2'),payload:[]}]])expect(e.request({runId:'run',revision:0,sequence:1,atMs:0,actions}).ok).toBe(false);
    expect(read).toBe(false);expect(e.view()).toEqual(before);
  });
  it('rejects uninitialized future intent rather than falsely claiming initial time advanced', () => { const e=engine(); const before=e.view(); expect(input(e,1,1).ok).toBe(false); expect(e.view()).toEqual(before); });
  it('coalesces same-time frames but counts external transactions not initialization/ticks/reads', () => {
    const e=engine(); input(e,1,0); e.drive(0); input(e,2,0,[action('instance2','release')]); e.drive(0); for(let n=0;n<10;n++){e.drive(0);e.view();} expect(e.view().processedEvents).toBe(2); expect(e.view().history).toHaveLength(1); expect(value(e,'device3','energized')).toEqual(k(true));
  });
  it('does not claim a drive target reached when transaction work remains', () => { const e=engine(); e.initialize(); input(e,1,10); input(e,2,20,[action('instance2','release')]); const first=e.drive(50,1); expect(first).toMatchObject({ok:true,value:{reached:false,processed:1}}); expect(e.view().timeMs).toBe(10); e.drive(50); expect(e.view().timeMs).toBe(50); });
  it('honors exact pending queue boundary and rejection does not consume sequence', () => {
    const e=engine(undefined,{pending:2}); e.initialize(); input(e,1,10); input(e,2,10); const before=e.view(); expect(input(e,3,10)).toMatchObject({ok:false,diagnostics:[{code:'PENDING_LIMIT'}]}); expect(e.view()).toEqual(before); e.drive(10,2); expect(input(e,3,10).ok).toBe(true);
  });
  it('honors event budget without invented events for initial/ticks, no false completion', () => { const e=engine(undefined,{maxEvents:1}); e.initialize(); e.drive(1); input(e,1,10); e.drive(10); input(e,2,20); e.drive(50); expect(e.view()).toMatchObject({status:'resourceLimited',timeMs:20,lastCommittedTimeMs:10,processedEvents:1,complete:false}); expect(e.view().diagnostics[0]!.code).toBe('EVENT_LIMIT'); });
  it('enforces trace count before candidate commit, while same-time replacement fits', () => { const e=engine(undefined,{maxTraceEntries:1}); e.initialize(); input(e,1,0); e.drive(0); expect(e.view().status).toBe('active'); input(e,2,10); e.drive(10); expect(e.view()).toMatchObject({status:'resourceLimited',lastCommittedTimeMs:0}); expect(e.view().history).toHaveLength(1); });
  it('accounts encoded trace bytes exactly before retaining candidate growth', () => {
    const p=topology([supply,lamp],[]), probe=engine(p); probe.initialize(); const size=new TextEncoder().encode(JSON.stringify(probe.view().history[0])).length;
    const exact=engine(p,{traceBytes:size}); exact.initialize(); expect(exact.view().traceBytes).toBe(size); expect(exact.view().status).toBe('active');
    const under=engine(p,{traceBytes:size-1}); under.initialize(); expect(under.view().status).toBe('resourceLimited'); expect(under.view().history).toEqual([]);
  });
  it('retains plain cloneable isolated snapshots and unavailable metadata-only devices', () => {
    const p=structuredClone(selfhold()); const e=engine({...p,devices:[...p.devices,{id:'unused',name:'Unused',kind:'relay',parameters:{},initial:{}}]}); e.initialize(); expect(value(e,'unused','energized')).toEqual({quality:'unknown',code:'UNPLACED_DEVICE'}); const v=e.view(); expect(structuredClone(v)).toEqual(v); expect(()=>{(v.history as unknown[]).push({});}).toThrow(); const clone=structuredClone(v); (clone as {timeMs:number}).timeMs=99; expect(e.view().timeMs).toBe(0);
  });
  it('cancellation clears pending/live actuation, remains incomplete and cannot execute later', () => { const e=engine(); e.initialize(); input(e,1,10); e.clear('cancel'); expect(e.view()).toMatchObject({status:'interrupted',pending:[],complete:false}); expect(e.view().live.every(o=>o.value.quality==='unknown')).toBe(true); expect(e.drive(50).ok).toBe(false); });
  it('detects a proved repeat even at the final allowed transition, unlike a one-transition resource cap', () => {
    const two=engine(feedback(),{maxDeltaCycles:2}); two.initialize(); expect(two.view().diagnostics[0]!.code).toBe('NONCONVERGENT');
    const one=engine(feedback(),{maxDeltaCycles:1}); one.initialize(); expect(one.view().diagnostics[0]!.code).toBe('SETTLING_LIMIT');
  });
  it('bounds wire diagnostics to100 IDs while disclosing the richer unsupported count',()=>{
    const types=[supply,...Array.from({length:102},()=>lamp)], links:[number,number,number,number][]=[[0,0,1,0]];
    for(let n=1;n<102;n++)links.push([n,1,n+1,0]);links.push([102,1,0,1]);
    const e=engine(topology(types,links));e.initialize();const d=e.view().diagnostics[0]!;expect(d.code).toBe('UNSUPPORTED_TOPOLOGY');expect(d.objectIds).toHaveLength(100);expect(d.message).toContain('100 of 102');expect(e.view().electrical).toBeNull();
  });
  it('keeps channels bounded at the actual2000-device/2000-instance schema ceiling',()=>{
    const p=topology([supply,...Array.from({length:1999},()=>lamp)],[]),e=engine(p);e.initialize();expect(e.view().status).toBe('active');expect(e.view().live).toHaveLength(3999);expect(e.view().history[0]!.observations.length).toBeLessThanOrEqual(RUNTIME_LIMITS.observations);
    expect(createEngine(topology([supply,...Array.from({length:2000},()=>lamp)],[]),'run').ok).toBe(false);
  });
  it('rejects invalid/raised runtime caps and untrusted run identity', () => { for(const lower of [{maxDeltaCycles:129},{maxTraceEntries:100001},{traceBytes: RUNTIME_LIMITS.traceBytes+1},{pending:1025},{maxEvents:0}]) expect(runtimeLimits(lower)).toBeUndefined(); expect(createEngine(selfhold(),'bad id').ok).toBe(false); });
});
