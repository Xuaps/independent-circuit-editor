import { expect, test } from 'vitest';
import example from '../../public/selfhold.circuit.json';
import { validateProject } from '../../src/core/domain/project';
import { circuitViewport, markingLayout } from '../../src/ui/editor/viewport';
import { portPosition } from '../../src/core/domain/geometry';
function project() { const checked = validateProject(example); if (!checked.ok) throw Error('fixture'); return checked.value; }
test('fit circuit includes actual symbols/markings/wires but not empty page; never mutates data', () => {
  const p = project(), before = JSON.stringify(p), fitted = circuitViewport(p);
  expect(fitted.width).toBeLessThan(p.sheets[0]!.page.width);
  for (const i of p.sheets[0]!.instances) {
    const marking = markingLayout(p, i);
    expect(i.transform.position.x).toBeGreaterThan(fitted.x);
    expect(i.transform.position.x).toBeLessThan(fitted.x + fitted.width);
    expect(marking.nameY).toBeGreaterThan(fitted.y);
    expect(marking.labelY).toBeLessThan(fitted.y + fitted.height);
  }
  expect(JSON.stringify(p)).toEqual(before);
});
test('blank fit stays authorable with finite conventional extent', () => {
  const p = project();
  const blank = { ...p, sheets: [{ ...p.sheets[0]!, instances: [], wires: [], annotations: [], junctions: [] }] };
  expect(circuitViewport(blank)).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
});
test('off-page annotations and long requested text extend finite bounds without spreading huge argument arrays', () => {
  const p = project(), s = p.sheets[0]!;
  const changed = { ...p, sheets: [{ ...s, annotations: [{ id: 'far', position: { x: -900000, y: 900000 }, text: 'W'.repeat(10000) }] }] };
  const b = circuitViewport(changed);
  expect(Object.values(b).every(Number.isFinite)).toBe(true);
  expect(b.x).toBeLessThan(-900000); expect(b.y + b.height).toBeGreaterThan(900000);
});
test('relay contact name does not collide with preceding pushbutton label in example', () => {
  const p = project(), instances = p.sheets[0]!.instances;
  const start = instances.find(i => i.id === 'instance_start')!, hold = instances.find(i => i.id === 'instance_hold')!;
  expect(markingLayout(p, hold).nameY - markingLayout(p, start).labelY).toBeGreaterThanOrEqual(20);
});
test('vertical source name clears terminal text; identity and anchors remain original', () => {
  const p = project(), source = p.sheets[0]!.instances.find(i => i.id === 'instance_supply')!;
  const plus = portPosition(source, 'plus')!;
  expect((plus.y - 10) - markingLayout(p, source).nameY).toBeGreaterThanOrEqual(18);
  expect(source.transform.position).toEqual({ x: 100, y: 200 });
  expect(plus).toEqual({ x: 100, y: 170 });
});
