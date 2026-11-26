import { getDefinition } from '../../core/catalog';
import { portPosition, wirePoints } from '../../core/domain/geometry';
import type { Instance, Point, Project } from '../../core/domain/types';

export type Viewport = { x: number; y: number; width: number; height: number };
/** Presentation-only bounds, including requested text. No document coordinates are changed. */
export function markingLayout(project: Project, i: Instance) {
  const name = project.devices.find(d => d.id === i.deviceId)?.name ?? 'Unassigned';
  const ports = getDefinition(i.definition.id)!.ports.map(p => portPosition(i, p.id)!);
  const verticalPorts = ports.some(p => Math.abs(p.y - i.transform.position.y) > 20);
  const relayContact = i.definition.id.includes('relay.contact');
  const nameOffset = verticalPorts ? Math.min(-30, ...ports.map(p => p.y - i.transform.position.y)) - 30 : relayContact ? -26 : -46;
  const labelOffset = verticalPorts ? Math.max(30, ...ports.map(p => p.y - i.transform.position.y)) + 26 : relayContact ? 34 : 34;
  return { name, nameY: i.transform.position.y + nameOffset, labelY: i.transform.position.y + labelOffset };
}
export function circuitViewport(project: Project): Viewport {
  const s = project.sheets[0]!;
  const points: Point[] = [...s.junctions.map(j => j.position), ...s.wires.flatMap(w => wirePoints(s, w) ?? [])];
  const text = (value: string, x: number, y: number, centered = false) => {
    // Bound conservative text estimates; very long labels still remain zoomable, not a fit overflow.
    const width = Math.min(20000, Array.from(value).length * 8);
    points.push({ x: x - (centered ? width / 2 : 0), y: y - 16 }, { x: x + (centered ? width / 2 : width), y: y + 6 });
  };
  for (const i of s.instances) {
    const p = i.transform.position, layout = markingLayout(project, i);
    points.push({ x: p.x - 34, y: p.y - 34 }, { x: p.x + 34, y: p.y + 34 });
    if (i.markings.showDeviceName) text(layout.name, p.x, layout.nameY, true);
    if (i.markings.showLabel) text(i.label, p.x, layout.labelY, true);
    for (const port of getDefinition(i.definition.id)!.ports) {
      const a = portPosition(i, port.id)!; points.push(a);
      if (i.markings.showTerminals) text(Object.hasOwn(i.markings.terminalLabels, port.id) ? i.markings.terminalLabels[port.id]! : port.defaultMarking, a.x - 12, a.y - 10);
    }
  }
  for (const a of s.annotations) text(a.text, a.position.x, a.position.y);
  const finite = points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!finite.length) return { x: 0, y: 0, width: 1000, height: 800 };
  const { minX, minY, maxX, maxY } = finite.reduce((b, p) => ({ minX: Math.min(b.minX, p.x), minY: Math.min(b.minY, p.y), maxX: Math.max(b.maxX, p.x), maxY: Math.max(b.maxY, p.y) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  return { x: minX - 24, y: minY - 24, width: Math.max(120, maxX - minX + 48), height: Math.max(120, maxY - minY + 48) };
}
