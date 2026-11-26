import { useEffect, useRef, type DOMAttributes } from 'react';
import type { EditorClient, EditorView } from '../editor/application';

/** One ownership table for canvas and panel; releases only when the last physical owner lets go. */
export function useActuation(client: EditorClient, view: EditorView) {
  const owners = useRef(new Map<string, Set<string>>());
  const enabled = view.mode === 'Running' || view.mode === 'Paused';
  function action(id: string, token: string, down: boolean) {
    if (down && !enabled) return;
    const set = owners.current.get(id) ?? new Set<string>(), was = set.size > 0;
    down ? set.add(token) : set.delete(token);
    if (set.size) owners.current.set(id, set); else owners.current.delete(id);
    if (was !== (set.size > 0)) client.control({ kind: 'input', instanceId: id, action: set.size ? 'press' : 'release' });
  }
  function release() { owners.current.clear(); client.control({ kind: 'release' }); }
  useEffect(() => {
    const visibility = () => { if (document.hidden) release(); };
    window.addEventListener('blur', release); document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', visibility); release(); };
  }, [client]);
  useEffect(() => { owners.current.clear(); }, [view.mode === 'Editing']);
  function bind<T extends Element>(id: string, surface: string): DOMAttributes<T> {
    const token = (input: string) => `${surface}:${input}`;
    const clear = () => { for (const t of [...(owners.current.get(id) ?? [])]) if (t.startsWith(`${surface}:`)) action(id, t, false); };
    return {
      onPointerDown: e => { if (!enabled || e.button !== 0) return; e.preventDefault(); e.stopPropagation(); (e.currentTarget as unknown as HTMLElement).focus(); e.currentTarget.setPointerCapture(e.pointerId); action(id, token(`pointer${e.pointerId}`), true); },
      onPointerUp: e => { e.stopPropagation(); action(id, token(`pointer${e.pointerId}`), false); },
      onPointerCancel: clear, onLostPointerCapture: clear, onBlur: clear,
      onKeyDown: e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); clear(); return; } if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) action(id, token(e.key), true); } },
      onKeyUp: e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); action(id, token(e.key), false); } },
      onClick: e => e.preventDefault()
    };
  }
  return { bind, release };
}
export type Actuation = ReturnType<typeof useActuation>;
