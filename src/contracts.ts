export const VERSION = '0.1.0';
export const hex = (value: number, width = 4): string =>
  value.toString(16).toUpperCase().padStart(width, '0');

/** One observed decode, separate from a complete bank/epoch provenance trace. */
export interface SourceObservation {
  sourceFile?: string;
  address: number;
  opcode: number;
  bytes: readonly number[];
  assembly: string;
  firstInstruction: number;
  visits: number;
  provenance?: Record<string, unknown>;
}

export class Diagnostic extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'Diagnostic';
  }
}

export interface SourceSpan {
  mediaHash: string;
  fileId: string;
  fileOffset: number;
  mediaOffset: number;
  length: number;
  track: number;
  sector: number;
}
export interface MediaEntry {
  id: string;
  name: string;
  type: 'DEL' | 'SEQ' | 'PRG' | 'USR' | 'REL';
  closed: boolean;
  locked: boolean;
  blocks: number;
  start: { track: number; sector: number };
  directoryOffset: number;
}
export interface ExtractedFile {
  bytes: Uint8Array;
  spans: SourceSpan[];
}
export interface MediaReader<Image = MediaImage> {
  readonly format: string;
  readonly version: string;
  probe(bytes: Uint8Array): { confidence: number; evidence: string[] } | undefined;
  open(bytes: Uint8Array): Image;
}
export interface MediaImage {
  readonly hash: string;
  readonly name: string;
  readonly entries: MediaEntry[];
  extract(entry: MediaEntry): ExtractedFile;
}
export interface WebProfile {
  id: string;
  width: number;
  height: number;
  aspectRatio: string;
  joystickPorts: number[];
  defaultJoystickPort: number;
  keyboard: Record<string, string>;
  diskSwitching: boolean;
  serializable: boolean;
}
export interface TimingProfile {
  id: string;
  cyclesPerLine: number;
  linesPerFrame: number;
  clockHz: number;
}
export interface SystemAdapter {
  id: string;
  version: string;
  cpu: string;
  formats: string[];
  timing: TimingProfile;
  web: WebProfile;
  firmware: string[];
  capabilities: string[];
}
export class AdapterRegistry {
  private readonly systems = new Map<string, SystemAdapter>();
  register(adapter: SystemAdapter): void {
    if (this.systems.has(adapter.id)) {
      throw new Diagnostic('DUPLICATE_ADAPTER', `Adapter already registered: ${adapter.id}`);
    }
    this.systems.set(adapter.id, adapter);
  }
  get(id: string): SystemAdapter {
    const adapter = this.systems.get(id);
    if (!adapter) {
      throw new Diagnostic(
        'MISSING_ADAPTER',
        `System '${id}' has no adapter. Available: ${[...this.systems.keys()].join(', ')}`,
      );
    }
    return adapter;
  }
}
