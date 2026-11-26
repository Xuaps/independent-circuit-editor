import { describe, expect, it } from 'vitest';
import { createLocalClient } from '../../../src/ui/editor/application';
import { createProject } from '../../../src/core/domain/project';
import { decodeProject } from '../../../src/core/persistence';
import { portPosition } from '../../../src/core/domain/geometry';

function setup() { let n = 0; return createLocalClient(undefined, () => `test_${++n}`); }
describe('replaceable authoring client over the shared session', () => {
  it('starts blank with stable snapshots and emits one notification per atomic placement', async () => {
    const client = setup(), initial = client.getSnapshot(); let calls = 0;
    const unsubscribe = client.subscribe(() => calls++);
    expect(initial.design.sheets[0]!.instances).toEqual([]); expect(client.getSnapshot()).toBe(initial);
    await client.dispatch({ kind: 'place', definition: 'core.relay.coil', position: { x: 100, y: 100 } });
    expect(calls).toBe(1); expect(client.getSnapshot().history.undoCount).toBe(1);
    expect(client.getSnapshot().design.devices[0]!.name).toBe('K1'); expect(initial.design.devices).toEqual([]);
    unsubscribe(); await client.dispatch({ kind: 'undo' }); expect(calls).toBe(1); expect(client.getSnapshot().dirty).toBe(false);
  });
  it('serializes concurrent intents against current revision rather than losing history', async () => {
    const client = setup();
    await Promise.all(['core.dc.supply', 'core.pushbutton.nc', 'core.pushbutton.no', 'core.relay.coil', 'core.relay.contact.no', 'core.relay.contact.nc', 'core.lamp'].map((definition, n) => client.dispatch({ kind: 'place', definition, position: { x: 100 + n * 100, y: 100 } })));
    expect(client.getSnapshot().design.revision).toBe(7); expect(client.getSnapshot().design.devices).toHaveLength(5);
    expect(client.preflight().filter(d => d.code === 'UNBOUND_INSTANCE')).toHaveLength(2);
    expect(decodeProject(client.inspect()).ok).toBe(true);
  });
  it('rejects invalid placement/wiring/property batches without notifying or losing redo', async () => {
    const client = setup(); await client.dispatch({ kind: 'place', definition: 'core.lamp', position: { x: 100, y: 100 } }); await client.dispatch({ kind: 'undo' });
    const before = client.getSnapshot(); let calls = 0; client.subscribe(() => calls++);
    expect((await client.dispatch({ kind: 'place', definition: 'core.lamp', position: { x: 1.2, y: 100 } })).ok).toBe(false);
    expect((await client.dispatch({ kind: 'place', definition: 'nonexistent', position: { x: 100, y: 100 } })).ok).toBe(false);
    expect(client.getSnapshot()).toBe(before); expect(calls).toBe(0); expect(before.history.redoCount).toBe(1);
  });
  it('binding and rename/hide retain identity and copy external contacts becomes unassigned', async () => {
    const c = setup(); await c.dispatch({ kind: 'place', definition: 'core.relay.coil', position: { x: 100, y: 100 } }); await c.dispatch({ kind: 'place', definition: 'core.relay.contact.no', position: { x: 300, y: 100 } });
    const [coil, contact] = c.getSnapshot().design.sheets[0]!.instances;
    await c.dispatch({ kind: 'apply', operations: [{ op: 'instance.bind', instanceId: contact!.id, deviceId: coil!.deviceId }] });
    await c.dispatch({ kind: 'apply', operations: [{ op: 'device.rename', deviceId: coil!.deviceId!, name: 'Main' }, { op: 'instance.presentation.replace', instanceId: coil!.id, label: '<script>inert</script>', markings: { ...coil!.markings, showDeviceName: false } }] });
    expect(c.getSnapshot().design.sheets[0]!.instances[1]!.deviceId).toBe(coil!.deviceId);
    const result = await c.dispatch({ kind: 'copy', ids: [contact!.id] }); expect(result.ok).toBe(true);
    expect(c.getSnapshot().design.sheets[0]!.instances.find(i => i.id === result.selection![0])!.deviceId).toBe(null);
    const internal = await c.dispatch({ kind: 'copy', ids: [coil!.id, contact!.id] });
    const copies = c.getSnapshot().design.sheets[0]!.instances.filter(i => internal.selection!.includes(i.id));
    expect(copies[0]!.deviceId).toBe(copies[1]!.deviceId); expect(copies[0]!.deviceId).not.toBe(coil!.deviceId);
  });
  it('transform reroutes attached wires with stable ports; undo restores routes', async () => {
    const c = setup(); await c.dispatch({ kind: 'place', definition: 'core.lamp', position: { x: 100, y: 100 } });
    const i = c.getSnapshot().design.sheets[0]!.instances[0]!;
    await c.dispatch({ kind: 'wire', from: { kind: 'port', instanceId: i.id, portId: 'p1' }, to: { kind: 'dangling', position: { x: 300, y: 100 } } });
    const before = c.getSnapshot().design.sheets[0]!.wires[0]!;
    await c.dispatch({ kind: 'transform', transforms: { [i.id]: { position: { x: 200, y: 200 }, rotation: 90, mirrorX: true } } });
    expect(c.getSnapshot().design.sheets[0]!.wires[0]!.from).toEqual(before.from);
    expect(portPosition(c.getSnapshot().design.sheets[0]!.instances[0]!, 'p1')).toBeDefined();
    await c.dispatch({ kind: 'undo' }); expect(c.getSnapshot().design.sheets[0]!.wires[0]).toEqual(before);
  });
  it('split plus branch is one undo unit and unrelated crossing remains untouched', async () => {
    const c = setup();
    await c.dispatch({ kind: 'wire', from: { kind: 'dangling', position: { x: 100, y: 100 } }, to: { kind: 'dangling', position: { x: 500, y: 100 } } });
    await c.dispatch({ kind: 'wire', from: { kind: 'dangling', position: { x: 300, y: 0 } }, to: { kind: 'dangling', position: { x: 300, y: 200 } } });
    const before = c.getSnapshot(), wire = before.design.sheets[0]!.wires[0]!;
    expect(before.design.sheets[0]!.junctions).toHaveLength(0);
    const r = await c.dispatch({ kind: 'split', wireId: wire.id, point: { x: 300, y: 100 }, from: { kind: 'dangling', position: { x: 200, y: 0 } } });
    expect(r.ok).toBe(true); expect(c.getSnapshot().history.undoCount).toBe(before.history.undoCount + 1);
    expect(c.getSnapshot().design.sheets[0]!.wires[1]).toEqual(before.design.sheets[0]!.wires[1]);
    await c.dispatch({ kind: 'undo' }); expect(c.getSnapshot().design.sheets[0]).toEqual(before.design.sheets[0]);
  });
  it('invalid compound branch is wholly rolled back', async () => {
    const c = setup(); await c.dispatch({ kind: 'wire', from: { kind: 'dangling', position: { x: 100, y: 100 } }, to: { kind: 'dangling', position: { x: 500, y: 100 } } });
    const before = c.getSnapshot(); const r = await c.dispatch({ kind: 'split', wireId: before.design.sheets[0]!.wires[0]!.id, point: { x: 300, y: 100 }, from: { kind: 'dangling', position: { x: 300, y: 100 } } });
    expect(r.ok).toBe(false); expect(c.getSnapshot()).toBe(before);
  });
  it('explicit relocation returns replacement selection and remaps incident endpoints', async () => {
    const c = setup(); const r = await c.dispatch({ kind: 'junction', position: { x: 100, y: 100 } }), old = r.selection![0]!;
    await c.dispatch({ kind: 'wire', from: { kind: 'junction', junctionId: old }, to: { kind: 'dangling', position: { x: 300, y: 100 } } });
    const moved = await c.dispatch({ kind: 'relocate', id: old, position: { x: 100, y: 200 } }); expect(moved.selection![0]).not.toBe(old);
    expect(c.getSnapshot().design.sheets[0]!.wires[0]!.from).toEqual({ kind: 'junction', junctionId: moved.selection![0] });
    await c.dispatch({ kind: 'undo' }); expect(c.getSnapshot().design.sheets[0]!.junctions[0]!.id).toBe(old);
    await c.dispatch({ kind: 'redo' }); expect(c.getSnapshot().design.sheets[0]!.junctions[0]!.id).toBe(moved.selection![0]);
  });
  it('delete detaches explicitly; annotation uses canonical add/remove only', async () => {
    const c = setup(); const r = await c.dispatch({ kind: 'junction', position: { x: 100, y: 100 } });
    await c.dispatch({ kind: 'wire', from: { kind: 'junction', junctionId: r.selection![0]! }, to: { kind: 'dangling', position: { x: 300, y: 100 } } });
    await c.dispatch({ kind: 'delete', ids: r.selection!, policy: 'detach' }); expect(c.getSnapshot().design.sheets[0]!.wires[0]!.from.kind).toBe('dangling');
    const text = await c.dispatch({ kind: 'annotation', position: { x: -200, y: 100 }, text: '<img src=x>' });
    await c.dispatch({ kind: 'delete', ids: text.selection!, policy: 'remove-wires' }); expect(c.getSnapshot().design.sheets[0]!.annotations).toEqual([]);
  });
  it('injected legal prototype identities work; no mutable session escapes', async () => {
    const blank = createProject('constructor', 'toString'); if (!blank.ok) throw Error('fixture');
    const c = createLocalClient(blank.value, (() => { const ids = ['valueOf', 'hasOwnProperty']; return () => ids.shift()!; })());
    const r = await c.dispatch({ kind: 'place', definition: 'core.lamp', position: { x: 100, y: 100 } }); expect(r.ok).toBe(true);
    expect(Object.keys(c).sort()).toEqual(['control', 'dispatch', 'fileTransaction', 'getSnapshot', 'inspect', 'preflight', 'run', 'runtimeError', 'stop', 'subscribe']);
    expect(Object.isFrozen(c.getSnapshot().design)).toBe(true);
  });
});
