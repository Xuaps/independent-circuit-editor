import { limitedMetadata } from '../../contracts/metadata';
import { freeze, type Device, type DeviceKind, type Point } from '../domain/types';
export type DefinitionId = 'core.dc.supply' | 'core.pushbutton.no' | 'core.pushbutton.nc' | 'core.relay.coil' | 'core.relay.contact.no' | 'core.relay.contact.nc' | 'core.lamp';
export type Port = Readonly<{ id: string; role: string; anchor: Point; defaultMarking: string }>;
export type ParameterContract = Readonly<{ owner: 'device'; key: 'nominalVoltageV' | 'color'; unit: 'V' | null; default: 24 | 'amber'; values: readonly (string | number)[]; effect: 'recompile' | 'presentation' }>;
export type Definition = Readonly<{ id: DefinitionId; version: 1; deviceKind: DeviceKind; role: 'controller' | 'observer'; domain: 'electrical.dc'; ports: readonly Port[]; actions: readonly string[]; observables: Readonly<Record<string, string>>; parameters: readonly ParameterContract[]; instanceParameters: readonly []; designer: Readonly<{ rendererKey: DefinitionId; variants: readonly ['default']; bounds: Readonly<{ min: Point; max: Point }> }>; behavior: Readonly<{ reference: DefinitionId; version: 1; capability: 'ideal-dc-24v'; implementation: 'implemented'; stateOwner: 'device' | 'observe-device' }> }>;
const voltage: ParameterContract = { owner: 'device', key: 'nominalVoltageV', unit: 'V', default: 24, values: [24], effect: 'recompile' };
const color: ParameterContract = { owner: 'device', key: 'color', unit: null, default: 'amber', values: ['amber', 'green', 'red', 'blue', 'white'], effect: 'presentation' };
/** Metadata supplies identity/ports/actions. Behavior references the covered trusted engine registry, never project code. */
export const definitions: readonly Definition[] = freeze(limitedMetadata.definitions.map(raw => ({
  ...raw, id: raw.id as DefinitionId, version: 1, deviceKind: raw.deviceKind as DeviceKind,
  role: raw.role as 'controller' | 'observer', domain: 'electrical.dc',
  parameters: raw.deviceKind === 'dcSupply' ? [voltage] : raw.deviceKind === 'lamp' ? [color] : [], instanceParameters: [],
  designer: { rendererKey: raw.id as DefinitionId, variants: ['default'], bounds: { min: { x: -30, y: -30 }, max: { x: 30, y: 30 } } },
  behavior: { reference: raw.id as DefinitionId, version: 1, capability: 'ideal-dc-24v', implementation: 'implemented', stateOwner: raw.role === 'observer' ? 'observe-device' : 'device' }
})) as Definition[]);
const byId = new Map(definitions.map(d => [d.id as string, d]));
export function getDefinition(id: string, version = 1): Definition | undefined { return version === 1 ? byId.get(id) : undefined; }
export const profileStatus = limitedMetadata.status;
/** Complete persisted defaults. Released/nonretentive initialization is a model contract, not extra saved state. */
export function defaultDevice(id: string, name: string, kind: DeviceKind): Device {
  switch (kind) {
    case 'dcSupply': return freeze({ id, name, kind, parameters: { nominalVoltageV: 24 }, initial: {} });
    case 'lamp': return freeze({ id, name, kind, parameters: { color: 'amber' }, initial: {} });
    case 'relay': case 'pushButton': return freeze({ id, name, kind, parameters: {}, initial: {} });
  }
}
export const initializationPolicy = freeze({ dcSupply: 'enabled', pushButton: 'released', relay: 'nonretentive-deenergized', lamp: 'derived' } as const);
