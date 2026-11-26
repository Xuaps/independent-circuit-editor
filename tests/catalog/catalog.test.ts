import { describe, expect, it } from 'vitest';
import { defaultDevice, definitions, getDefinition, initializationPolicy, profileStatus } from '../../src/core/catalog';
import { limitedMetadata } from '../../src/contracts/metadata';
import { validateShape } from '../../src/contracts/validation';
import { createProject } from '../../src/core/domain/project';
describe('single trusted headless catalog', () => {
  it('enriches exactly the immutable seven definitions while preserving historical profile status', () => {
    expect(definitions).toHaveLength(7);
    expect(profileStatus).toBe('proposed-not-implemented');
    for (const [index, definition] of definitions.entries()) {
      const raw = limitedMetadata.definitions[index]!;
      for (const key of ['id', 'version', 'deviceKind', 'role', 'domain', 'ports', 'actions', 'observables'] as const) expect(definition[key]).toEqual(raw[key]);
      expect(definition.behavior.implementation).toBe('implemented');
      expect(definition.behavior.reference).toBe(definition.id);
      expect(definition.designer.rendererKey).toBe(definition.id);
      expect(Object.isFrozen(definition.ports[0]!.anchor)).toBe(true);
      expect(() => { (definition.ports as unknown[]).push({}); }).toThrow();
    }
    expect(getDefinition('constructor')).toBeUndefined();
    expect(getDefinition('core.lamp', 2)).toBeUndefined();
  });
  it('provides complete canonical parameters, ownership and initialization without saved runtime', () => {
    const base = createProject('p', 's'); if (!base.ok) throw Error('fixture');
    for (const kind of ['dcSupply', 'pushButton', 'relay', 'lamp'] as const) {
      const device = defaultDevice('d', 'D', kind);
      expect(validateShape('project', { ...base.value, devices: [device] }).valid).toBe(true);
      expect(device.initial).toEqual({});
    }
    expect(defaultDevice('v', 'V', 'dcSupply').parameters).toEqual({ nominalVoltageV: 24 });
    expect(defaultDevice('h', 'H', 'lamp').parameters).toEqual({ color: 'amber' });
    expect(initializationPolicy.pushButton).toBe('released');
    expect(initializationPolicy.relay).toBe('nonretentive-deenergized');
    expect(getDefinition('core.dc.supply')!.parameters[0]).toMatchObject({ owner: 'device', unit: 'V', default: 24 });
    expect(getDefinition('core.relay.contact.no')!.behavior.stateOwner).toBe('observe-device');
  });
});
