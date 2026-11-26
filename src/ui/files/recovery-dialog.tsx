import { useEffect, useId, useRef } from 'react';
import type { Project } from '../../core/domain/types';

/** The decision stays on the native top layer, never in the project-bar flex layout. */
export function RecoveryDialog({ project, busy, error, restore, discard }: {
  project: Project | 'corrupt'; busy: boolean; error: string;
  restore(): void; discard(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const title = useId(), description = useId();
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    // Initial focus is informative, not a preselected destructive action.
    heading.current?.focus();
    return () => { if (element.open) element.close(); };
  }, []);
  return <dialog ref={dialog} className="recovery-dialog" aria-labelledby={title} aria-describedby={description} aria-modal="true"
    onCancel={event => event.preventDefault()}
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = buttons.findIndex(button => button === document.activeElement);
      if (!buttons.length) { event.preventDefault(); heading.current?.focus(); }
      else if (event.shiftKey && index <= 0) { event.preventDefault(); buttons.at(-1)!.focus(); }
      else if (!event.shiftKey && (index < 0 || index === buttons.length - 1)) { event.preventDefault(); buttons[0]!.focus(); }
    }}>
    <p className="recovery-eyebrow">LOCAL DESIGN RECOVERY</p>
    <h2 id={title} ref={heading} tabIndex={-1}>{project === 'corrupt' ? 'Recovery cannot be opened' : 'Recover your unsaved design'}</h2>
    <div id={description}>
      {project === 'corrupt' ? <p>The recovery record is invalid, from a newer format, or too large. Restore is unavailable. Its stored bytes are preserved unless you explicitly discard it.</p> : <>
        <p>A recoverable design was found on this browser. Choose whether to restore it or discard this local recovery before editing.</p>
        <dl className="recovery-summary"><div><dt>Design</dt><dd>{project.title}</dd></div><div><dt>Revision</dt><dd>{project.revision}</dd></div><div><dt>Symbols</dt><dd>{project.sheets.reduce((count, sheet) => count + sheet.instances.length, 0)}</dd></div></dl>
      </>}
      <p className="recovery-note">Recovery is not a confirmed saved file. Restoring recovers only the applied design, not undo history, a file association or a running simulation.</p>
    </div>
    {error && <p role="alert" className="recovery-error">{error}</p>}
    {busy && <p role="status">Restoring recovery…</p>}
    <div className="recovery-actions"><button type="button" className="primary" disabled={project === 'corrupt' || busy} onClick={restore}>Restore recovery</button><button type="button" disabled={busy} onClick={discard}>Discard recovery</button></div>
    <p className="recovery-choice-note">Nothing is restored or discarded until you choose. Escape and clicking outside keep this decision open.</p>
  </dialog>;
}
