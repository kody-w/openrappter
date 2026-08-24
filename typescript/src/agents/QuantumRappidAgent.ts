import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';
import {
  completeRappid,
  inspectOrganism,
  listOrganismSummaries,
  playbackManifest,
  proposeGrowth,
  verifyRappid,
} from '../rappids/index.js';
import type { QuantumRappidSummary } from '../rappids/index.js';

export const __manifest__ = {
  schema: 'rapp-agent/1.0',
  name: '@openrappter/quantum-rappid',
  version: '1.0.0',
  display_name: 'Quantum RAPPID',
  description:
    'Inspects and verifies local Quantum RAPPIDs and proposes non-authoritative append-only growth.',
  author: 'Kody Wildfeuer',
  ring: 'ga',
  capabilities: [],
  tags: ['openrappter', 'rappid', 'local-first', 'organism'],
  category: 'memory',
  quality_tier: 'official',
  requires_env: [],
} as const;

function modelSafeSummary(
  summary: QuantumRappidSummary,
): Omit<QuantumRappidSummary, 'externalEpisode'> {
  const safe = { ...summary } as Partial<QuantumRappidSummary>;
  delete safe.externalEpisode;
  return safe as Omit<QuantumRappidSummary, 'externalEpisode'>;
}

export class QuantumRappidAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'QuantumRappid',
      description:
        'Inspects, verifies, and proposes append-only growth for local Quantum RAPPIDs. It never appends growth; the authenticated Habitat approval seam owns mutation.',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: [
              'list',
              'inspect',
              'verify',
              'complete',
              'propose',
              'playback-manifest',
            ],
            description: 'Read or proposal operation.',
          },
          rappid: {
            type: 'string',
            description: 'Canonical rappid:@owner/slug:<64hex> identity.',
          },
          dimension: {
            type: 'string',
            enum: ['sonic', 'stats'],
            description: 'Dimension to autocomplete as a non-authoritative proposal.',
          },
        },
        required: ['operation'],
      },
    };
    super('QuantumRappid', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const operation = String(kwargs.operation ?? '');
    const rappid = typeof kwargs.rappid === 'string' ? kwargs.rappid : '';
    if (operation === 'list') {
      return JSON.stringify({
        status: 'success',
        operation,
        organisms: listOrganismSummaries().map(modelSafeSummary),
      });
    }
    if (!rappid) {
      return JSON.stringify({
        status: 'error',
        operation,
        message: 'rappid is required',
      });
    }
    try {
      let result: unknown;
      switch (operation) {
        case 'inspect': {
          const inspection = inspectOrganism(rappid);
          const safe: Record<string, unknown> = {
            ...inspection,
            summary: modelSafeSummary(inspection.summary),
          };
          delete safe.directory;
          result = safe;
          break;
        }
        case 'verify':
          result = verifyRappid(rappid);
          break;
        case 'complete':
          result = completeRappid(rappid);
          break;
        case 'propose':
          result = proposeGrowth(
            rappid,
            typeof kwargs.dimension === 'string' ? kwargs.dimension : 'stats',
          );
          break;
        case 'playback-manifest':
          result = playbackManifest(rappid);
          break;
        default:
          return JSON.stringify({
            status: 'error',
            operation,
            message:
              'Unknown or mutating operation. Growth requires the authenticated Habitat approval flow.',
          });
      }
      return JSON.stringify({
        status: 'success',
        operation,
        result,
        data_slush: {
          source_agent: this.name,
          rappid,
          mutation: false,
        },
      });
    } catch (error) {
      return JSON.stringify({
        status: 'error',
        operation,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
