import type { Instance, ObservableValue, ProbeTarget } from '../../core/domain/types';
import type { RuntimeView } from '../../core/engine';

export type GlyphPresentation = Readonly<{
  primary: ObservableValue;
  pressed: ObservableValue;
  energized: ObservableValue;
  pending: boolean;
}>;
const missing = (): ObservableValue => ({ quality: 'unknown', code: 'CHANNEL_UNAVAILABLE' });
/** Exact kind + stable ID lookup; display names and object property lookup are never channels. */
export function channel(runtime: Pick<RuntimeView, 'live'>, kind: ProbeTarget['kind'], id: string | null, observable: string): ObservableValue {
  return runtime.live.find(o => o.target.kind === kind && o.target.id === id && o.observable === observable)?.value ?? missing();
}
export function projectGlyph(i: Instance, runtime: Pick<RuntimeView, 'live' | 'pending'> | null): GlyphPresentation {
  if (!runtime) return { primary: missing(), pressed: missing(), energized: missing(), pending: false };
  const key = i.definition.id;
  const primary = key === 'core.dc.supply' ? channel(runtime, 'device', i.deviceId, 'enabled') :
    channel(runtime, 'instance', i.id, key === 'core.lamp' ? 'lit' : key === 'core.relay.coil' ? 'powered' : 'closed');
  return { primary, pressed: channel(runtime, 'device', i.deviceId, 'pressed'), energized: channel(runtime, 'device', i.deviceId, 'energized'), pending: runtime.pending.some(t => t.actions.some(a => a.instanceId === i.id)) };
}
export const knownBoolean = (v: ObservableValue) => v.quality === 'known' ? v.value : undefined;
