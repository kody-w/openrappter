export const COMPANY_APP_IDS = [
  'engineering',
  'release-operations',
  'customer-signals',
  'documentation',
  'expenses',
  'decisions',
  'rapp-estate-health',
] as const;

export type CompanyAppId = (typeof COMPANY_APP_IDS)[number];

export interface CompanyAppRegistration {
  id: CompanyAppId;
  title: string;
  shortTitle: string;
  description: string;
  glyph: string;
  desktop: boolean;
  dataSeams: readonly string[];
  approvalActions: readonly string[];
}

export const COMPANY_APP_REGISTRATIONS: readonly CompanyAppRegistration[] = [
  {
    id: 'engineering',
    title: 'Engineering',
    shortTitle: 'Engineering',
    description: 'Repository, pull-request, CI, and bounded work status.',
    glyph: 'ENG',
    desktop: true,
    dataSeams: ['status', 'exec.pending', 'exec.history'],
    approvalActions: ['shell.command', 'irreversible.action'],
  },
  {
    id: 'release-operations',
    title: 'Release Operations',
    shortTitle: 'Release Ops',
    description: 'Release rings, promotion receipts, and guarded promotion status.',
    glyph: 'REL',
    desktop: true,
    dataSeams: ['methods', 'exec.history', 'ReleaseRingAdapter'],
    approvalActions: ['release.apply', 'release.promote', 'external.publish'],
  },
  {
    id: 'customer-signals',
    title: 'Customer Signals',
    shortTitle: 'Signals',
    description: 'Existing channel and session evidence without invented feedback.',
    glyph: 'SIG',
    desktop: true,
    dataSeams: ['channels.list', 'chat.list'],
    approvalActions: ['external.send'],
  },
  {
    id: 'documentation',
    title: 'Documentation',
    shortTitle: 'Docs',
    description: 'Docs/blog status and copy-ready publishing health.',
    glyph: 'DOC',
    desktop: false,
    dataSeams: ['status', 'methods', 'clipboard'],
    approvalActions: ['external.publish'],
  },
  {
    id: 'expenses',
    title: 'Expenses',
    shortTitle: 'Expenses',
    description: 'Review-ready private drafts; the user always submits.',
    glyph: '$',
    desktop: false,
    dataSeams: ['LivingCompanyDraftStore'],
    approvalActions: ['expense.submit'],
  },
  {
    id: 'decisions',
    title: 'Decisions',
    shortTitle: 'Decisions',
    description: 'Decision queue and private CEO memo drafts.',
    glyph: 'DEC',
    desktop: true,
    dataSeams: ['LivingCompanyDraftStore'],
    approvalActions: ['external.send', 'external.publish'],
  },
  {
    id: 'rapp-estate-health',
    title: 'RAPP Estate Health',
    shortTitle: 'Estate',
    description: 'Authenticated audit availability, drift, and declared-core evidence.',
    glyph: 'RAPP',
    desktop: true,
    dataSeams: ['status', 'skills.list', 'ecosystem-audit adapter'],
    approvalActions: ['credential.change', 'shell.command'],
  },
] as const;

export function isCompanyAppId(value: unknown): value is CompanyAppId {
  return typeof value === 'string' &&
    (COMPANY_APP_IDS as readonly string[]).includes(value);
}

export function companyAppRegistration(
  id: CompanyAppId,
): CompanyAppRegistration {
  const registration = COMPANY_APP_REGISTRATIONS.find((app) => app.id === id);
  if (!registration) throw new Error(`Unknown Living Company app: ${id}`);
  return registration;
}
