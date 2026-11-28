import { circuitViewport } from './editor/viewport';
import { useActuation } from './simulation/actuation';
import { projectGlyph } from './simulation/presentation';
import { SimulationPanel, SimulationControls } from './simulation/panel';
import { terminalKey } from '../core/compiler';
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { definitions, getDefinition } from '../core/catalog';
import { endpointPosition } from '../core/domain/geometry';
import type { Endpoint, Instance, Operation, Point, Transform } from '../core/domain/types';
import { createLocalClient, type EditorClient, type Intent } from './editor/application';
import { Glyph } from './editor/glyph';
import { FilePanel } from './files/panel';
import { DesignScene, presentationText } from './export/design';
import './styles/editor.css';

const titles: Record<string, string> = { 'core.dc.supply': 'DC source', 'core.pushbutton.no': 'NO pushbutton', 'core.pushbutton.nc': 'NC pushbutton (Stop)', 'core.relay.coil': 'Relay coil', 'core.relay.contact.no': 'Relay NO contact', 'core.relay.contact.nc': 'Relay NC contact', 'core.lamp': 'Lamp' };
const snap = (n: number) => Math.max(-999900, Math.min(999900, Math.round(n / 10) * 10));
type QuarterTurn = -90 | 90;
const rotateQuarterTurn = (rotation: Transform['rotation'], delta: QuarterTurn) => ((rotation + delta + 360) % 360) as Transform['rotation'];
const keyOf = (e: Endpoint) => e.kind === 'port' ? `${e.instanceId}/${e.portId}` : e.kind === 'junction' ? e.junctionId : `dangling:${e.position.x},${e.position.y}`;
function number(data: FormData, key: string) { return Number(data.get(key)); }
function form(event: FormEvent<HTMLFormElement>) { event.preventDefault(); return new FormData(event.currentTarget); }

export function App({ client: supplied }: { client?: EditorClient }) {
  const [client] = useState(() => supplied ?? createLocalClient());
  const [fileBusy, setFileBusy] = useState(false);
  const view = useSyncExternalStore(client.subscribe, client.getSnapshot), project = view.design, sheet = project.sheets[0]!;
  const actuation = useActuation(client, view);
  const [selection, setSelection] = useState<string[]>([]), [tool, setTool] = useState('select'), [search, setSearch] = useState('');
  const [position, setPosition] = useState<Point>({ x: 100, y: 100 }), [wireStart, setWireStart] = useState<Endpoint | null>(null);
  const [notice, setNotice] = useState('Blank project. Choose a palette item, then place on canvas or use Place at coordinates.'), [issues, setIssues] = useState<readonly import('../core/domain/types').Diagnostic[]>([]);
  const [inspect, setInspect] = useState(false), [annotation, setAnnotation] = useState('Note');
  const [placementRotation, setPlacementRotation] = useState<Transform['rotation']>(0), [placementMirror, setPlacementMirror] = useState(false);
  const [viewport, setViewport] = useState({ x: 0, y: 0, width: 1000, height: 800 });
  const [dragPreview, setDragPreview] = useState<Point | null>(null);
  const drag = useRef<{ id: string; pointerId: number; start: Point; original: Point } | null>(null), svg = useRef<SVGSVGElement>(null);
  useEffect(() => { if (view.mode !== 'Editing') { drag.current = null; setDragPreview(null); setTool('select'); setWireStart(null); } }, [view.mode]);
  const current = sheet.instances.find(i => i.id === selection[0]), selectedWire = sheet.wires.find(w => w.id === selection[0]), junction = sheet.junctions.find(j => j.id === selection[0]);
  const selectedAnnotation = sheet.annotations.find(a => a.id === selection[0]);
  const preflight = client.preflight();
  const faultedWithoutRuntime = view.mode === 'Faulted' && !view.runtime;
  const missingDcSource = faultedWithoutRuntime && preflight.some(d => d.code === 'SOURCE_COUNT')
    && !sheet.instances.some(i => i.definition.id === 'core.dc.supply');
  const unboundIds = faultedWithoutRuntime
    ? new Set(preflight.filter(d => d.code === 'UNBOUND_INSTANCE').flatMap(d => d.objectIds)) : null;
  const unassignedRelayContacts = unboundIds?.size ? sheet.instances.filter(i =>
    unboundIds.has(i.id) && i.deviceId === null && (i.definition.id === 'core.relay.contact.no' || i.definition.id === 'core.relay.contact.nc'),
  ).map(i => ({
    id: i.id,
    label: `${titles[i.definition.id]}${i.label ? ` · ${i.label}` : ''} (${i.transform.position.x}, ${i.transform.position.y})`,
  })) : [];
  const endpoints: { value: string; label: string; endpoint: Endpoint }[] = [
    ...sheet.instances.flatMap(i => getDefinition(i.definition.id)!.ports.map(p => ({ value: `${i.id}/${p.id}`, label: `${project.devices.find(d => d.id === i.deviceId)?.name ?? 'Unassigned'} ${titles[i.definition.id]} ${p.defaultMarking} (${p.id}) [${i.id.slice(-6)}]`, endpoint: { kind: 'port' as const, instanceId: i.id, portId: p.id } }))),
    ...sheet.junctions.map((j, n) => ({ value: j.id, label: `Junction ${n + 1} (${j.position.x},${j.position.y})`, endpoint: { kind: 'junction' as const, junctionId: j.id } }))
  ];
  async function send(intent: Intent) {
    const result = await client.dispatch(intent); setIssues(result.diagnostics);
    if (result.ok) { if (result.selection) setSelection([...result.selection]); setNotice('Edit applied as one undo transaction.'); }
    else setNotice('Edit rejected; design and history preserved. See diagnostics.');
    return result.ok;
  }
  function cancel() { const pointer = drag.current?.pointerId; drag.current = null; if (pointer !== undefined && svg.current?.hasPointerCapture(pointer)) svg.current.releasePointerCapture(pointer); setTool('select'); setWireStart(null); setPlacementRotation(0); setPlacementMirror(false); drag.current = null; setDragPreview(null); setNotice('Gesture cancelled. No design change.'); }
  function select(id: string, multi = false) { setTool('select'); setWireStart(null); setSelection(old => multi ? old.includes(id) ? old.filter(x => x !== id) : [...old, id] : [id]); }
  function world(event: { clientX: number; clientY: number }): Point {
    const matrix = svg.current?.getScreenCTM(); if (!matrix) return position;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()); return { x: snap(p.x), y: snap(p.y) };
  }
  async function place(point: Point) {
    let intent: Intent;
    if (getDefinition(tool)) intent = { kind: 'place', definition: tool, position: point, rotation: placementRotation, mirrorX: placementMirror };
    else if (tool === 'junction') intent = { kind: 'junction', position: point };
    else if (tool === 'text') intent = { kind: 'annotation', position: point, text: annotation };
    else if (tool === 'wire' && wireStart) intent = { kind: 'wire', from: wireStart, to: { kind: 'dangling', position: point } };
    else return;
    if (await send(intent)) { setWireStart(null); }
  }
  function terminal(endpoint: Endpoint) {
    if (view.mode !== 'Editing') return;
    if (!wireStart) { setWireStart(endpoint); setTool('wire'); setNotice('Wire start selected. Choose another explicit terminal/junction or a dangling point.'); }
    else { void send({ kind: 'wire', from: wireStart, to: endpoint }).then(ok => { if (ok) { setWireStart(null); setTool('wire'); } }); }
  }
  function transformSelection({ rotationDelta, mirror = false, positionDelta }: { rotationDelta?: QuarterTurn; mirror?: boolean; positionDelta?: Point }) {
    if (!selection.length || selection.some(id => !sheet.instances.some(i => i.id === id))) { setNotice('Normal transforms support symbol-only selections. Use explicit Replace junction for junction relocation; annotations cannot move.'); return; }
    const transforms: Record<string, Transform> = Object.create(null) as Record<string, Transform>;
    for (const i of sheet.instances.filter(i => selection.includes(i.id))) transforms[i.id] = {
      position: positionDelta ? { x: i.transform.position.x + positionDelta.x, y: i.transform.position.y + positionDelta.y } : i.transform.position,
      rotation: rotationDelta === undefined ? i.transform.rotation : rotateQuarterTurn(i.transform.rotation, rotationDelta),
      mirrorX: mirror ? !i.transform.mirrorX : i.transform.mirrorX,
    };
    void send({ kind: 'transform', transforms });
  }
  function mirrorX() {
    if (getDefinition(tool)) setPlacementMirror(m => !m);
    else transformSelection({ mirror: true });
  }
  function remove() {
    if (!selection.length) return;
    if (window.confirm('Remove selected objects? Incident wire ends will become explicitly dangling. Devices are removed only when selected in the device list.')) void send({ kind: 'delete', ids: selection, policy: 'detach' });
  }
  function pointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (view.mode !== 'Editing' || event.button !== 0) return;
    const point = world(event); setPosition(point);
    if (tool !== 'select') { void place(point); return; }
    setSelection([]);
  }
  function startDrag(event: ReactPointerEvent<SVGGElement>, instance: Instance) {
    if (view.mode !== 'Editing' || tool !== 'select') return;
    event.preventDefault(); event.stopPropagation(); select(instance.id, event.shiftKey);
    if (event.button === 0) svg.current?.focus({ preventScroll: true });
    if (event.shiftKey) return;
    drag.current = { id: instance.id, pointerId: event.pointerId, start: world(event), original: instance.transform.position };
    svg.current?.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const point = world(event); setPosition(point);
    if (drag.current) setDragPreview({ x: drag.current.original.x + point.x - drag.current.start.x, y: drag.current.original.y + point.y - drag.current.start.y });
  }
  function pointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    const d = drag.current; drag.current = null; setDragPreview(null);
    if (d) {
      const point = world(event), i = sheet.instances.find(i => i.id === d.id)!;
      const next = { x: d.original.x + point.x - d.start.x, y: d.original.y + point.y - d.start.y };
      if (next.x !== d.original.x || next.y !== d.original.y) void send({ kind: 'transform', transforms: { [i.id]: { ...i.transform, position: next } } });
    }
  }
  function endpointSelect(value: string) { return endpoints.find(e => e.value === value)?.endpoint; }
  const connected = (id: string, port: string) => sheet.wires.filter(w => [w.from, w.to].some(e => e.kind === 'port' && e.instanceId === id && e.portId === port)).length;

  const projected = drag.current && dragPreview ? { ...project, sheets: project.sheets.map(s => ({ ...s, instances: s.instances.map(i => i.id === drag.current?.id ? { ...i, transform: { ...i.transform, position: dragPreview } } : i) })) } : project;
  return <main className="app-shell" onKeyDown={event => {
    if (fileBusy || view.mode !== 'Editing') return;
    const target = event.target as HTMLElement;
    if (target.closest('input,textarea,select,[contenteditable="true"]')) return;
    if (event.key === 'Escape') { event.preventDefault(); cancel(); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); void send({ kind: event.shiftKey ? 'redo' : 'undo' }); }
    else if (target.closest('[data-canvas]')) {
      if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        if (getDefinition(tool)) setPlacementRotation(r => rotateQuarterTurn(r, 90));
        else transformSelection({ rotationDelta: 90 });
      }
      else if (event.key === 'Delete') { event.preventDefault(); remove(); }
      else if (event.key.toLowerCase() === 'v') cancel();
      else if (event.key.toLowerCase() === 'w') { setTool('wire'); setNotice('Choose a terminal using the terminal list or canvas.'); }
      else if (event.key === 'Enter' && tool !== 'select') { event.preventDefault(); void place(position); }
      else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); setPosition(p => ({ x: snap(p.x + (event.key === 'ArrowRight' ? 10 : event.key === 'ArrowLeft' ? -10 : 0)), y: snap(p.y + (event.key === 'ArrowDown' ? 10 : event.key === 'ArrowUp' ? -10 : 0)) })); }
    }
  }}>
    <header className="project-bar">
      <div className="project-identity"><h1>Independent Circuit Editor</h1><strong>{project.title}</strong><p data-testid="design-status">{view.dirty ? 'Unsaved changes' : 'Content baseline unchanged'} · revision {project.revision}</p></div>
      <nav className="section-links" aria-label="Editor sections"><a href="#build">Build</a><a href="#drawing">Drawing</a><a href="#inspector">Inspector</a></nav>
      <FilePanel client={client} lock={setFileBusy} replaced={() => { cancel(); setSelection([]); setIssues([]); setViewport(circuitViewport(client.getSnapshot().design)); }}/>
      <SimulationControls client={client} view={view} busy={fileBusy} actuation={actuation}/>
    </header>
    <div className="workspace authoring" inert={fileBusy}>
      <aside id="build" className="palette-panel" aria-label="Palette and objects" tabIndex={-1}><fieldset disabled={view.mode !== 'Editing'}><h2>Build</h2><p className="muted">Click a part → place repeatedly</p>
        <details className="palette-search"><summary>Find a part</summary><label>Search definitions<input value={search} onChange={e => setSearch(e.target.value)}/></label></details>
        <div className="palette">{definitions.filter(d => `${titles[d.id]} ${d.id}`.toLowerCase().includes(search.toLowerCase())).map(d => <button key={d.id} aria-pressed={tool === d.id} onClick={() => { setTool(d.id); setWireStart(null); setPlacementRotation(0); setPlacementMirror(false); setNotice(`Place ${titles[d.id]}. Pointer or coordinates; Escape cancels.`); }}><svg viewBox="-36 -36 72 72" aria-hidden="true"><Glyph instance={{ definition: { id: d.id, version: 1 } }}/></svg><span>{titles[d.id]}</span></button>)}</div>
        <button aria-pressed={tool === 'junction'} onClick={() => setTool('junction')}>Junction tool</button><button aria-pressed={tool === 'text'} onClick={() => setTool('text')}>Text tool</button>
        {tool === 'text' && <label>Annotation text<input value={annotation} onChange={e => setAnnotation(e.target.value)} /></label>}
        <section className="object-browser"><h2>Objects ({sheet.instances.length} symbols)</h2><p>Checkboxes add to selection. Symbol and device removal are separate.</p>
        <ul className="objects">{[...sheet.instances, ...sheet.junctions, ...sheet.wires, ...sheet.annotations].map((object, n) => {
          const i = sheet.instances.find(i => i.id === object.id), label = i ? `${project.devices.find(d => d.id === i.deviceId)?.name ?? 'Unassigned'} · ${titles[i.definition.id]}` : sheet.junctions.includes(object as never) ? `Junction ${sheet.junctions.findIndex(j => j.id === object.id) + 1}` : sheet.wires.includes(object as never) ? `Wire ${sheet.wires.findIndex(w => w.id === object.id) + 1}` : `Text ${n + 1}`;
          return <li key={object.id}><input type="checkbox" aria-label={`Select ${label}`} checked={selection.includes(object.id)} onChange={() => select(object.id, true)} /><button aria-pressed={selection.includes(object.id)} onClick={() => select(object.id)}>{label}</button></li>;
        })}</ul>
        <details><summary>Shared devices</summary><h2>Devices</h2><ul className="objects">{project.devices.map(d => <li key={d.id}><button onClick={() => setSelection(sheet.instances.filter(i => i.deviceId === d.id).map(i => i.id))}>Linked symbols for {d.name}</button><button onClick={() => setSelection([d.id])}>Device {d.name}</button></li>)}</ul></details></section>

      </fieldset></aside>
      <section id="drawing" className="drawing" aria-label="Drawing workspace" tabIndex={-1}>
        <nav className="canvas-tools" aria-label="Drawing tools">
          <button aria-pressed={tool === 'select'} onClick={cancel}>Select / Cancel (Escape)</button>
          <button aria-pressed={tool === 'wire'} disabled={view.mode !== 'Editing'} onClick={() => { setTool('wire'); setWireStart(null); setNotice('Wire tool: choose two explicit terminals. Escape cancels.'); }}>Wire (W)</button>
          {view.mode === 'Editing' && getDefinition(tool) && <>
            <button disabled={fileBusy} onClick={() => setPlacementRotation(r => rotateQuarterTurn(r, -90))}>Rotate preview left</button>
            <button disabled={fileBusy} onClick={() => setPlacementRotation(r => rotateQuarterTurn(r, 90))}>Rotate preview right</button>
          </>}
          <span className="tool-divider"/>
          <button onClick={() => setViewport(v => ({ ...v, width: Math.max(100, v.width / 1.25), height: Math.max(80, v.height / 1.25) }))}>Zoom in</button>
          <button onClick={() => setViewport(v => ({ ...v, width: Math.min(2000000, v.width * 1.25), height: Math.min(1600000, v.height * 1.25) }))}>Zoom out</button>
          <button onClick={() => setViewport(circuitViewport(project))}>Fit circuit</button>
          <span className="tool-hint">{view.mode === 'Editing' ? 'Explicit terminals only' : 'Hold drawn Start / Stop'}</span>
        </nav>
        <svg ref={svg} data-canvas="true" role="img" aria-label="Circuit drawing canvas" tabIndex={0} viewBox={`${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`} onDragStart={event => event.preventDefault()} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={cancel} onLostPointerCapture={() => { if (drag.current) cancel(); }}>
          <defs><pattern id="grid" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r=".7" fill="#b8c3cb" /></pattern></defs>
          <rect x={viewport.x} y={viewport.y} width={viewport.width} height={viewport.height} fill="url(#grid)"/>
          <rect className="page-outline" width={sheet.page.width} height={sheet.page.height} fill="none" stroke="#7c8790" strokeDasharray="6 5" pointerEvents="none"/>
          <DesignScene project={projected} interaction={{
            wire: (w, drawing) => <g data-wire={w.id} data-potential={view.runtime?.electrical?.nets.find(n => n.wireIds.includes(w.id))?.potential} className={selection.includes(w.id) ? 'selected' : ''} onPointerDown={e => { e.stopPropagation(); select(w.id, e.shiftKey); }}>{drawing}</g>,
            symbol: (i, drawing) => {
              const b = getDefinition(i.definition.id)!.designer.bounds;
              const operational = (view.mode === 'Running' || view.mode === 'Paused') && getDefinition(i.definition.id)!.actions.includes('press');
              const state = view.mode !== 'Editing' ? projectGlyph(i, view.runtime) : undefined;
              return <g data-state={view.runtime?.live.filter(o => o.target.kind === 'instance' && o.target.id === i.id).map(o => `${o.observable}:${o.value.quality === 'known' ? o.value.value : o.value.quality}`).join(' ')} data-instance={i.id} role={operational ? 'button' : undefined} aria-label={operational ? `Operate ${project.devices.find(d => d.id === i.deviceId)?.name ?? i.id}` : undefined} tabIndex={operational ? 0 : undefined} className={selection.includes(i.id) ? 'selected' : ''} {...(operational ? actuation.bind<SVGGElement>(i.id, 'canvas') : { onPointerDown: (e: ReactPointerEvent<SVGGElement>) => { if (view.mode !== 'Editing') { e.stopPropagation(); select(i.id); } else startDrag(e, i); } })}><rect x={b.min.x} y={b.min.y} width={b.max.x - b.min.x} height={b.max.y - b.min.y} fill="transparent" stroke={selection.includes(i.id) ? 'currentColor' : 'none'} strokeDasharray="4 2"/>{state ? <Glyph instance={i} state={state}/> : drawing}</g>;
            },
            port: (i, port, drawing) => <g data-potential={view.runtime?.electrical?.nets.find(n => n.nodeIds.includes(terminalKey(i.id, port)))?.potential} onPointerDown={e => { e.stopPropagation(); terminal({ kind: 'port', instanceId: i.id, portId: port }); }}>{drawing}<title>{`${presentationText(project.devices.find(d => d.id === i.deviceId)?.name ?? 'Unassigned')} ${port}: ${connected(i.id, port)} wires`}</title></g>,
            junction: (j, drawing) => <g className={selection.includes(j.id) ? 'selected' : ''} onPointerDown={e => { e.stopPropagation(); if (tool === 'wire') terminal({ kind: 'junction', junctionId: j.id }); else select(j.id, e.shiftKey); }}>{drawing}<title>{`Explicit junction ${j.id}`}</title></g>,
            annotation: (a, drawing) => <g onPointerDown={e => { e.stopPropagation(); select(a.id); }}>{drawing}</g>
          }}/>
          {tool !== 'select' && <g pointerEvents="none" opacity=".65">{getDefinition(tool) && <g transform={`translate(${position.x} ${position.y}) rotate(${placementRotation}) scale(${placementMirror ? -1 : 1} 1)`}><Glyph instance={{ definition: { id: tool, version: 1 } }}/></g>}<circle cx={position.x} cy={position.y} r="12" fill="none" stroke="#005ca5"/><path d={`M ${position.x - 18} ${position.y} H ${position.x + 18} M ${position.x} ${position.y - 18} V ${position.y + 18}`} stroke="#005ca5"/>{wireStart && (() => { const a = endpointPosition(sheet, wireStart); return a && <polyline points={`${a.x},${a.y} ${position.x},${a.y} ${position.x},${position.y}`} fill="none" stroke="#005ca5" strokeDasharray="5 3"/>; })()}</g>}
        </svg>

        {!sheet.instances.length && !sheet.annotations.length && !sheet.wires.length && !sheet.junctions.length && <div className="blank-canvas"><strong>Your circuit starts here</strong><p><span>Choose a part in Build.</span><br/>Place repeatedly; Escape returns to Select.</p><span>Own-format · ideal 24 V DC</span></div>}
        <div className="drawing-status"><p role="status">{notice}</p><span>Tool: {titles[tool] ?? tool}{getDefinition(tool) && ` · ${placementRotation}°${placementMirror ? ' mirrored' : ''}`} · Selected {selection.length}</span></div>
      </section>
      <aside id="inspector" className="inspector-panel" aria-label="Inspector and wiring" tabIndex={-1}>
        <SimulationPanel client={client} view={view} select={setSelection} actuation={actuation} missingDcSource={missingDcSource} unassignedRelayContacts={unassignedRelayContacts}/>
        <fieldset disabled={view.mode !== 'Editing'} className="selection-inspector"><h2>Selection inspector</h2>
        {!selection.length && <div className="selection-hint"><h3>Select a symbol</h3><p>Choose a symbol on the drawing or in Objects to edit its label, binding and presentation.</p><p className="muted">Wire from terminal to terminal. Crossings never join automatically.</p></div>}
        {selection.length > 1 && <p>Multiple selection: transforms support symbols only. Copy supports symbols, wires and junctions. Annotations cannot move/copy.</p>}
        {current && <InstanceInspector key={`${current.id}:${project.revision}`} instance={current} project={project} send={send} select={setSelection}/>}
        {junction && <form onSubmit={e => { const d = form(e); void send({ kind: 'relocate', id: junction.id, position: { x: number(d, 'x'), y: number(d, 'y') } }); }}><p>Junction ID: <code>{junction.id}</code>. Explicit relocation replaces its ID and remaps all incident wire ends. Undo restores the original.</p><label>Junction X<input name="x" type="number" defaultValue={junction.position.x}/></label><label>Junction Y<input name="y" type="number" defaultValue={junction.position.y}/></label><button>Replace junction at position</button></form>}
        {selectedAnnotation && <p>Text: {selectedAnnotation.text}. Annotation movement/update is unavailable; delete and add explicitly if needed.</p>}
        {project.devices.filter(d => selection.includes(d.id)).map(d => <p key={d.id}>Selected shared device {d.name} ({d.id}); deleting it unbinds all symbols rather than removing them.</p>)}
        <details className="wiring-details" open={!!selectedWire}><summary>Explicit wiring</summary><h2>Explicit wiring</h2><p>Terminals stay accessible when markings are hidden. Connected counts refer to stored wire ends.</p>
        <form onSubmit={e => { const d = form(e), from = endpointSelect(String(d.get('from'))), to = endpointSelect(String(d.get('to'))); if (from && to) void send({ kind: 'wire', from, to }); }}>
          <label>Wire from<select name="from">{endpoints.map(e => <option key={e.value} value={e.value}>{e.label}</option>)}</select></label><label>Wire to<select name="to">{endpoints.map(e => <option key={e.value} value={e.value}>{e.label}</option>)}</select></label><button disabled={!endpoints.length}>Connect endpoints</button>
        </form>
        <details><summary>Terminal / junction actions</summary>{endpoints.map(e => <button key={e.value} className="terminal" aria-pressed={!!wireStart && keyOf(wireStart) === e.value} onClick={() => terminal(e.endpoint)}>{e.label}{e.endpoint.kind === 'port' ? ` · ${connected(e.endpoint.instanceId, e.endpoint.portId)} wires` : ' · explicit node'}</button>)}<button disabled={!wireStart} onClick={() => void place(position)}>Finish dangling at cursor</button></details>
        {selectedWire && <section><h3>Wire {sheet.wires.findIndex(w => w.id === selectedWire.id) + 1}</h3><code>{selectedWire.id}</code><p>From {keyOf(selectedWire.from)} → {keyOf(selectedWire.to)}</p>
          <form onSubmit={e => { const d = form(e), from = endpointSelect(String(d.get('branch'))); void send({ kind: 'split', wireId: selectedWire.id, point: { x: number(d, 'x'), y: number(d, 'y') }, ...(from ? { from } : {}) }); }}><label>Split X<input name="x" type="number" defaultValue={position.x}/></label><label>Split Y<input name="y" type="number" defaultValue={position.y}/></label><label>Optional branch from terminal<select name="branch"><option value="">Split only</option>{endpoints.map(e => <option key={e.value} value={e.value}>{e.label}</option>)}</select></label><button>Split / join explicitly</button></form>
          <form onSubmit={e => { const d = form(e), endpoint = endpointSelect(String(d.get('endpoint'))); if (endpoint) void send({ kind: 'join', wireId: selectedWire.id, side: d.get('side') as 'from' | 'to', endpoint }); }}><label>Wire end<select name="side"><option>from</option><option>to</option></select></label><label>Join endpoint<select name="endpoint">{endpoints.map(e => <option key={e.value} value={e.value}>{e.label}</option>)}</select></label><button>Join selected wire end</button></form>
          <button onClick={() => void send({ kind: 'detach', wireId: selectedWire.id, side: 'from' })}>Detach from end</button><button onClick={() => void send({ kind: 'detach', wireId: selectedWire.id, side: 'to' })}>Detach to end</button>
        </section>}
        </details><details><summary>Page dimensions</summary><form onSubmit={e => { const d = form(e); void send({ kind: 'apply', operations: [{ op: 'page.replace', sheetId: sheet.id, page: { width: number(d, 'width'), height: number(d, 'height'), unit: 'du' } }] }); }}><label>Page width<input name="width" type="number" defaultValue={sheet.page.width}/></label><label>Page height<input name="height" type="number" defaultValue={sheet.page.height}/></label><button>Apply page</button></form></details>

        {selection.length > 0 && <fieldset className="selection-actions" disabled={view.mode !== 'Editing'}>
          <button onClick={() => transformSelection({ rotationDelta: -90 })}>Rotate left 90°</button>
          <button onClick={() => transformSelection({ rotationDelta: 90 })}>Rotate right 90°</button>
          <button onClick={mirrorX}>Mirror X</button><button disabled={!selection.length} onClick={() => void send({ kind: 'copy', ids: selection })}>Duplicate independent</button><button disabled={!selection.length} onClick={remove}>Delete selection</button>
        </fieldset>}
        </fieldset>
        <details className="advanced-workspace"><summary>Advanced workspace</summary>
          <h3>Exact placement</h3>
        <fieldset className="coordinates" disabled={view.mode !== 'Editing'}><label>Cursor X<input type="number" step="10" value={position.x} onChange={e => setPosition(p => ({ ...p, x: Number(e.target.value) }))} /></label><label>Cursor Y<input type="number" step="10" value={position.y} onChange={e => setPosition(p => ({ ...p, y: Number(e.target.value) }))} /></label><button disabled={tool === 'select' || tool === 'wire' && !wireStart} onClick={() => void place(position)}>Place at coordinates</button></fieldset>

          <div className="pan-controls" aria-label="Pan controls">{(['left', 'right', 'up', 'down'] as const).map(dir => <button key={dir} onClick={() => setViewport(v => ({ ...v, x: v.x + (dir === 'left' ? -100 : dir === 'right' ? 100 : 0), y: v.y + (dir === 'up' ? -100 : dir === 'down' ? 100 : 0) }))}>Pan {dir}</button>)}</div>
          <button onClick={() => setViewport({ x: -40, y: -40, width: sheet.page.width + 80, height: sheet.page.height + 80 })}>Fit page</button>
          <fieldset disabled={view.mode !== 'Editing'}><button onClick={() => transformSelection({ positionDelta: { x: 10, y: 0 } })}>Move right 10</button></fieldset>
          <details><summary>History and project data</summary><p>History trimmed: {view.history.trimmed}</p><button onClick={() => setInspect(!inspect)}>Inspect project JSON</button>{inspect && <pre data-testid="project-json">{client.inspect()}</pre>}</details>
          <details><summary>Keyboard and scope</summary><p>Canvas V/W, arrows/Enter and Escape; Ctrl/Cmd+Z / Shift+Z. Canvas R rotates the placement preview clockwise while placing a part; otherwise it rotates selected symbols clockwise. Run: hold drawn pushbuttons with pointer, Space or Enter. Ports never actuate. Only applied forms are saved. Editing strokes are not potentials; Run uses the dedicated worker. Independent IEC-style glyphs, not standards certification.</p></details>
        </details>
        <details className="diagnostics" open={issues.length > 0}><summary>Diagnostics / preflight ({issues.length + preflight.length})</summary>{issues.map((d, n) => <p role="alert" key={n}><button onClick={() => setSelection([...d.objectIds])}>{d.code}: {d.message} {d.objectIds.join(', ')}</button></p>)}<p>No electrical solve in preflight.</p>{preflight.map((d, n) => <p key={n}><button onClick={() => setSelection([...d.objectIds])}>{d.code}: {d.message} {d.objectIds.join(', ')}</button></p>)}</details>
      </aside>
    </div>
    <footer className="history-bar"><nav aria-label="History"><button disabled={fileBusy || view.mode !== 'Editing' || !view.history.undoCount} onClick={() => void send({ kind: 'undo' })}>Undo ({view.history.undoCount})</button><button disabled={fileBusy || view.mode !== 'Editing' || !view.history.redoCount} onClick={() => void send({ kind: 'redo' })}>Redo ({view.history.redoCount})</button></nav><span>{view.mode === 'Editing' ? 'DESIGN · applied changes only' : 'LIVE · acknowledged worker state'} · Potential is not current</span>
      <span>Educational simulation · ideal 24 V DC · Not for real electrical installations.</span>
      <a href="https://github.com/Xuaps/independent-circuit-editor/issues" target="_blank" rel="noopener noreferrer">Report an issue</a>
    </footer>
  </main>;
}

function InstanceInspector({ instance: i, project, send, select }: { instance: Instance; project: import('../core/domain/types').Project; send: (intent: Intent) => Promise<boolean>; select: (ids: string[]) => void }) {
  const def = getDefinition(i.definition.id)!, device = project.devices.find(d => d.id === i.deviceId);
  return <><h3 className="selected-name">{device?.name ?? 'Unassigned'}{i.label ? ` · ${i.label}` : ''}</h3><p className="muted">{titles[i.definition.id]} · selected symbol</p><details><summary>Technical identity</summary><p>Instance ID: <code>{i.id}</code></p><p>Device ID: <code>{i.deviceId ?? 'Unassigned (blocks Run)'}</code></p></details>
    <form onSubmit={e => { const d = form(e); void send({ kind: 'apply', operations: [{ op: 'instance.bind', instanceId: i.id, deviceId: String(d.get('device')) || null }] }); }}><label>Bound device<select name="device" defaultValue={i.deviceId ?? ''}><option value="">Unassigned</option>{project.devices.filter(d => d.kind === def.deviceKind).map(d => <option value={d.id} key={d.id}>{d.name} · {d.kind}</option>)}</select></label><button>Apply binding</button></form>
    {device && def.role === 'observer' && project.sheets[0]!.instances.filter(x => x.deviceId === device.id && x.definition.id === 'core.relay.coil').map(x => <button key={x.id} onClick={() => select([x.id])}>Show {device.name} coil</button>)}
    {device && <><details><summary>Device settings and linked symbols</summary><form onSubmit={e => { const d = form(e); void send({ kind: 'apply', operations: [{ op: 'device.rename', deviceId: device.id, name: String(d.get('name')) }] }); }}><label>Device name<input name="name" defaultValue={device.name}/></label><p className="muted">Name: a letter followed by up to 31 letters, digits, _ or -. Use the symbol label for free text.</p><button>Rename device</button></form>
      <button onClick={() => select(project.sheets[0]!.instances.filter(x => x.deviceId === device.id).map(x => x.id))}>Select linked coil / contacts</button>
      {project.sheets[0]!.instances.filter(x => x.deviceId === device.id).map(x => <button key={x.id} onClick={() => select([x.id])}>Navigate {titles[x.definition.id]} ({x.id})</button>)}
      {device.kind === 'dcSupply' && <p>Fixed nominal voltage: 24 V</p>}
      {device.kind === 'lamp' && <form onSubmit={e => { const d = form(e); void send({ kind: 'apply', operations: [{ op: 'device.parameters.replace', deviceId: device.id, parameters: { color: String(d.get('color')) } }] }); }}><label>Lamp color<select name="color" defaultValue={device.parameters.color}>{def.parameters[0]!.values.map(c => <option key={c}>{c}</option>)}</select></label><button>Apply parameters</button></form>}
    </details></>}
    <form onSubmit={e => { const d = form(e); const labels = Object.fromEntries(def.ports.map(p => [p.id, String(d.get(`port-${p.id}`))])); const ops: Operation[] = [{ op: 'instance.presentation.replace', instanceId: i.id, label: String(d.get('label')), markings: { showDeviceName: d.has('showDeviceName'), showLabel: d.has('showLabel'), showTerminals: d.has('showTerminals'), terminalLabels: labels } }]; void send({ kind: 'apply', operations: ops }); }}>
      <label>Symbol label<input name="label" defaultValue={i.label}/></label><details><summary>Markings and terminal labels</summary>{(['showDeviceName', 'showLabel', 'showTerminals'] as const).map(k => <label key={k}><input name={k} type="checkbox" defaultChecked={i.markings[k]}/>{k}</label>)}
      {def.ports.map(p => <label key={p.id}>Terminal {p.id} marking<input name={`port-${p.id}`} defaultValue={i.markings.terminalLabels[p.id] ?? p.defaultMarking}/></label>)}</details><button>Apply presentation</button>
    </form>
    <details><summary>Exact symbol position</summary><form onSubmit={e => { const d = form(e); void send({ kind: 'transform', transforms: { [i.id]: { ...i.transform, position: { x: number(d, 'x'), y: number(d, 'y') } } } }); }}><label>Symbol X<input name="x" type="number" defaultValue={i.transform.position.x}/></label><label>Symbol Y<input name="y" type="number" defaultValue={i.transform.position.y}/></label><button>Move to position</button></form></details>
  </>;
}
