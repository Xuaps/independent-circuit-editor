import { getDefinition } from '../catalog';
import type { Endpoint, Instance, Point, Sheet, Transform, Wire } from './types';
export const COORDINATE_LIMIT = 1_000_000;
export function transformPoint(anchor: Point, transform: Transform): Point {
  const x = transform.mirrorX ? -anchor.x : anchor.x, y = anchor.y;
  const [rx, ry] = transform.rotation === 0 ? [x, y] : transform.rotation === 90 ? [-y, x] : transform.rotation === 180 ? [-x, -y] : [y, -x];
  return Object.freeze({ x: rx + transform.position.x, y: ry + transform.position.y });
}
export function portPosition(instance: Instance, portId: string): Point | undefined {
  const port = getDefinition(instance.definition.id, instance.definition.version)?.ports.find(p => p.id === portId);
  return port ? transformPoint(port.anchor, instance.transform) : undefined;
}
export function endpointPosition(sheet: Sheet, endpoint: Endpoint): Point | undefined {
  if (endpoint.kind === 'dangling') return endpoint.position;
  if (endpoint.kind === 'junction') return sheet.junctions.find(j => j.id === endpoint.junctionId)?.position;
  const instance = sheet.instances.find(i => i.id === endpoint.instanceId);
  return instance ? portPosition(instance, endpoint.portId) : undefined;
}
/** Geometry never infers topology: ordered interior waypoints only. */
export function wirePoints(sheet: Sheet, wire: Wire): readonly Point[] | undefined {
  const from = endpointPosition(sheet, wire.from), to = endpointPosition(sheet, wire.to);
  return from && to ? Object.freeze([from, ...wire.waypoints, to]) : undefined;
}
export function boundedPoint(point: Point): boolean { return Number.isSafeInteger(point.x) && Number.isSafeInteger(point.y) && Math.abs(point.x) <= COORDINATE_LIMIT && Math.abs(point.y) <= COORDINATE_LIMIT; }
export function orthogonalSegment(a: Point, b: Point): boolean { return (a.x === b.x) !== (a.y === b.y); }
