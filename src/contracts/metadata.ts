import metadata from '../../design/contracts/v1/core.dc.profile.json';
import { validateShape } from './validation';
type DeepReadonly<T> = T extends object ? { readonly [P in keyof T]: DeepReadonly<T[P]> } : T;
export type LimitedMetadataProfile = DeepReadonly<typeof metadata>;
function freeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) if (child !== null && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}
const result = validateShape('profile', metadata);
if (!result.valid) throw new Error(`Invalid built-in metadata: ${JSON.stringify(result.errors)}`);
/** Immutable design metadata; does not assert implemented behaviors or literal union types. */
export const limitedMetadata: LimitedMetadataProfile = freeze(structuredClone(metadata));
