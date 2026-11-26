import { decodeProject } from '../../../core/persistence';
import type { Project } from '../../../core/domain/types';
import { canonical } from '../files';
export const RECOVERY_KEY = 'independent-circuit:recovery:v1';
export interface RecoveryStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
/** Single bounded DESIGN record. Synchronous store commits cannot complete out of order. */
export class RecoveryStore {
  constructor(private storage: RecoveryStorage) {}
  read(): Project | null {
    const text = this.storage.getItem(RECOVERY_KEY); if (text === null) return null;
    const result = decodeProject(text); if (!result.ok) throw new Error('Recovery is corrupt, future or oversized; discard explicitly to continue recovery.');
    return result.value;
  }
  write(project: Project) { this.storage.setItem(RECOVERY_KEY, canonical(project)); }
  clearMatching(project: Project) { if (this.storage.getItem(RECOVERY_KEY) === canonical(project)) this.discard(); }
  discard() { this.storage.removeItem(RECOVERY_KEY); }
}
