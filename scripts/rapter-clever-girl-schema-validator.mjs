import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function loadValidatorDependency(specifier) {
  const requireHere = createRequire(import.meta.url);
  try {
    return requireHere(specifier);
  } catch (error) {
    let cursor = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 6; depth += 1) {
      const packageJson = join(cursor, 'typescript', 'package.json');
      if (existsSync(packageJson)) {
        return createRequire(pathToFileURL(packageJson))(specifier);
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    throw error;
  }
}

const Ajv2020 = loadValidatorDependency('ajv/dist/2020.js').default;
const addFormats = loadValidatorDependency('ajv-formats').default;
const SCHEMA_FILES = Object.freeze({
  capability: 'rapter-clever-girl-capability-catalog-v2.json',
  observeV2: 'rapter-clever-girl-observe-v2.json',
  observeV3: 'rapter-clever-girl-observe-v3.json',
  repairSidecar: 'rapter-clever-girl-repair-assignments-v1.json',
});

function loadSchema(fileName) {
  let firstError;
  for (const relativePath of [`./${fileName}`, `../contracts/${fileName}`]) {
    try {
      return JSON.parse(
        readFileSync(new URL(relativePath, import.meta.url), 'utf8'),
      );
    } catch (error) {
      firstError ??= error;
    }
  }
  throw firstError;
}

const validator = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: true,
});
addFormats(validator);
validator.addKeyword({
  keyword: 'x-openrappter-contract',
  schemaType: 'object',
  valid: true,
});

const observeValidators = new Map();
let repairSidecarValidator;
let behavioralContractValidator;

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalSchemaDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function validateBehavioralContractShape(value) {
  if (behavioralContractValidator === undefined) {
    const schema = loadSchema(SCHEMA_FILES.capability);
    validator.addSchema(schema);
    behavioralContractValidator = validator.compile({
      $ref: `${schema.$id}#/$defs/behavioralContract`,
    });
  }
  return behavioralContractValidator(value) === true;
}

export function validateObserveReportShape(schemaVersion, value) {
  let reportValidator = observeValidators.get(schemaVersion);
  if (reportValidator === undefined) {
    if (schemaVersion === 'rapter-clever-girl.observe.v2') {
      const schema = loadSchema(SCHEMA_FILES.observeV2);
      validator.addSchema(schema);
      reportValidator = validator.getSchema(schema.$id);
    } else if (schemaVersion === 'rapter-clever-girl.observe.v3') {
      validateObserveReportShape('rapter-clever-girl.observe.v2', {});
      const schema = loadSchema(SCHEMA_FILES.observeV3);
      validator.addSchema(schema);
      reportValidator = validator.getSchema(schema.$id);
    } else {
      return false;
    }
    observeValidators.set(schemaVersion, reportValidator);
  }
  return reportValidator !== undefined && reportValidator(value) === true;
}

export function validateRepairSidecarShape(value) {
  if (repairSidecarValidator === undefined) {
    const schema = loadSchema(SCHEMA_FILES.repairSidecar);
    validator.addSchema(schema);
    repairSidecarValidator = validator.getSchema(schema.$id);
  }
  return repairSidecarValidator(value) === true;
}
