import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { decodeProject } from '../../src/core/persistence';
import { getDefinition } from '../../src/core/catalog';
import { portPosition } from '../../src/core/domain/geometry';
import type { Point } from '../../src/core/domain/types';
import { DesignScene, exportSvg, presentationText } from '../../src/ui/export/design';
import sample from '../../examples/p0/selfhold.circuit.json';

it('replaces exactly XML 1.0 forbidden code points in presentation, not legal Unicode', () => {
  const legal = '\t\n\r <>&" é 漢 😀 \u007f\u0085\ufdd0';
  expect(presentationText(legal)).toBe(legal);
  const forbidden = '\u0000\u0001\u000b\u001f\ufffe\uffff\ud800X\udfff';
  expect(presentationText(forbidden)).toBe('�������X�');
  // The codec rejects unpaired surrogates; keep them in the defensive helper test above only.
  const accepted = '\u0000\u0001\u000b\u001f\ufffe\uffff';
  const p = { ...sample, title: accepted };
  const decoded = decodeProject(JSON.stringify(p));
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) throw Error('fixture');
  expect(exportSvg(decoded.value)).toContain('<title>������ — design only, page clipped, not physical scale</title>');
  expect(decoded.value.title).toBe(accepted);
});

it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty'])('preserves legal %s ID and exact body/ports absent an own finite preview', id => {
  const input = structuredClone(sample), first = input.sheets[0]!.instances[0]!;
  const old = first.id; first.id = id;
  for (const w of input.sheets[0]!.wires) for (const e of [w.from, w.to]) if (e.kind === 'port' && e.instanceId === old) e.instanceId = id;
  const decoded = decodeProject(JSON.stringify(input));
  if (!decoded.ok) throw Error(JSON.stringify(decoded.diagnostics));
  const p = decoded.value, instance = p.sheets[0]!.instances[0]!;
  const before = JSON.stringify(p);
  const baseline = renderToStaticMarkup(createElement(DesignScene, { project: p }));
  for (const positions of [{}, { unrelated: { x: 700, y: 800 } }, Object.create({ [id]: { x: 700, y: 800 } }), { [id]: { x: NaN, y: 8 } }, { [id]: { x: 7 } }, { [id]: Object.create({ x: 7, y: 8 }) }]) {
    const actual = renderToStaticMarkup(createElement(DesignScene, { project: p, positions: positions as Record<string, Point> }));
    expect(actual).toBe(baseline);
    expect(actual).not.toMatch(/NaN|undefined|Infinity/);
  }
  expect(baseline).toContain(`translate(${instance.transform.position.x} ${instance.transform.position.y})`);
  for (const port of getDefinition(instance.definition.id)!.ports) {
    const point = portPosition(instance, port.id)!;
    expect(baseline).toContain(`cx="${point.x}" cy="${point.y}"`);
    const moved = portPosition({ ...instance, transform: { ...instance.transform, position: { x: 700, y: 800 } } }, port.id)!;
    const preview = renderToStaticMarkup(createElement(DesignScene, { project: p, positions: { [id]: { x: 700, y: 800 } } }));
    expect(preview).toContain(`cx="${moved.x}" cy="${moved.y}"`);
  }
  expect(exportSvg(p)).not.toMatch(/NaN|undefined|Infinity/);
  const position = { x: 700, y: 800 };
  const preview = renderToStaticMarkup(createElement(DesignScene, { project: p, positions: { [id]: position } }));
  expect(preview).toContain('translate(700 800)');
  expect(preview).not.toBe(baseline);
  expect(JSON.stringify(p)).toBe(before);
});
