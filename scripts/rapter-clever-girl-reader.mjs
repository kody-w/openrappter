const SUPPORTED_REPORTS = Object.freeze({
  'rapter-clever-girl.observe.v2': '2',
  'rapter-clever-girl.observe.v3': '3',
});

export class ObserveReportReaderError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ObserveReportReaderError';
    this.code = code;
  }
}

function parseInput(value) {
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    try {
      return JSON.parse(String(value));
    } catch {
      throw new ObserveReportReaderError('OBSERVE_REPORT_INVALID_JSON');
    }
  }
  return value;
}

/**
 * Read v2 or v3 without upgrading, downgrading, or mutating either contract.
 */
export function readObserveReport(value) {
  const report = parseInput(value);
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new ObserveReportReaderError('OBSERVE_REPORT_INVALID');
  }
  const version = SUPPORTED_REPORTS[report.schemaVersion];
  if (version === undefined) {
    throw new ObserveReportReaderError('OBSERVE_REPORT_VERSION_UNSUPPORTED');
  }
  if (
    report.mode !== 'observe' ||
    !['ok', 'partial', 'failed'].includes(report.status) ||
    !Array.isArray(report.sources) ||
    !Array.isArray(report.candidates) ||
    report.replay?.analyzerVersion !== version ||
    !/^sha256:[a-f0-9]{64}$/.test(report.replay?.analysisFingerprint ?? '')
  ) {
    throw new ObserveReportReaderError('OBSERVE_REPORT_INVALID');
  }
  if (version === '3' && report.detector?.unassignedRepairOccurrences !== 0) {
    throw new ObserveReportReaderError('OBSERVE_REPORT_V3_ASSIGNMENT_GAP');
  }
  return { version, report };
}

export function supportedObserveReportVersions() {
  return Object.keys(SUPPORTED_REPORTS);
}
