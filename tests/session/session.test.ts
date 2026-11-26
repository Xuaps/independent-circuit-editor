import { describe, expect, it } from 'vitest';
import { createSession } from '../../src/core/session';
import type { Project } from '../../src/core/domain/types';
import { serializeProject } from '../../src/core/persistence';
import { action, button, selfhold, supply, topology } from '../fixtures/scenarios/build';
function session(p: Project = selfhold()) { const s=createSession(p); if(!s.ok) throw Error(JSON.stringify(s)); return s.value; }
type Session=ReturnType<typeof session>;
const state=(s:Session,id='device2',observable='pressed')=>s.view().runtime!.live.find(o=>o.target.id===id&&o.observable===observable)?.value;
function send(s:Session,sequence:number,actions=[action('instance2')]) { const v=s.view().runtime!; return s.input({runId:v.runId,revision:v.revision,atMs:v.timeMs,sequence,actions}); }
const edit=(s:Session)=>({format:'circuit-operations',formatVersion:1,target:{projectId:s.design().projectId,expectedRevision:s.design().revision},operations:[{op:'device.rename',deviceId:'device3',name:'NewName'}]});
describe('shared host-neutral lifecycle and edit boundary',()=>{
  it('preserves design/history/dirty across run input stop reset; editing remains available only at stop',()=>{
    const s=session(), before=s.view(), saved=serializeProject(s.design()); expect(s.run('run').ok).toBe(true); send(s,1); expect(state(s,'device3','energized')).toEqual({quality:'known',value:true});
    expect(s.design()).toEqual(before.design); expect(serializeProject(s.design())).toEqual(saved); expect(s.view().history).toEqual(before.history); expect(s.view().dirty).toBe(false);
    s.stop(); expect(s.view().mode).toBe('Editing'); expect(s.view().runtime!.status).toBe('stopped'); expect(s.view().runtime!.history.length).toBeGreaterThan(0); expect(s.view().runtime!.live.every(o=>o.value.quality==='unknown')).toBe(true);
    expect(s.apply(edit(s)).ok).toBe(true); expect(s.view().dirty).toBe(true); s.reset(); expect(s.view().runtime).toBeNull(); expect(s.view().dirty).toBe(true); expect(s.undo().ok).toBe(true);
  });
  it.each(['Running','Paused','Faulted'] as const)('locks apply/dryRun/undo/redo in %s, saving unchanged design allowed',mode=>{
    const s=session(mode==='Faulted'?topology([supply],[[0,0,0,1]]):selfhold()); s.apply(edit(s)); s.undo(); s.run('run'); if(mode==='Paused')s.pause(); expect(s.view().mode).toBe(mode); const before=s.view();
    for(const result of [s.apply(edit(s)),s.dryRun(edit(s)),s.undo(),s.redo()]) expect(result).toMatchObject({ok:false,diagnostics:[{code:'EDIT_LOCKED'}]});
    expect(s.view()).toEqual(before); s.markSaved(); expect(s.view().dirty).toBe(false); expect('editor' in s).toBe(false);
  });
  it('queues visibly pending paused intent without applying it, Step consumes then advances exactly +1',()=>{
    const s=session(); s.run('run'); s.pause(); expect(send(s,1).ok).toBe(true); expect(s.view().runtime!.pending).toHaveLength(1); expect(state(s)).toEqual({quality:'known',value:false});
    expect(s.step().ok).toBe(true); expect(s.view().mode).toBe('Paused'); expect(s.view().runtime!.timeMs).toBe(1); expect(s.view().runtime!.pending).toEqual([]); expect(state(s)).toEqual({quality:'known',value:true});
  });
  it('pause creates no clock debt; resume consumes intent at the frozen timestamp',()=>{
    const s=session(); s.run('run'); s.drive(100); s.pause(); for(let i=0;i<100;i++)s.view(); expect(s.view().runtime!.timeMs).toBe(100); expect(s.drive(500).ok).toBe(false); send(s,1); s.resume(); expect(s.view().runtime!.timeMs).toBe(100); expect(state(s)).toEqual({quality:'known',value:true}); s.drive(101); expect(s.view().runtime!.timeMs).toBe(101);
  });
  it('Step validates overflow before consuming pending input or changing clock',()=>{
    const s=session(); s.run('run'); s.drive(86400000); s.pause(); send(s,1); const before=s.view(); expect(s.step()).toMatchObject({ok:false,diagnostics:[{code:'TIME_RANGE'}]}); expect(s.view()).toEqual(before);
  });
  it('Running focus/cancel releases momentaries atomically then pauses (not an emergency-stop guarantee)',()=>{
    const s=session(); s.run('run'); send(s,1); expect(s.releaseAndPause(2).ok).toBe(true); expect(s.view().mode).toBe('Paused'); expect(state(s)).toEqual({quality:'known',value:false}); expect(state(s,'device3','energized')).toEqual({quality:'known',value:true}); expect(s.view().runtime!.pending).toEqual([]);
  });
  it('Paused focus/cancel includes pending presses and queues ordered release without early application',()=>{
    const s=session(); s.run('run'); s.pause(); send(s,1); expect(s.releaseAndPause(2).ok).toBe(true); expect(s.view().runtime!.pending).toHaveLength(2); expect(state(s)).toEqual({quality:'known',value:false}); s.step(); expect(state(s)).toEqual({quality:'known',value:false}); expect(state(s,'device3','energized')).toEqual({quality:'known',value:true}); expect(s.view().runtime!.processedEvents).toBe(2);
  });
  it('trusted release-all handles >128 momentaries but does not permit oversized untrusted batches',()=>{
    const p=topology([supply,...Array.from({length:129},()=>button)],[]); const s=session(p); expect(s.run('run').ok).toBe(true); s.pause();
    const actions=Array.from({length:129},(_,i)=>action(`instance${i+1}`)); expect(send(s,1,actions).ok).toBe(false); expect(send(s,1,actions.slice(0,128)).ok).toBe(true); expect(send(s,2,actions.slice(128)).ok).toBe(true); expect(s.releaseAndPause(3).ok).toBe(true); expect(s.view().runtime!.pending.at(-1)!.actions).toHaveLength(129); s.step(); expect(s.view().runtime!.live.filter(o=>o.observable==='pressed').every(o=>o.value.quality==='known'&&o.value.value===false)).toBe(true);
  });
  it('release-all queue overflow is explicit and does not silently drop prior input or pause',()=>{
    const s=session(); s.run('run',{pending:1}); s.pause(); send(s,1); const before=s.view(); expect(s.releaseAndPause(2)).toMatchObject({ok:false,diagnostics:[{code:'PENDING_LIMIT'}]}); expect(s.view()).toEqual(before);
  });
  it('stop/reset/new generation cannot retain a pressed input or stale run request',()=>{
    const s=session(); s.run('host'); send(s,1); const old=s.view().runtime!, oldMessage={runId:old.runId,revision:0,sequence:2,atMs:0,actions:[action('instance2')]}; s.stop(); s.run('host'); expect(s.view().runtime!.runId).not.toBe(old.runId); const before=s.view(); expect(s.input(oldMessage).ok).toBe(false); expect(s.view()).toEqual(before); expect(state(s)).toEqual({quality:'known',value:false}); expect(state(s,'device3','energized')).toEqual({quality:'known',value:false}); s.reset(); s.run('host'); expect(s.view().runtime!.processedEvents).toBe(0);
  });
  it('fault/resource/cancel remain non-driving and require stop/reset to edit',()=>{
    const s=session(topology([supply,'core.relay.coil'],[[0,0,1,0],[1,1,0,1]])); s.run('run',{maxDeltaCycles:1}); expect(s.view().mode).toBe('Faulted'); expect(s.view().runtime!.status).toBe('resourceLimited'); expect(s.view().runtime!.live.every(o=>o.value.quality==='unknown')).toBe(true); expect(s.apply(edit(s)).ok).toBe(false); s.reset(); expect(s.view().mode).toBe('Editing');
  });
  it('initial zero-time transactions precede rest solve and malformed initial input is atomic',()=>{
    const s=session(topology([supply,'core.pushbutton.nc'],[[0,0,1,0],[1,1,0,1]])); const before=s.view(); expect(s.run('run',{},[{atMs:1,sequence:1,actions:[action('instance1')]}]).ok).toBe(false); expect(s.view()).toEqual(before);
    for(const initial of [null,[null],[{atMs:0,sequence:1,actions:[action('instance1')],extra:true}],[{atMs:0,sequence:1,actions:[{...action('instance1'),action:{}}]}]]){expect(s.run('run',{},initial).ok).toBe(false);expect(s.view()).toEqual(before);}
    expect(s.run('run',{},[{atMs:0,sequence:1,actions:[action('instance1')]}]).ok).toBe(true); expect(s.view().mode).toBe('Running');
  });
  it('online intent is current-clock only; future/past requests cannot mutate paused or running state',()=>{
    const s=session();s.run('run');s.drive(10);
    for(const paused of [false,true]){if(paused)s.pause();for(const atMs of [9,11]){const before=s.view(),v=before.runtime!;expect(s.input({runId:v.runId,revision:0,sequence:1,atMs,actions:[action('instance2')]}).ok).toBe(false);expect(s.view()).toEqual(before);}}
  });
  it('cooperative cancellation preserves historical trace and no next command drives it',()=>{const s=session();s.run('run');send(s,1);s.pause();send(s,2,[action('instance2','release')]);s.cancel();expect(s.view().mode).toBe('Faulted');expect(s.view().runtime).toMatchObject({status:'interrupted',pending:[],complete:false});expect(s.resume().ok).toBe(false);expect(s.apply(edit(s)).ok).toBe(false);s.stop();expect(s.apply(edit(s)).ok).toBe(true);});
});
