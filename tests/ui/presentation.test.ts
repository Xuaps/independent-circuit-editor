import { describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { definitions } from '../../src/core/catalog';
import type { Instance, ObservableValue } from '../../src/core/domain/types';
import type { RuntimeView } from '../../src/core/engine';
import { channel, projectGlyph } from '../../src/ui/simulation/presentation';
import { Glyph } from '../../src/ui/editor/glyph';
import { exportSvg } from '../../src/ui/export/design';
import example from '../../public/selfhold.circuit.json';
import { validateProject } from '../../src/core/domain/project';
function instance(key: string): Instance { return { id: '__proto__', deviceId: 'constructor', definition: { id: key, version: 1 }, variant: 'default', parameters: {}, transform: { position: { x: 0, y: 0 }, rotation: 0, mirrorX: false }, label: '', markings: { showDeviceName: true, showLabel: true, showTerminals: true, terminalLabels: {} } }; }
function runtime(i: Instance, value: ObservableValue): RuntimeView {
  const channels = [['instance', i.id, 'closed'], ['instance', i.id, 'lit'], ['instance', i.id, 'powered'], ['device', i.deviceId!, 'energized'], ['device', i.deviceId!, 'pressed'], ['device', i.deviceId!, 'enabled']] as const;
  return { live: channels.map(([kind, id, observable]) => ({ target: { kind, id }, observable, value })), pending: [] } as unknown as RuntimeView;
}
const draw = (i: Instance, r?: RuntimeView) => renderToStaticMarkup(createElement(Glyph, { instance: i, ...(r ? { state: projectGlyph(i, r) } : {}) }));
describe('seven original glyph presentations', () => {
  for (const d of definitions) {
    test(`${d.id}: known true/false changes geometry or indication; fixed leads preserved`, () => {
      const i = instance(d.id), off = draw(i, runtime(i, { quality: 'known', value: false })), on = draw(i, runtime(i, { quality: 'known', value: true }));
      if (d.id !== 'core.dc.supply') expect(off).not.toEqual(on);
      for (const p of d.ports) for (const markup of [off, on, draw(i)]) expect(markup).toContain(`d="M ${p.anchor.x} ${p.anchor.y} L ${p.anchor.x * .45} ${p.anchor.y * .45}"`);
      if (d.id.includes('contact') || d.id.includes('pushbutton')) { expect(on).toContain('rotate(0 -9 0)'); expect(off).toContain('rotate(-38 -9 0)'); }
    });
    for (const quality of ['unknown', 'unsupported', 'faulted'] as const) test(`${d.id}: ${quality} is explicit, not known off`, () => {
      const i = instance(d.id), markup = draw(i, runtime(i, { quality, code: 'TEST_REASON' }));
      expect(markup).toContain(`data-quality="${quality}"`); expect(markup).toContain('TEST_REASON'); expect(markup).toContain('data-quality-badge');
    });
  }
  test('normal NC closed, NO open; editing/export have no runtime motion/glow/badges', () => {
    expect(draw(instance('core.pushbutton.nc'))).toContain('data-closed="true"'); expect(draw(instance('core.pushbutton.no'))).toContain('data-closed="false"');
    const p = validateProject(example); if (!p.ok) throw Error('fixture');
    const svg = exportSvg(p.value); expect(svg).not.toMatch(/runtime-glyph|data-quality-badge|data-lit-rays|data-pending/); expect(svg).toContain('design-glyph');
  });
  test('exact target kinds, missing channels, stable prototype-like IDs and coil powered/energized split', () => {
    const i = instance('core.relay.coil'), r = runtime(i, { quality: 'known', value: false });
    const live = [{ target: { kind: 'device' as const, id: i.id }, observable: 'powered', value: { quality: 'known' as const, value: true } }, ...r.live];
    expect(channel({ live }, 'instance', i.id, 'powered')).toEqual({ quality: 'known', value: false });
    expect(channel({ live: [] }, 'instance', i.id, 'powered')).toEqual({ quality: 'unknown', code: 'CHANNEL_UNAVAILABLE' });
    expect(projectGlyph(i, { ...r, live: r.live.filter(o => o.observable !== 'powered') }).primary.quality).toBe('unknown');
    expect(projectGlyph(i, null).primary.quality).toBe('unknown');
    expect(projectGlyph(i, r).energized).toEqual({ quality: 'known', value: false });
  });
});
