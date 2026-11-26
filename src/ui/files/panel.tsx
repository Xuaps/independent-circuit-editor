import { RecoveryDialog } from './recovery-dialog';
import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../core/domain/types';
import type { EditorClient, FileTransaction } from '../editor/application';
import { browserFiles, canonical, readFile, safeName, writeConfirmed, type WriteHandle } from '../../hosts/browser/files';
import { RECOVERY_KEY, RecoveryStore } from '../../hosts/browser/recovery';
import { exportSvg, PrintDesign } from '../export/design';
import { download } from '../../hosts/browser/files';

export function FilePanel({ client, lock, replaced }: { client: EditorClient; lock(value: boolean): void; replaced(): void }) {
  const [adapter] = useState(browserFiles), [busy, setBusy] = useState(false), [message, setMessage] = useState('Never confirmed saved. Only APPLIED form changes are saved.'), [pending, setPending] = useState<Project | 'corrupt' | null>(null), [offline, setOffline] = useState('Offline cache not ready');
  const [recoveryError, setRecoveryError] = useState('');
  const resolving = useRef(false), hadPending = useRef(false), newButton = useRef<HTMLButtonElement>(null);
  const state = useRef({ confirmed: false, handle: null as WriteHandle | null, generation: 0, paused: true, last: '', timer: 0, recovery: null as RecoveryStore | null, foreign: false });
  const input = useRef<HTMLInputElement>(null);
  const [print, setPrint] = useState(false);
  const { mode, dirty } = client.getSnapshot(), running = mode !== 'Editing';
  const saveStatus = busy ? 'File action in progress' : dirty ? 'Unsaved changes' : state.current.confirmed ? 'Confirmed saved' : 'Not confirmed saved';
  useEffect(() => {
    if (pending) hadPending.current = true;
    else if (hadPending.current && !busy) { hadPending.current = false; newButton.current?.focus(); }
  }, [pending, busy]);
  useEffect(() => {
    const s = state.current;
    try { s.recovery = new RecoveryStore(window.localStorage); const record = s.recovery.read(); setPending(record); s.paused = !!record; lock(!!record); }
    catch (e) { setMessage(`Recovery unavailable: ${String(e)}`); if (String(e).includes('Recovery is corrupt')) { setPending('corrupt'); lock(true); } else { s.paused = false; lock(false); } }
    let lastObservedDesign = client.getSnapshot().design;
    const schedule = () => {
      const view = client.getSnapshot();
      // Runtime publications reuse the immutable design and must not move its recovery deadline.
      if (view.design === lastObservedDesign) return;
      lastObservedDesign = view.design;
      clearTimeout(s.timer);
      if (s.paused || s.foreign) return;
      const text = canonical(view.design);
      if (text === s.last) return;
      const generation = s.generation;
      s.timer = window.setTimeout(() => {
        if (generation !== s.generation || s.paused || s.foreign) return;
        try { s.recovery?.write(view.design); if (!view.dirty && s.confirmed) s.recovery?.clearMatching(view.design); s.last = text; }
        catch (e) { setMessage(`Recovery unavailable: ${String(e)}. Editing and Download copy remain available.`); }
      }, 300);
    };
    const unsubscribe = client.subscribe(schedule);
    const unload = (event: BeforeUnloadEvent) => { if (client.getSnapshot().dirty || !s.confirmed) { event.preventDefault(); event.returnValue = ''; } };
    const foreign = (event: StorageEvent) => { if (event.key === RECOVERY_KEY) { s.foreign = true; clearTimeout(s.timer); setMessage('Another tab changed recovery. This tab will not write/clear recovery; use explicit Save or Download copy.'); setRecoveryError('Another tab changed recovery. This tab will not change that record. Reload to review the latest recovery before choosing.'); } };
    window.addEventListener('beforeunload', unload); window.addEventListener('storage', foreign);
    return () => { clearTimeout(s.timer); unsubscribe(); window.removeEventListener('beforeunload', unload); window.removeEventListener('storage', foreign); };
  }, [client, lock]);
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    let alive = true;
    navigator.serviceWorker.register('/service-worker.js').then(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
      if (alive) setOffline('Offline ready — cached production assets; updates activate after all tabs close');
    }).catch(e => { if (alive) setOffline(`Offline cache unavailable: ${String(e)}`); });
    return () => { alive = false; };
  }, []);
  async function transaction(action: (port: FileTransaction) => Promise<void>) {
    if (busy) return;
    setBusy(true); lock(true); const s = state.current; clearTimeout(s.timer); s.paused = true;
    try { await client.fileTransaction(action); }
    catch (e) { setMessage(`File action canceled or failed: ${String(e)}. Current design preserved unless a replacement was explicitly completed.`); }
    finally { s.paused = false; setBusy(false); lock(false);
      // Capture the final design only; no old deferred timer may overwrite a replacement.
      try { const v = client.getSnapshot(); if (!s.foreign && (v.dirty || !s.confirmed)) { s.recovery?.write(v.design); s.last = canonical(v.design); } } catch (e) { setMessage(`Recovery unavailable: ${String(e)}`); }
    }
  }
  async function save(port: FileTransaction): Promise<boolean> {
    const s = state.current, project = port.design(), text = canonical(project);
    if (!adapter.pickSave) { adapter.download(text, safeName(project.title)); setMessage('Download copy requested — NOT confirmed saved. Dirty/recovery retained. Only applied form changes included.'); return false; }
    const handle = s.handle ?? await adapter.pickSave();
    try { if (!s.foreign) s.recovery?.write(project); } catch { /* Explicit save remains usable if recovery is unavailable. */ }
    await writeConfirmed(handle, text); // Close is the sole confirmation point, while authoring is locked.
    s.handle = handle; s.confirmed = true; port.confirmSaved();
    let recoveryWarning = '';
    try { if (!s.foreign) s.recovery?.clearMatching(project); } catch (e) { recoveryWarning = ` Recovery cleanup unavailable: ${String(e)}`; }
    setMessage(`Last successful native save: ${handle.name}. Only APPLIED form changes included.${recoveryWarning}`); return true;
  }
  async function guard(port: FileTransaction) {
    if (!client.getSnapshot().dirty && state.current.confirmed) return true;
    const choice = window.prompt('Unsaved or unconfirmed work. Type Save, Discard, or Cancel. Only APPLIED form changes are saved.', 'Cancel')?.toLowerCase();
    if (choice === 'discard') return true;
    if (choice === 'save') return save(port);
    setMessage('Switch canceled; drawing and history preserved.'); return false;
  }
  function replace(port: FileTransaction, project?: Project, recovered = false) {
    const s = state.current;
    // A successful Discard/validated replacement may discard only this app-owned record.
    port.replace(project); // Validate/install before touching any host association or recovery.
    let recoveryWarning = '';
    if (!s.foreign && !recovered) { try { s.recovery?.discard(); } catch (e) { recoveryWarning = ` Old recovery could not be removed: ${String(e)}`; } }
    s.generation++; s.handle = null; s.confirmed = false; s.last = ''; replaced();
    setMessage((recovered ? 'Recovered design — unconfirmed. Undo history and file association were not recovered.' : 'Design opened — unconfirmed. No overwrite handle associated. Only applied changes are saved.') + recoveryWarning);
  }
  async function restoreRecovery() {
    if (!pending || pending === 'corrupt' || resolving.current) return;
    const s = state.current;
    if (s.foreign) { setRecoveryError('Another tab changed recovery. Reload to review the latest recovery before choosing.'); return; }
    resolving.current = true; setBusy(true); setRecoveryError(''); clearTimeout(s.timer);
    // Unlike an ordinary file action, failure must keep both the pending decision and
    // its bytes. In particular, never run transaction()'s blank-design recovery write.
    try {
      await client.fileTransaction(async port => replace(port, pending, true));
      s.last = canonical(client.getSnapshot().design);
      s.paused = false; setPending(null); lock(false);
    } catch (error) {
      const detail = `Recovery restore failed: ${String(error)}. The recovery record is preserved; try again or explicitly discard it.`;
      setRecoveryError(detail); setMessage(detail);
    } finally { resolving.current = false; setBusy(false); }
  }
  function discardRecovery() {
    if (resolving.current) return;
    const s = state.current;
    if (s.foreign) { setRecoveryError('Another tab changed recovery. Reload to review the latest recovery before choosing.'); return; }
    try {
      if (!s.recovery) throw new Error('Recovery storage unavailable');
      s.recovery.discard(); // ONLY this app's recovery key; an exception keeps the decision locked.
      s.last = canonical(client.getSnapshot().design); s.paused = false;
      setPending(null); setRecoveryError(''); lock(false); setMessage('Recovery discarded. Blank design remains unconfirmed.');
    } catch (error) {
      const detail = `Recovery discard failed: ${String(error)}. The recovery record is preserved; try again.`;
      setRecoveryError(detail); setMessage(detail);
    }
  }
  async function open(file: File) { await transaction(async port => { const candidate = await readFile(file); if (await guard(port)) replace(port, candidate); }); }
  return <section className="file-panel" aria-label="Files and recovery">
    {pending && <RecoveryDialog project={pending} busy={busy} error={recoveryError} restore={() => void restoreRecovery()} discard={discardRecovery}/>}
    <fieldset className="file-commands" disabled={busy || !!pending}><legend>Design files {busy ? '— Busy: authoring locked' : ''}</legend>
      <button ref={newButton} disabled={running} onClick={() => void transaction(async port => { if (await guard(port)) replace(port); })}>New</button>
      <button disabled={running} onClick={() => { if (adapter.pickOpen) void transaction(async port => { const handle = await adapter.pickOpen!(); const candidate = await readFile(await handle.getFile()); if (await guard(port)) { replace(port, candidate); state.current.handle = handle; setMessage(`Opened ${handle.name} — only applied design included; native handle associated.`); } }); else input.current?.click(); }}>Open</button><input className="file-input" ref={input} aria-label="Open circuit file" type="file" disabled={running} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void open(file); }}/>
      <button onClick={() => void transaction(async port => { await save(port); })}>{adapter.pickSave ? 'Save' : 'Download copy'}</button>
      <details name="command-menu" className="file-menu" onClick={event => { if ((event.target as HTMLElement).closest('button')) event.currentTarget.open = false; }}><summary>More files</summary><div className="file-menu-content"><button disabled={running} onClick={() => void transaction(async port => { const response = await fetch('/selfhold.circuit.json'); if (!response.ok) throw new Error('Example unavailable'); const file = new File([await response.blob()], 'selfhold.circuit.json'); const p = await readFile(file); if (await guard(port)) replace(port, p); })}>Load example</button>
      <button onClick={() => download(exportSvg(client.getSnapshot().design), safeName(client.getSnapshot().design.title, '.svg'), 'image/svg+xml')}>Export design SVG</button>
      <button onClick={() => setPrint(!print)}>Design print preview</button>{print && <button onClick={() => window.print()}>Print design</button>}
      </div></details>
    </fieldset>
    <details name="command-menu" className="file-feedback"><summary>{saveStatus}{message.includes('failed') || message.includes('unavailable') || message.includes('Another tab') ? ' · Check file status' : ''}</summary><div><p aria-live="polite" data-testid="file-status">{message}</p><p>{offline}</p><p>Only APPLIED forms are saved. Download is not confirmation. Design export/print clips to page; off-page data remains in project. Not certified physical scale. No user data uploaded.</p></div></details>
    <PrintDesign project={client.getSnapshot().design} visible={print}/>
  </section>;
}
