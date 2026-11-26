import { markingLayout } from '../editor/viewport';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { getDefinition } from '../../core/catalog';
import { portPosition, wirePoints } from '../../core/domain/geometry';
import type { Instance, Point, Project, Sheet } from '../../core/domain/types';
import { Glyph } from '../editor/glyph';

/** XML 1.0 Char ranges, applied only to presentation; stored strings stay untouched. */
export function presentationText(text: string): string {
  return Array.from(text, character => {
    const code = character.codePointAt(0)!;
    return code === 0x9 || code === 0xa || code === 0xd ||
      (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff) ? character : '\ufffd';
  }).join('');
}
function previewPosition(positions: Readonly<Record<string, Point>>, id: string): Point | undefined {
  if (!Object.hasOwn(positions, id)) return undefined;
  const point = positions[id];
  return point && Object.hasOwn(point, 'x') && Object.hasOwn(point, 'y') &&
    Number.isFinite(point.x) && Number.isFinite(point.y) ? point : undefined;
}

export function DesignMarkings({ project, instance: i, position: pos = i.transform.position }: { project: Project; instance: Instance; position?: Point }) {
  const layout = markingLayout(project, { ...i, transform: { ...i.transform, position: pos } });
  return <g className="symbol-markings" textAnchor="middle">{i.markings.showDeviceName && <text data-marking="name" x={pos.x} y={layout.nameY}>{presentationText(layout.name)}</text>}{i.markings.showLabel && <text data-marking="label" x={pos.x} y={layout.labelY}>{presentationText(i.label)}</text>}</g>;
}
type Wrapper<T> = (item: T, drawing: ReactNode) => ReactNode;
/** Pure DESIGN projection. Canvas supplies trusted interaction wrappers; exports supply none. */
export interface SceneInteraction {
  symbol?: Wrapper<Instance>;
  wire?: Wrapper<Sheet['wires'][number]>;
  junction?: Wrapper<Sheet['junctions'][number]>;
  annotation?: Wrapper<Sheet['annotations'][number]>;
  port?: (instance: Instance, portId: string, drawing: ReactNode) => ReactNode;
}
export function DesignScene({ project, interaction = {}, positions = {} }: { project: Project; interaction?: SceneInteraction; positions?: Readonly<Record<string, Point>> }) {
  const s = project.sheets[0]!;
  return <g color="#182632" fill="currentColor" fontFamily="sans-serif" fontSize="14">
    {[...s.wires].sort((a, b) => a.id.localeCompare(b.id)).map(w => { const drawing = <><polyline points={wirePoints(s, w)?.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="3"/>{[w.from, w.to].map((e, n) => e.kind === 'dangling' && <rect key={n} x={e.position.x - 4} y={e.position.y - 4} width="8" height="8" fill="white" stroke="currentColor"/>)}</>; return <g key={w.id}>{interaction.wire ? interaction.wire(w, drawing) : drawing}</g>; })}
    {[...s.instances].sort((a, b) => a.id.localeCompare(b.id)).map(original => {
      const position = previewPosition(positions, original.id);
      const i = position ? { ...original, transform: { ...original.transform, position } } : original;
      const body = <Glyph instance={i}/>;
      return <g key={i.id}><g transform={`translate(${i.transform.position.x} ${i.transform.position.y}) rotate(${i.transform.rotation}) scale(${i.transform.mirrorX ? -1 : 1} 1)`}>{interaction.symbol ? interaction.symbol(original, body) : body}</g><DesignMarkings project={project} instance={i}/>{getDefinition(i.definition.id)!.ports.map(p => {
        const a = portPosition(i, p.id)!;
        const drawing = <><circle data-port={interaction.port ? `${i.id}/${p.id}` : undefined} cx={a.x} cy={a.y} r="6" fill="white" stroke="currentColor" strokeWidth="2"/>{i.markings.showTerminals && <text x={a.x + (a.x < i.transform.position.x ? -10 : 10)} y={a.y - 10} textAnchor={a.x < i.transform.position.x ? 'end' : 'start'} fontSize="12">{presentationText(Object.hasOwn(i.markings.terminalLabels, p.id) ? i.markings.terminalLabels[p.id]! : p.defaultMarking)}</text>}</>;
        return <g key={p.id}>{interaction.port ? interaction.port(original, p.id, drawing) : drawing}</g>;
      })}</g>;
    })}
    {[...s.junctions].sort((a, b) => a.id.localeCompare(b.id)).map(j => { const drawing = <circle cx={j.position.x} cy={j.position.y} r="6"/>; return <g key={j.id}>{interaction.junction ? interaction.junction(j, drawing) : drawing}</g>; })}
    {[...s.annotations].sort((a, b) => a.id.localeCompare(b.id)).map(a => { const drawing = <text x={a.position.x} y={a.position.y}>{presentationText(a.text)}</text>; return <g key={a.id}>{interaction.annotation ? interaction.annotation(a, drawing) : drawing}</g>; })}
  </g>;
}
function DesignSvg({ project }: { project: Project }) { const p = project.sheets[0]!.page; return <svg xmlns="http://www.w3.org/2000/svg" width={p.width} height={p.height} viewBox={`0 0 ${p.width} ${p.height}`} overflow="hidden" role="img" aria-label="Design only circuit"><title>{`${presentationText(project.title)} — design only, page clipped, not physical scale`}</title><rect width="100%" height="100%" fill="white"/><DesignScene project={project}/></svg>; }
export function exportSvg(project: Project) { return '<?xml version="1.0" encoding="UTF-8"?>\n' + renderToStaticMarkup(<DesignSvg project={project}/>); }
export function PrintDesign({ project, visible }: { project: Project; visible: boolean }) { return <section className={`print-design ${visible ? 'preview' : ''}`}><h2>Design only — page clipped; not certified physical scale</h2><DesignSvg project={project}/></section>; }
