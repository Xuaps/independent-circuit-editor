/** Own-format DTOs. Readonly is complemented by isolated, recursively frozen snapshots. */
export type Empty = Readonly<Record<string, never>>;
export type Scalar = string | number | boolean | null;
export type Point = Readonly<{ x: number; y: number }>;
export type Transform = Readonly<{ position: Point; rotation: 0 | 90 | 180 | 270; mirrorX: boolean }>;
export type DeviceKind = 'dcSupply' | 'pushButton' | 'relay' | 'lamp';
export type LampColor = 'amber' | 'green' | 'red' | 'blue' | 'white';
type DeviceBase = { readonly id: string; readonly name: string; readonly initial: Empty };
export type Device = DeviceBase & (
  | { readonly kind: 'dcSupply'; readonly parameters: Readonly<{ nominalVoltageV: 24 }> }
  | { readonly kind: 'pushButton' | 'relay'; readonly parameters: Empty }
  | { readonly kind: 'lamp'; readonly parameters: Readonly<{ color: LampColor }> });
export type Markings = Readonly<{ showDeviceName: boolean; showLabel: boolean; showTerminals: boolean; terminalLabels: Readonly<Record<string, string>> }>;
export type Instance = Readonly<{ id: string; definition: Readonly<{ id: string; version: 1 }>; variant: 'default'; deviceId: string | null; parameters: Empty; transform: Transform; label: string; markings: Markings }>;
export type Junction = Readonly<{ id: string; position: Point }>;
export type Endpoint = Readonly<{ kind: 'port'; instanceId: string; portId: string }> | Readonly<{ kind: 'junction'; junctionId: string }> | Readonly<{ kind: 'dangling'; position: Point }>;
export type Wire = Readonly<{ id: string; from: Endpoint; to: Endpoint; waypoints: readonly Point[] }>;
export type Annotation = Readonly<{ id: string; position: Point; text: string }>;
export type Page = Readonly<{ width: number; height: number; unit: 'du' }>;
export type Sheet = Readonly<{ id: string; name: string; page: Page; instances: readonly Instance[]; junctions: readonly Junction[]; wires: readonly Wire[]; annotations: readonly Annotation[] }>;
export type ModelSet = Readonly<{ id: 'core.dc'; version: 1 }>;
export type Project = Readonly<{ format: 'circuit-project'; formatVersion: 1; projectId: string; revision: number; modelSet: ModelSet; title: string; devices: readonly Device[]; sheets: readonly Sheet[] }>;
export type Operation =
 | Readonly<{ op: 'device.create'; device: Device }>
 | Readonly<{ op: 'device.rename'; deviceId: string; name: string }>
 | Readonly<{ op: 'device.parameters.replace'; deviceId: string; parameters: Readonly<Record<string, Scalar>> }>
 | Readonly<{ op: 'device.remove'; deviceId: string }>
 | Readonly<{ op: 'instance.place'; sheetId: string; instance: Instance }>
 | Readonly<{ op: 'instance.bind'; instanceId: string; deviceId: string | null }>
 | Readonly<{ op: 'instance.transform'; instanceId: string; transform: Transform }>
 | Readonly<{ op: 'instance.presentation.replace'; instanceId: string; label: string; markings: Markings }>
 | Readonly<{ op: 'instance.remove'; instanceId: string }>
 | Readonly<{ op: 'junction.create'; sheetId: string; junction: Junction }>
 | Readonly<{ op: 'junction.remove'; junctionId: string }>
 | Readonly<{ op: 'wire.add'; sheetId: string; wire: Wire }>
 | Readonly<{ op: 'wire.replace'; wireId: string; from: Endpoint; to: Endpoint; waypoints: readonly Point[] }>
 | Readonly<{ op: 'wire.remove'; wireId: string }>
 | Readonly<{ op: 'annotation.add'; sheetId: string; annotation: Annotation }>
 | Readonly<{ op: 'annotation.remove'; annotationId: string }>
 | Readonly<{ op: 'page.replace'; sheetId: string; page: Page }>;
export type Operations = Readonly<{ format: 'circuit-operations'; formatVersion: 1; target: Readonly<{ projectId: string; expectedRevision: number }>; operations: readonly Operation[] }>;
export type ObservableValue = Readonly<{ quality: 'known'; value: Scalar }> | Readonly<{ quality: 'unknown' | 'unsupported' | 'faulted'; code: string }>;
export type ProbeTarget = Readonly<{ kind: 'device' | 'instance'; id: string }>;
export type Probe = Readonly<{ atMs: number; target: ProbeTarget; observable: string }>;
export type Scenario = Readonly<{ format: 'circuit-scenario'; formatVersion: 1; target: Readonly<{ projectId: string; revision: number; modelSet: ModelSet }>; untilMs: number; limits: Readonly<{ maxEvents: number; maxDeltaCycles: number; maxTraceEntries: number }>; inputs: readonly Readonly<{ atMs: number; sequence: number; actions: readonly Readonly<{ instanceId: string; action: string; payload: Empty }>[] }>[]; probes: readonly Probe[]; expect?: Readonly<{ outcome: Readonly<{ stage: 'run'; status: 'completed' }> | Readonly<{ stage: 'run'; status: 'faulted'; code: string }> | Readonly<{ stage: 'validation'; status: 'rejected'; code: string }>; observations: readonly (Probe & Readonly<{ expected: ObservableValue }>)[] }> }>;
/** Fixed wire diagnostic; internal locators never get smuggled into this shape. */
export type Diagnostic = Readonly<{ severity: 'error' | 'warning' | 'info'; code: string; message: string; objectIds: readonly string[]; atMs?: number; operationIndex?: number }>;
export type FailureCategory = 'malformed' | 'unsupported-shape' | 'invalid-document' | 'resource-limit';
export type Result<T> = Readonly<{ ok: true; value: T; diagnostics: readonly Diagnostic[] }> | Readonly<{ ok: false; category: FailureCategory; diagnostics: readonly Diagnostic[] }>;
export function diagnostic(code: string, objectIds: readonly string[] = [], message = code): Diagnostic {
  return Object.freeze({ severity: 'error', code, message, objectIds: Object.freeze([...objectIds]) });
}
export function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function snapshot<T>(value: T): T { return freeze(structuredClone(value)); }
