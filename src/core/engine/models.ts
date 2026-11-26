import { definitions, getDefinition, type Definition, type DefinitionId } from '../catalog';
import { freeze, type ObservableValue } from '../domain/types';
/** Trusted models consume one solved element input; never solve or publish themselves. */
export type Model = Readonly<{
  definition: Definition;
  initialize: () => boolean;
  transition: (state: boolean, powered: boolean) => boolean;
  closure?: (state: boolean) => boolean;
  action?: (state: boolean, action: 'press' | 'release') => boolean;
  instanceValues: (state: boolean, powered: boolean) => Readonly<Record<string, boolean>>;
  deviceObservable: 'enabled' | 'pressed' | 'energized' | 'lit';
}>;
function register(id: DefinitionId, behavior: Omit<Model, 'definition'>): Model {
  return freeze({ definition: getDefinition(id)!, ...behavior });
}
const held = (s: boolean) => s, powered = (_s: boolean, p: boolean) => p;
const no = (s: boolean) => s, nc = (s: boolean) => !s;
const contact = (id: DefinitionId, inverse: boolean, button: boolean): Model => register(id, {
  initialize: () => false, transition: held, closure: inverse ? nc : no,
  ...(button ? { action: (_state: boolean, action: 'press' | 'release') => action === 'press' } : {}),
  instanceValues: s => ({ closed: (inverse ? nc : no)(s) }), deviceObservable: button ? 'pressed' : 'energized'
});
const entries: readonly Model[] = [
  register('core.dc.supply', { initialize: () => true, transition: held, instanceValues: () => ({}), deviceObservable: 'enabled' }),
  contact('core.pushbutton.no', false, true), contact('core.pushbutton.nc', true, true),
  register('core.relay.coil', { initialize: () => false, transition: powered, instanceValues: (_s, p) => ({ powered: p }), deviceObservable: 'energized' }),
  contact('core.relay.contact.no', false, false), contact('core.relay.contact.nc', true, false),
  register('core.lamp', { initialize: () => false, transition: powered, instanceValues: (_s, p) => ({ lit: p }), deviceObservable: 'lit' })
];
const registry = new Map(entries.map(m => [m.definition.id, m]));
export const models: readonly Model[] = freeze(entries);
export function getModel(id: string, version = 1): Model | undefined { return version === 1 ? registry.get(id as DefinitionId) : undefined; }
export const known = (value: boolean): ObservableValue => ({ quality: 'known', value });
// Coverage is enforced against the catalog, not a second externally loadable library.
if (definitions.some(d => !getModel(d.id, d.version))) throw new Error('Trusted model coverage invariant');
