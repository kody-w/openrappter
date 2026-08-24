import type {
  EggDiff,
  EggInspection,
  ExportEggOptions,
  ImportEggOptions,
  OrganismEggManifest,
} from './types.js';
import { OrganismEggService } from './service.js';

export interface XPeditionEggSurface {
  readonly capabilities: {
    inspect: true;
    exportPortable: true;
    exportSealed: true;
    previewImport: true;
    applyImport: true;
    semanticControlMayApplySealed: false;
  };
  inspect(file: string, passphrase?: string): EggInspection;
  export(options: ExportEggOptions): Promise<{
    output: string;
    digest: string;
    manifest: OrganismEggManifest;
    permissions: '0600' | 'platform-best-effort';
  }>;
  preview(
    file: string,
    options: Pick<ImportEggOptions, 'passphrase' | 'semantics'>,
  ): Promise<EggDiff>;
  apply(options: ImportEggOptions, actor: 'human' | 'semantic-control'): Promise<{
    preview: EggDiff;
    applied: boolean;
    rollbackEgg?: string;
    health?: string;
  }>;
}

export class XPeditionEggAdapter implements XPeditionEggSurface {
  readonly capabilities = {
    inspect: true,
    exportPortable: true,
    exportSealed: true,
    previewImport: true,
    applyImport: true,
    semanticControlMayApplySealed: false,
  } as const;

  constructor(private readonly service = new OrganismEggService()) {}

  inspect(file: string, passphrase?: string): EggInspection {
    return this.service.inspect(file, passphrase);
  }

  export(options: ExportEggOptions): Promise<{
    output: string;
    digest: string;
    manifest: OrganismEggManifest;
    permissions: '0600' | 'platform-best-effort';
  }> {
    return this.service.export(options);
  }

  preview(
    file: string,
    options: Pick<ImportEggOptions, 'passphrase' | 'semantics'>,
  ): Promise<EggDiff> {
    return this.service.diff(file, options);
  }

  async apply(
    options: ImportEggOptions,
    actor: 'human' | 'semantic-control',
  ): Promise<{
    preview: EggDiff;
    applied: boolean;
    rollbackEgg?: string;
    health?: string;
  }> {
    if (actor !== 'human') {
      throw new Error('Semantic controls may inspect/export fixtures but cannot approve or apply imports');
    }
    return this.service.import({ ...options, apply: true });
  }
}
