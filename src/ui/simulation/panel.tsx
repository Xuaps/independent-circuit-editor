import type { Actuation } from './actuation';
import type { EditorClient, EditorView } from '../editor/application';
export function SimulationControls({ client, view, busy, actuation }: { client: EditorClient; view: EditorView; busy: boolean; actuation: Actuation }) {
  const active = view.mode !== 'Editing';
  return <div className="mode-controls"><span className={`mode-chip ${active ? 'live' : ''}`}>{view.mode === 'Editing' ? 'EDIT' : view.mode.toUpperCase()}</span>
    <nav aria-label="Runtime controls"><button className="primary" hidden={active} disabled={active || busy} onClick={() => void client.run().catch(() => undefined)}>Run</button>
      <button hidden={!active} disabled={view.mode !== 'Running'} onClick={() => client.control({ kind: 'pause' })}>Pause</button>
      <button hidden={view.mode !== 'Paused'} disabled={view.mode !== 'Paused'} onClick={() => client.control({ kind: 'resume' })}>Resume</button>
      <button hidden={view.mode !== 'Paused'} disabled={view.mode !== 'Paused'} onClick={() => client.control({ kind: 'step' })}>Step +1 ms</button>
      <button hidden={!active} disabled={!active} onClick={() => { actuation.release(); client.stop(); }}>Stop simulation</button>
      <details name="command-menu" className="runtime-menu" onClick={event => { if ((event.target as HTMLElement).closest('button')) event.currentTarget.open = false; }}><summary>Runtime</summary><button onClick={() => { actuation.release(); client.stop(true); }}>Reset runtime</button></details></nav>
  </div>;
}
export function SimulationPanel({ client, view, select, actuation }: { client: EditorClient; view: EditorView; select(ids: string[]): void; actuation: Actuation }) {
  const active = view.mode !== 'Editing', runtime = view.runtime;
  return <section className="simulation" aria-label="Simulation" hidden={!active && !runtime}>
    <h2>Simulation — {view.mode}</h2>
    <p data-testid="runtime-clock">Virtual time: {runtime?.timeMs ?? 0} ms</p>
    {client.runtimeError() && <p role="alert">{client.runtimeError()}</p>}

    {active && <div aria-label="Momentary controls">{view.design.sheets.flatMap(s => s.instances).filter(i => i.definition.id.startsWith('core.pushbutton.')).map(i => {
      const name = view.design.devices.find(d => d.id === i.deviceId)?.name ?? i.id;
      return <button key={i.id} data-actuator={i.id} disabled={view.mode === 'Faulted'} {...actuation.bind<HTMLButtonElement>(i.id, 'panel')}>Hold {name} ({i.definition.id.endsWith('.nc') ? 'NC' : 'NO'})</button>;
    })}</div>}
    {runtime && <>
      <details className="runtime-details"><summary>Live values and electrical details</summary>
      <p>Outcome: {runtime.status}; {runtime.complete ? 'core committed outcome' : 'incomplete / last acknowledged history'}. Potential cues: positive (+), return (−), floating (?). NOT current.</p>
      <p data-testid="pending-intents">Pending intent ({runtime.pending.length}): {runtime.pending.flatMap(t => t.actions.map(a => `${a.instanceId}: ${a.action}`)).join('; ') || 'none'}. Pending is not committed.</p>
      <p>Glyph legend: ? unknown/unavailable · U unsupported · ! faulted (hover badge for reason). Dashed blade is unavailable, not confirmed open. Filled coil + bars means powered; lamp rays mean lit. Pending input is not mechanical acknowledgment.</p>
      <h3>Committed observables</h3><ul>{runtime.live.map(o => <li key={`${o.target.kind}:${o.target.id}:${o.observable}`} data-observable={`${o.target.id}/${o.observable}`}><button onClick={() => select([o.target.id])}>{view.design.devices.find(d => d.id === o.target.id)?.name ?? view.design.sheets[0]!.instances.find(i => i.id === o.target.id)?.label ?? o.target.id} {o.target.id} · {o.observable}: {o.value.quality === 'known' ? String(o.value.value) : `${o.value.quality} (${o.value.code})`}</button></li>)}</ul>
      <h3>Electrical inspection</h3><ul>{runtime.electrical?.nets.map(n => <li key={n.id}><button onClick={() => select([...n.wireIds])}>{n.potential} · terminals {n.nodeIds.join(', ')} · wires {n.wireIds.join(', ')}</button></li>)}</ul>

      <details><summary>Historical trace — last {runtime.history.length} frames (tail only; stops retain last acknowledged data)</summary><pre data-testid="runtime-trace">{JSON.stringify(runtime.history)}</pre></details>
      </details>
      {runtime.diagnostics.map((d, n) => <p role="alert" key={n}><button onClick={() => select([...d.objectIds])}>{d.code}: {d.message} — Stop, select implicated objects and repair design.</button></p>)}
    </>}
  </section>;
}
