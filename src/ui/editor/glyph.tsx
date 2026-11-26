import { getDefinition } from '../../core/catalog';
import type { Instance } from '../../core/domain/types';
import { knownBoolean, type GlyphPresentation } from '../simulation/presentation';
/** Original IEC-style drawing, not normative artwork. Fixed catalog leads never animate. */
export function Glyph({ instance, state }: { instance: Pick<Instance, 'definition'>; state?: GlyphPresentation }) {
  const key = instance.definition.id, def = getDefinition(key)!;
  const contact = key.includes('pushbutton') || key.includes('contact');
  const closed = state ? knownBoolean(state.primary) : key.endsWith('.nc');
  const pressed = state ? knownBoolean(state.pressed) : false;
  const on = state ? knownBoolean(state.primary) : false;
  const values = state ? [state.primary, ...(key.includes('pushbutton') ? [state.pressed] : key === 'core.relay.coil' ? [state.energized] : [])] : [];
  const bad = values.find(v => v.quality !== 'known');
  const quality = bad?.quality ?? (state ? 'known' : 'design');
  return <g className={state ? 'runtime-glyph' : 'design-glyph'} data-quality={quality} data-closed={contact ? String(closed ?? 'unavailable') : undefined} data-pressed={key.includes('pushbutton') ? String(pressed ?? 'unavailable') : undefined} data-on={!contact ? String(on ?? 'unavailable') : undefined} fill="none" stroke="currentColor" strokeWidth="2">
    {def.ports.map(p => <path data-lead={p.id} key={p.id} d={`M ${p.anchor.x} ${p.anchor.y} L ${p.anchor.x * .45} ${p.anchor.y * .45}`} />)}
    {key === 'core.dc.supply' ? <><circle r="18" fill="white"/><path d="M -6 -7 H 6 M 0 -13 V -1 M -6 8 H 6"/></> :
      key === 'core.lamp' ? <><circle r="18" fill={on === true ? '#ffe5a0' : 'white'}/><path d="M -12 -12 L 12 12 M -12 12 L 12 -12"/>{on === true && <path data-lit-rays="true" d="M -24 0 H -30 M 24 0 H 30 M 0 -24 V -30 M 0 24 V 30"/>}</> :
      key === 'core.relay.coil' ? <><rect x="-16" y="-18" width="32" height="36" fill={on === true ? '#d4eafa' : 'white'}/><path d="M -9 10 Q 9 10 9 0 Q 9 -10 -9 -10"/>{on === true && <path data-powered="true" d="M -10 14 H 10 M -10 -14 H 10"/>}</> :
      <><circle cx="-9" cy="0" r="1.5"/><circle cx="9" cy="0" r="1.5"/><path data-blade="true" className="contact-blade" d="M -9 0 H 9" transform={`rotate(${closed === true ? 0 : -38} -9 0)`} strokeDasharray={closed === undefined ? '3 2' : undefined}/>{key.includes('pushbutton') && <g data-actuator-head="true" className="actuator-head" transform={`translate(0 ${pressed === true ? 6 : 0})`}><path d="M 0 -18 V -28 M -12 -28 H 12" strokeDasharray="none"/><path d="M 0 -18 V -8" strokeDasharray="2 2"/></g>}</>}
    {bad && <g data-quality-badge={quality}><title>{`${bad.quality}: ${bad.code}`}</title><rect x="18" y="-30" width="18" height="18" fill="white"/><text x="22" y="-17" stroke="none" fill="currentColor">{quality === 'faulted' ? '!' : quality === 'unsupported' ? 'U' : '?'}</text></g>}
    {state?.pending && <text data-pending="true" x="-28" y="58" fill="currentColor" stroke="none" fontSize="10">Pending input</text>}
  </g>;
}
