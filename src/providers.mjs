import {
  cloneJson,
  compact,
  hashJson,
  makeId,
  nowIso,
  redact,
  truncate
} from './core.mjs';
import {
  PROVIDER_RESPONSE_ERROR_CODES,
  assertProviderResponseText
} from './providers/provider-response-normalizer.mjs';
import {
  STRUCTURED_OUTPUT_PARSE_ERROR_CODES,
  parseStructuredJsonText
} from './providers/structured-output-parser.mjs';
import { DEFAULT_RECURSION_SETTINGS } from './settings.mjs';
import {
  EDITORIAL_EFFECTIVENESS_SCHEMA,
  REDIRECT_EFFECTIVENESS_CRITERIA,
  REDIRECT_FAILURE_CATEGORIES,
  REDIRECT_PRESSURE_EFFECTS,
  REDIRECT_VERIFICATION_CHECKS
} from './editorial-transform.mjs';

const LANES = new Set(['utility', 'reasoner']);
const HOST_SOURCES = new Set(['host-current-model', 'host-connection-profile']);
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'EPIPE',
  'RECURSION_PROVIDER_TIMEOUT'
]);
export const UTILITY_ROLE_IDS = Object.freeze([
  'utilityArbiter',
  'sceneFrameCard',
  'activeCastCard',
  'characterMotivationCard',
  'dialogueRelationshipCard',
  'socialSubtextCard',
  'sceneConstraintsCard',
  'knowledgeSecretsCard',
  'clocksConsequencesCard',
  'environmentAffordancesCard',
  'possessionsItemsCard',
  'openThreadsCard',
  'fusedCardBundle',
  'rapidTurnDelta',
  'guidanceComposer',
  'cardAuthoringAssist',
  'generationReviewer',
  'editorialDiagnostician',
  'editorialTransformer',
  'editorialVerifier',
  'editorialEffectivenessJudge',
  'providerTest'
]);
export const REASONER_ROLE_IDS = Object.freeze(['reasonerComposer']);
export const PROVIDER_CONTRACT_VERSION = 4;
const ROLE_RESPONSE_SCHEMAS = Object.freeze({
  utilityArbiter: 'recursion.utilityArbiter.v1',
  sceneFrameCard: 'recursion.card.v1',
  activeCastCard: 'recursion.card.v1',
  characterMotivationCard: 'recursion.card.v1',
  dialogueRelationshipCard: 'recursion.card.v1',
  socialSubtextCard: 'recursion.card.v1',
  sceneConstraintsCard: 'recursion.card.v1',
  knowledgeSecretsCard: 'recursion.card.v1',
  clocksConsequencesCard: 'recursion.card.v1',
  environmentAffordancesCard: 'recursion.card.v1',
  possessionsItemsCard: 'recursion.card.v1',
  openThreadsCard: 'recursion.card.v1',
  fusedCardBundle: 'recursion.cardBundle.v1',
  rapidTurnDelta: 'recursion.rapidTurnDelta.v2',
  guidanceComposer: 'recursion.guidanceComposer.v1',
  cardAuthoringAssist: 'recursion.cardAuthoringAssist.v1',
  generationReviewer: 'recursion.generationReview.v1',
  editorialDiagnostician: 'recursion.editorialDiagnosis.v1',
  editorialTransformer: 'recursion.editorialPass.v1',
  editorialVerifier: 'recursion.editorialVerification.v1',
  editorialEffectivenessJudge: EDITORIAL_EFFECTIVENESS_SCHEMA,
  reasonerComposer: 'recursion.reasonerComposer.v1',
  providerTest: 'recursion.providerTest.v1'
});
export const PROVIDER_CONTRACT_HASH = hashJson({
  providerContractVersion: PROVIDER_CONTRACT_VERSION,
  utilityRoles: UTILITY_ROLE_IDS,
  reasonerRoles: REASONER_ROLE_IDS,
  responseSchemas: ROLE_RESPONSE_SCHEMAS
});
const UTILITY_ROLES = new Set(UTILITY_ROLE_IDS);
const REASONER_ROLES = new Set(REASONER_ROLE_IDS);
const SECRET_TEXT_PATTERN = /(sk-[a-z0-9_-]+|bearer\s+[a-z0-9._-]+|session-key|secret[-_\s]*value|private[-_\s]*key[-_\s]*material)/ig;
const DEFAULT_PROVIDER_TIMEOUT_MS = 120000;
const REASONING_INTENTS = new Set(['minimal', 'medium', 'high']);

function scrubSecretText(value) {
  if (typeof value === 'string') return value.replace(SECRET_TEXT_PATTERN, '[redacted]');
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => scrubSecretText(entry));
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, scrubSecretText(child)]));
}

function sanitize(value, maxString = 500) {
  return scrubSecretText(redact(value, { maxString }));
}

function cloneSafe(value, fallback = undefined) {
  try {
    const cloned = cloneJson(value);
    return cloned === undefined ? fallback : cloned;
  } catch {
    return fallback;
  }
}

function providerError(code, message, { retryable = false, status = undefined, cause = undefined, providerDiagnostics = undefined } = {}) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  if (status !== undefined) error.status = status;
  if (cause !== undefined) error.cause = cause;
  if (providerDiagnostics !== undefined) error.providerDiagnostics = providerDiagnostics;
  return error;
}

function markOpenAiAuthFailure(settingsStore, lane) {
  try {
    if (typeof settingsStore?.clearApiKey === 'function') settingsStore.clearApiKey(lane);
    if (typeof settingsStore?.updateProvider === 'function') {
      settingsStore.updateProvider(lane, {
        resolvedProviderLabel: '',
        resolvedModelLabel: '',
        lastTest: {
          status: 'fail',
          checkedAt: nowIso(),
          compactError: 'OpenAI-compatible authentication failed.'
        }
      });
    }
  } catch {
    // Provider health metadata is advisory; the provider call still fails with a stable auth error.
  }
}

function laneName(value, fallback = 'utility') {
  const lane = String(value || '').trim();
  return LANES.has(lane) ? lane : fallback;
}

function sourceName(value) {
  return String(value || 'host-current-model').trim() || 'host-current-model';
}

function normalizeReasoningIntent(value) {
  const intent = String(value || '').trim().toLowerCase();
  if (REASONING_INTENTS.has(intent)) return intent;
  if (intent === 'low') return 'minimal';
  if (intent === 'max' || intent === 'maximum' || intent === 'xhigh') return 'high';
  return '';
}

function reasoningCategoryName(value) {
  return String(value || '').trim().replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80);
}

function reasoningDiagnostics(source = {}) {
  const intent = normalizeReasoningIntent(source.reasoningIntent);
  const category = reasoningCategoryName(source.reasoningCategory);
  const dialect = String(source.reasoningDialect || '').trim();
  const output = {};
  if (intent) output.reasoningIntent = intent;
  if (category) output.reasoningCategory = category;
  if (dialect) output.reasoningDialect = dialect;
  if (Object.prototype.hasOwnProperty.call(source, 'reasoningApplied')) output.reasoningApplied = source.reasoningApplied === true;
  if (source.reasoningDowngraded === true) output.reasoningDowngraded = true;
  return output;
}

function readSettings(settingsStore) {
  try {
    return settingsStore?.get?.() || cloneJson(DEFAULT_RECURSION_SETTINGS);
  } catch {
    return cloneJson(DEFAULT_RECURSION_SETTINGS);
  }
}

function providerConfigFor(settingsStore, lane) {
  const settings = readSettings(settingsStore);
  const provider = settings.providers?.[lane] || DEFAULT_RECURSION_SETTINGS.providers[lane];
  return {
    settings,
    config: provider || DEFAULT_RECURSION_SETTINGS.providers.utility
  };
}

function shouldAllowReasoner(settings, config) {
  return settings.reasonerUse !== 'off' && config?.enabled === true;
}

function requestLane(roleId, request = {}) {
  if (LANES.has(request?.lane)) return request.lane;
  return roleLane(roleId) || 'utility';
}

function isProviderRole(roleId) {
  const id = String(roleId || '').trim();
  return UTILITY_ROLES.has(id) || REASONER_ROLES.has(id);
}

function unsupportedRoleError(roleId) {
  const id = String(roleId || '').trim();
  if (!id) {
    return providerError('RECURSION_PROVIDER_ROLE_MISSING', 'Provider request is missing roleId.', { retryable: false });
  }
  return providerError(
    'RECURSION_PROVIDER_ROLE_UNSUPPORTED',
    `Unsupported provider role: ${id}.`,
    { retryable: false }
  );
}

function expectedResponseSchema(roleId) {
  return ROLE_RESPONSE_SCHEMAS[String(roleId || '').trim()] || '';
}

function schemaSafeName(schema) {
  return String(schema || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '_');
}

function uniqueRequestStrings(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => String(entry || '').trim())
    .filter(Boolean))];
}

function requestStringSchema(values) {
  return values.length > 0 ? { enum: values } : { type: 'string' };
}

function editorialEvidenceRefsSchema(validEvidenceIds) {
  return {
    type: 'array',
    items: requestStringSchema(validEvidenceIds),
    minItems: 1,
    maxItems: 8,
    uniqueItems: true
  };
}

function editorialClaimSchema(validEvidenceIds) {
  return {
    type: 'object',
    properties: {
      claim: { type: 'string' },
      evidenceRefs: editorialEvidenceRefsSchema(validEvidenceIds)
    },
    required: ['claim', 'evidenceRefs'],
    additionalProperties: false
  };
}

function redirectPressureSchema(validEvidenceIds, validPreservationEvidenceIds) {
  const optionalEvidenceRefs = (values) => ({
    ...editorialEvidenceRefsSchema(values),
    minItems: 0
  });
  const properties = {
    character: { type: 'string' },
    immediateWant: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    wantEvidenceRefs: optionalEvidenceRefs(validPreservationEvidenceIds),
    sourcePressureEffect: { enum: [...REDIRECT_PRESSURE_EFFECTS] },
    sourceEvidenceRefs: optionalEvidenceRefs(validEvidenceIds),
    pressureReason: { type: 'string' }
  };
  const required = [
    'character',
    'immediateWant',
    'wantEvidenceRefs',
    'sourcePressureEffect',
    'sourceEvidenceRefs',
    'pressureReason'
  ];
  const variant = (overrides) => ({
    type: 'object',
    properties: {
      ...properties,
      ...overrides
    },
    required,
    additionalProperties: false
  });
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
    anyOf: [
      variant({
        immediateWant: { type: 'null' },
        wantEvidenceRefs: { ...optionalEvidenceRefs(validPreservationEvidenceIds), maxItems: 0 },
        sourcePressureEffect: { const: 'unclear' },
        sourceEvidenceRefs: { ...optionalEvidenceRefs(validEvidenceIds), maxItems: 0 }
      }),
      variant({
        immediateWant: { type: 'string' },
        wantEvidenceRefs: editorialEvidenceRefsSchema(validPreservationEvidenceIds),
        sourcePressureEffect: { enum: [...REDIRECT_PRESSURE_EFFECTS] },
        sourceEvidenceRefs: editorialEvidenceRefsSchema(validEvidenceIds)
      })
    ]
  };
}

function redirectBriefProperties(validEvidenceIds, validPreservationEvidenceIds) {
  const evidenceRefs = editorialEvidenceRefsSchema(validEvidenceIds);
  const authoritativeRefs = editorialEvidenceRefsSchema(validPreservationEvidenceIds);
  return {
    sourceFailure: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            category: { enum: [...REDIRECT_FAILURE_CATEGORIES] },
            problem: { type: 'string' },
            establishedEvidenceRefs: authoritativeRefs,
            conflictingSourceRefs: evidenceRefs
          },
          required: ['category', 'problem', 'establishedEvidenceRefs', 'conflictingSourceRefs'],
          additionalProperties: false
        }
      ]
    },
    replacementObjective: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            evidenceRefs: authoritativeRefs
          },
          required: ['summary', 'evidenceRefs'],
          additionalProperties: false
        }
      ]
    },
    requiredBeats: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: { summary: { type: 'string' }, evidenceRefs: authoritativeRefs },
        required: ['summary', 'evidenceRefs'],
        additionalProperties: false
      }
    },
    forbiddenSourceBeats: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: { summary: { type: 'string' }, sourceRefs: evidenceRefs },
        required: ['summary', 'sourceRefs'],
        additionalProperties: false
      }
    },
    sceneCharacters: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: {
        type: 'object',
        properties: { character: { type: 'string' }, evidenceRefs: authoritativeRefs },
        required: ['character', 'evidenceRefs'],
        additionalProperties: false
      }
    },
    characterPressure: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: redirectPressureSchema(validEvidenceIds, validPreservationEvidenceIds)
    }
  };
}

function editorialBriefSchema(mode, validEvidenceIds, validPreservationEvidenceIds = validEvidenceIds) {
  const redirectProperties = mode === 'redirect'
    ? redirectBriefProperties(validEvidenceIds, validPreservationEvidenceIds)
    : {};
  const redirectRequired = mode === 'redirect' ? Object.keys(redirectProperties) : [];
  return {
    type: 'object',
    properties: {
      mode: mode ? { const: mode } : { enum: ['repair', 'recompose', 'redirect'] },
      diagnosis: {
        type: 'array',
        maxItems: 10,
        items: {
          type: 'object',
          properties: {
            dimension: { enum: ['turn-fulfillment', 'card-fidelity', 'scene-execution', 'voice', 'pacing', 'anti-slop'] },
            problem: { type: 'string' },
            evidenceRefs: editorialEvidenceRefsSchema(validEvidenceIds)
          },
          required: ['dimension', 'problem', 'evidenceRefs'],
          additionalProperties: false
        }
      },
      preserve: { type: 'array', maxItems: 12, items: editorialClaimSchema(validPreservationEvidenceIds) },
      discard: { type: 'array', maxItems: 12, items: editorialClaimSchema(validEvidenceIds) },
      allowedChanges: { type: 'array', maxItems: 12, items: { type: 'string' } },
      forbiddenChanges: { type: 'array', maxItems: 12, items: { type: 'string' } },
      ...redirectProperties
    },
    required: ['mode', 'diagnosis', 'preserve', 'discard', 'allowedChanges', 'forbiddenChanges', ...redirectRequired],
    additionalProperties: false
  };
}

function editorialCardOutcomesSchema(installedCardIds, validEvidenceIds) {
  return {
    type: 'array',
    minItems: installedCardIds.length,
    maxItems: installedCardIds.length,
    items: {
      type: 'object',
      properties: {
        cardId: requestStringSchema(installedCardIds),
        status: { enum: ['honored', 'repaired', 'not-applicable', 'partially-reflected', 'violated'] },
        evidenceRefs: editorialEvidenceRefsSchema(validEvidenceIds)
      },
      required: ['cardId', 'status', 'evidenceRefs'],
      additionalProperties: false
    }
  };
}

function editorialCandidateSchema(validEvidenceIds, validPreservationEvidenceIds = validEvidenceIds, requiredPreservationLedger = null, mode = '') {
  const preservationLedger = {
    type: 'array',
    maxItems: 12,
    items: editorialClaimSchema(validPreservationEvidenceIds),
    ...(Array.isArray(requiredPreservationLedger) ? { const: requiredPreservationLedger } : {})
  };
  return {
    type: 'object',
    properties: {
      text: { type: 'string' },
      preservationLedger,
      changeLedger: {
        type: 'array',
        ...(mode === 'redirect' ? { minItems: 1 } : {}),
        maxItems: 12,
        items: {
          type: 'object',
          properties: {
            kind: mode === 'redirect'
              ? { const: 'redirect' }
              : { enum: ['remove', 'rewrite', 'reorder', 'add-supported-detail', 'redirect'] },
            summary: { type: 'string' },
            evidenceRefs: editorialEvidenceRefsSchema(validEvidenceIds)
          },
          required: ['kind', 'summary', 'evidenceRefs'],
          additionalProperties: false
        }
      },
      riskFlags: { type: 'array', items: { enum: ['none', 'continuity-risk', 'voice-risk', 'card-interpretation-risk'] }, uniqueItems: true }
    },
    required: ['text', 'preservationLedger', 'changeLedger', 'riskFlags'],
    additionalProperties: false
  };
}

function editorialVerificationChecksSchema(validEvidenceIds) {
  return {
    type: 'array',
    minItems: REDIRECT_VERIFICATION_CHECKS.length,
    maxItems: REDIRECT_VERIFICATION_CHECKS.length,
    items: {
      type: 'object',
      properties: {
        check: { enum: [...REDIRECT_VERIFICATION_CHECKS] },
        status: { enum: ['pass', 'fail', 'unclear'] },
        evidenceRefs: editorialEvidenceRefsSchema(validEvidenceIds),
        note: { type: 'string' }
      },
      required: ['check', 'status', 'evidenceRefs', 'note'],
      additionalProperties: false
    }
  };
}

export function machineJsonSchemaForRequest(request = {}) {
  const schema = String(request?.responseSchema || '').trim();
  if (!schema || request?.machineJson !== true) return null;
  if (schema === 'recursion.generationReview.v1') {
    const sourceHash = String(request?.sourceHash || '').trim();
    const validTargetIds = [...new Set((Array.isArray(request?.validTargetIds) ? request.validTargetIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean))];
    const installedCardIds = [...new Set((Array.isArray(request?.installedCardIds) ? request.installedCardIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean))];
    const targetIdSchema = validTargetIds.length > 0 ? { enum: validTargetIds } : { type: 'string' };
    const cardIdSchema = installedCardIds.length > 0 ? { enum: installedCardIds } : { type: 'string' };
    return {
      name: schemaSafeName(schema),
      schema: {
        type: 'object',
        properties: {
          schema: { const: schema },
          sourceHash: sourceHash ? { const: sourceHash } : { type: 'string' },
          assessment: { type: 'object', additionalProperties: true },
          reviewDomains: { type: 'object', additionalProperties: true },
          cardOutcomes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                cardId: cardIdSchema,
                status: { enum: ['honored', 'repaired', 'not-applicable', 'partially-reflected', 'violated', 'requires-regeneration'] },
                evidenceTargetIds: { type: 'array', items: targetIdSchema, uniqueItems: true }
              },
              required: ['cardId', 'status', 'evidenceTargetIds'],
              additionalProperties: true
            }
          },
          patches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: targetIdSchema,
                domain: { type: 'string' },
                before: { type: 'string' },
                after: { type: 'string' }
              },
              required: ['id', 'domain', 'before', 'after'],
              additionalProperties: true
            }
          }
        },
        required: ['schema', 'sourceHash', 'assessment', 'reviewDomains', 'cardOutcomes', 'patches'],
        additionalProperties: true
      }
    };
  }
  if (schema === 'recursion.editorialDiagnosis.v1') {
    const sourceHash = String(request?.sourceHash || '').trim();
    const snapshotHash = String(request?.snapshotHash || '').trim();
    const mode = ['repair', 'recompose', 'redirect'].includes(String(request?.mode || '').trim())
      ? String(request.mode).trim()
      : '';
    const validEvidenceIds = uniqueRequestStrings(request?.validEvidenceIds);
    const validPreservationEvidenceIds = uniqueRequestStrings(request?.validPreservationEvidenceIds);
    const decisions = mode === 'redirect'
      ? ['proceed']
      : mode === 'recompose'
        ? ['proceed', 'no-change', 'requires-redirect']
        : ['proceed', 'no-change', 'requires-recompose', 'requires-redirect'];
    return {
      name: schemaSafeName(schema),
      schema: {
        type: 'object',
        properties: {
          schema: { const: schema },
          mode: mode ? { const: mode } : { enum: ['repair', 'recompose', 'redirect'] },
          sourceHash: sourceHash ? { const: sourceHash } : { type: 'string' },
          snapshotHash: snapshotHash ? { const: snapshotHash } : { type: 'string' },
          decision: { enum: decisions },
          brief: editorialBriefSchema(mode, validEvidenceIds, validPreservationEvidenceIds)
        },
        required: ['schema', 'mode', 'sourceHash', 'snapshotHash', 'decision', 'brief'],
        additionalProperties: false
      }
    };
  }
  if (schema === 'recursion.editorialPass.v1') {
    const sourceHash = String(request?.sourceHash || '').trim();
    const snapshotHash = String(request?.snapshotHash || '').trim();
    const diagnosisHash = String(request?.diagnosisHash || '').trim();
    const mode = ['repair', 'recompose', 'redirect'].includes(String(request?.mode || '').trim())
      ? String(request.mode).trim()
      : '';
    const validEvidenceIds = uniqueRequestStrings(request?.validEvidenceIds);
    const validPreservationEvidenceIds = uniqueRequestStrings(request?.validPreservationEvidenceIds);
    const requiredPreservationLedger = Array.isArray(request?.requiredPreservationLedger)
      ? request.requiredPreservationLedger
      : null;
    const installedCardIds = uniqueRequestStrings(request?.installedCardIds);
    const validTargetIds = uniqueRequestStrings(request?.validTargetIds);
    const properties = {
      schema: { const: schema },
      mode: mode ? { const: mode } : { enum: ['repair', 'recompose', 'redirect'] },
      sourceHash: sourceHash ? { const: sourceHash } : { type: 'string' },
      snapshotHash: snapshotHash ? { const: snapshotHash } : { type: 'string' },
      diagnosisHash: diagnosisHash ? { const: diagnosisHash } : { type: 'string' },
      cardOutcomes: editorialCardOutcomesSchema(installedCardIds, validEvidenceIds)
    };
    const required = ['schema', 'mode', 'sourceHash', 'snapshotHash', 'diagnosisHash', 'cardOutcomes'];
    if (mode === 'repair') {
      properties.patches = {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            id: requestStringSchema(validTargetIds),
            before: { type: 'string' },
            after: { type: 'string' },
            domain: { enum: ['dialogue', 'narrative-execution', 'anti-slop', 'card-fidelity'] },
            evidenceRefs: editorialEvidenceRefsSchema(validEvidenceIds)
          },
          required: ['id', 'before', 'after', 'domain', 'evidenceRefs'],
          additionalProperties: false
        }
      };
      required.push('patches');
    } else {
      properties.candidate = editorialCandidateSchema(validEvidenceIds, validPreservationEvidenceIds, requiredPreservationLedger, mode);
      required.push('candidate');
    }
    return {
      name: schemaSafeName(schema),
      schema: {
        type: 'object',
        properties,
        required,
        additionalProperties: false
      }
    };
  }
  if (schema === 'recursion.editorialVerification.v1') {
    const mode = ['recompose', 'redirect'].includes(String(request?.mode || '').trim())
      ? String(request.mode).trim()
      : '';
    const sourceHash = String(request?.sourceHash || '').trim();
    const snapshotHash = String(request?.snapshotHash || '').trim();
    const diagnosisHash = String(request?.diagnosisHash || '').trim();
    const candidateHash = String(request?.candidateHash || '').trim();
    const validEvidenceIds = uniqueRequestStrings(request?.validEvidenceIds);
    const properties = {
      schema: { const: schema },
      mode: mode ? { const: mode } : { enum: ['recompose', 'redirect'] },
      sourceHash: sourceHash ? { const: sourceHash } : { type: 'string' },
      snapshotHash: snapshotHash ? { const: snapshotHash } : { type: 'string' },
      diagnosisHash: diagnosisHash ? { const: diagnosisHash } : { type: 'string' },
      candidateHash: candidateHash ? { const: candidateHash } : { type: 'string' },
      decision: { enum: ['accept', 'reject'] },
      evidenceRefs: editorialEvidenceRefsSchema(validEvidenceIds),
      reason: { type: 'string' },
      ...(mode === 'redirect' ? { checks: editorialVerificationChecksSchema(validEvidenceIds) } : {})
    };
    return {
      name: schemaSafeName(schema),
      schema: {
        type: 'object',
        properties,
        required: [
          'schema', 'mode', 'sourceHash', 'snapshotHash', 'diagnosisHash', 'candidateHash', 'decision',
          ...(mode === 'redirect' ? ['checks'] : [])
        ],
        additionalProperties: false
      }
    };
  }
  if (schema === EDITORIAL_EFFECTIVENESS_SCHEMA) {
    const scenarioId = String(request?.scenarioId || '').trim();
    const sourceHash = String(request?.sourceHash || '').trim();
    const candidateHash = String(request?.candidateHash || '').trim();
    return {
      name: schemaSafeName(schema),
      schema: {
        type: 'object',
        properties: {
          schema: { const: schema },
          scenarioId: scenarioId ? { const: scenarioId } : { type: 'string' },
          sourceHash: sourceHash ? { const: sourceHash } : { type: 'string' },
          candidateHash: candidateHash ? { const: candidateHash } : { type: 'string' },
          decision: { enum: ['pass', 'fail'] },
          criteria: {
            type: 'array',
            minItems: REDIRECT_EFFECTIVENESS_CRITERIA.length,
            maxItems: REDIRECT_EFFECTIVENESS_CRITERIA.length,
            items: {
              type: 'object',
              properties: {
                criterion: { enum: [...REDIRECT_EFFECTIVENESS_CRITERIA] },
                status: { enum: ['pass', 'fail'] },
                reason: { type: 'string' }
              },
              required: ['criterion', 'status', 'reason'],
              additionalProperties: false
            }
          }
        },
        required: ['schema', 'scenarioId', 'sourceHash', 'candidateHash', 'decision', 'criteria'],
        additionalProperties: false
      }
    };
  }
  const properties = {
    schema: { const: schema }
  };
  const required = ['schema'];
  const snapshotHash = String(request?.snapshotHash || '').trim();
  if (snapshotHash) {
    properties.snapshotHash = { const: snapshotHash };
    required.push('snapshotHash');
  }
  return {
    name: schemaSafeName(schema),
    schema: {
      type: 'object',
      properties,
      required,
      additionalProperties: true
    }
  };
}

function validateRoleResponseSchema(roleId, data) {
  const expected = expectedResponseSchema(roleId);
  if (!expected) throw unsupportedRoleError(roleId);
  const actual = String(data?.schema || '').trim();
  if (actual !== expected) {
    const error = providerError(
      'RECURSION_PROVIDER_SCHEMA_MISMATCH',
      'Provider output schema did not match the requested role.',
      { retryable: false }
    );
    error.actualSchema = actual || '(missing)';
    error.responseFields = plainObject(data)
      ? Object.keys(data).filter((key) => /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(key)).sort().slice(0, 24)
      : [];
    throw error;
  }
}

function normalizeRoleResponseEnvelope(roleId, data, request = {}) {
  if (!plainObject(data)) return data;
  if (roleId === 'editorialEffectivenessJudge') {
    return {
      ...data,
      scenarioId: String(request?.scenarioId || '').trim(),
      sourceHash: String(request?.sourceHash || '').trim(),
      candidateHash: String(request?.candidateHash || '').trim()
    };
  }
  if (['editorialDiagnostician', 'editorialTransformer', 'editorialVerifier'].includes(roleId)) {
    const normalized = { ...data };
    for (const field of ['sourceHash', 'snapshotHash']) {
      const trusted = String(request?.[field] || '').trim();
      if (trusted) normalized[field] = trusted;
    }
    const mode = String(request?.mode || '').trim();
    if (mode) normalized.mode = mode;
    if (roleId === 'editorialDiagnostician' && mode && plainObject(normalized.brief)) {
      normalized.brief = { ...normalized.brief, mode };
    }
    if (roleId === 'editorialDiagnostician' && mode && String(data.schema || '').trim() === mode) {
      normalized.schema = expectedResponseSchema(roleId);
    }
    if (roleId !== 'editorialDiagnostician') {
      const diagnosisHash = String(request?.diagnosisHash || '').trim();
      if (diagnosisHash) normalized.diagnosisHash = diagnosisHash;
    }
    if (roleId === 'editorialVerifier') {
      const candidateHash = String(request?.candidateHash || '').trim();
      if (candidateHash) normalized.candidateHash = candidateHash;
    }
    return normalized;
  }
  if (roleId !== 'generationReviewer' || String(data.schema || '').trim()) return data;
  const sourceHash = String(request?.sourceHash || '').trim();
  const returnedSourceHash = String(data.sourceHash || '').trim();
  if (!sourceHash || (returnedSourceHash && returnedSourceHash !== sourceHash)) return data;
  if (!Array.isArray(data.cardOutcomes) || !Array.isArray(data.patches)) return data;
  return {
    ...data,
    schema: expectedResponseSchema(roleId),
    sourceHash: returnedSourceHash || sourceHash,
    assessment: plainObject(data.assessment) ? data.assessment : {},
    reviewDomains: plainObject(data.reviewDomains) ? data.reviewDomains : {}
  };
}

function normalizeBatchRequest(entry) {
  if (!entry || typeof entry !== 'object') {
    throw providerError('RECURSION_PROVIDER_REQUEST_INVALID', 'Provider batch requests must be objects.', { retryable: false });
  }
  const roleId = String(entry.roleId || entry.role || '').trim();
  if (!roleId) {
    throw providerError('RECURSION_PROVIDER_ROLE_MISSING', 'Provider batch request is missing roleId.', { retryable: false });
  }
  const request = { ...entry };
  delete request.roleId;
  delete request.role;
  return { roleId, request };
}

function cleanRequestForDiagnostics(request = {}) {
  const clean = { ...request };
  delete clean.prompt;
  delete clean.messages;
  delete clean.signal;
  if (request.prompt !== undefined) clean.promptHash = hashJson(String(request.prompt));
  if (request.messages !== undefined) clean.messagesHash = hashJson(request.messages);
  return sanitize(clean, 200);
}

function openAiCompatibleReasoningDialect(providerConfig = {}) {
  const baseUrl = String(providerConfig?.openAICompatible?.baseUrl || '').toLowerCase();
  const model = String(providerConfig?.openAICompatible?.model || '').toLowerCase();
  const haystack = `${baseUrl} ${model}`;
  if (haystack.includes('deepseek') || model.includes('deepseek-reasoner')) return 'deepseek-reasoner';
  if (haystack.includes('openrouter.ai')) return 'openrouter';
  if (haystack.includes('z.ai') || haystack.includes('zhipu') || model.startsWith('glm-') || model.includes('/glm-')) return 'z-ai-glm';
  if (haystack.includes('minimax') || model.includes('minimax-m3')) return 'minimax-m3';
  if (haystack.includes('api.openai.com') || /(^|[/:-])(gpt-[5-9]|o[1-9])/.test(model)) return 'openai';
  return 'none';
}

function openAiStyleReasoningEffort(intent) {
  if (intent === 'high') return 'high';
  if (intent === 'medium') return 'medium';
  return 'minimal';
}

function glmReasoningEffort(intent) {
  if (intent === 'high') return 'max';
  if (intent === 'medium') return 'medium';
  return 'minimal';
}

function openAiCompatibleReasoningPlan(enriched = {}, { omitReasoning = false } = {}) {
  const intent = normalizeReasoningIntent(enriched.reasoningIntent);
  const category = reasoningCategoryName(enriched.reasoningCategory);
  if (!intent) {
    return {
      body: {},
      diagnostics: category ? { reasoningCategory: category } : {}
    };
  }
  const dialect = openAiCompatibleReasoningDialect(enriched.providerConfig);
  const diagnostics = {
    reasoningIntent: intent,
    ...(category ? { reasoningCategory: category } : {}),
    reasoningDialect: dialect,
    reasoningApplied: false
  };
  if (omitReasoning) {
    return {
      body: {},
      diagnostics: { ...diagnostics, reasoningDowngraded: true }
    };
  }
  if (dialect === 'openrouter' || dialect === 'openai') {
    return {
      body: { reasoning: { effort: openAiStyleReasoningEffort(intent), exclude: true } },
      diagnostics: { ...diagnostics, reasoningApplied: true }
    };
  }
  if (dialect === 'z-ai-glm') {
    return {
      body: {
        thinking: { type: 'enabled' },
        reasoning_effort: glmReasoningEffort(intent)
      },
      diagnostics: { ...diagnostics, reasoningApplied: true }
    };
  }
  if (dialect === 'minimax-m3') {
    return {
      body: { thinking: intent === 'high' ? 'enabled' : 'adaptive' },
      diagnostics: { ...diagnostics, reasoningApplied: true }
    };
  }
  return { body: {}, diagnostics };
}

async function readProviderErrorMessage(response) {
  try {
    const payload = await response.json();
    return compact([
      payload?.error?.message,
      payload?.error?.code,
      payload?.message,
      typeof payload === 'string' ? payload : JSON.stringify(payload)
    ].filter(Boolean).join(' '));
  } catch {
    return '';
  }
}

function providerRejectedReasoningFields(status, message) {
  if (status !== 400 && status !== 422) return false;
  const text = String(message || '').toLowerCase();
  if (!/(reasoning|thinking|reasoning_effort)/.test(text)) return false;
  return /(unknown|unrecognized|unsupported|invalid|unexpected|not\s+permitted|extra|extraneous)/.test(text);
}

function openAiEndpoint(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/g, '');
  if (!base) {
    throw providerError('RECURSION_PROVIDER_CONFIG_INVALID', 'OpenAI-compatible base URL is required.', { retryable: false });
  }
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw providerError('RECURSION_PROVIDER_CONFIG_INVALID', 'OpenAI-compatible base URL is invalid.', { retryable: false });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw providerError('RECURSION_PROVIDER_CONFIG_INVALID', 'OpenAI-compatible base URL must use http or https.', { retryable: false });
  }
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textValue(value, fallback = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function controlOptions(options = {}) {
  const source = plainObject(options) ? options : {};
  return {
    context: source.context ?? null,
    globals: source.globals ?? globalThis
  };
}

function hostContext(globals = globalThis) {
  try {
    return globals?.SillyTavern?.getContext?.() || globals?.getContext?.() || null;
  } catch {
    return null;
  }
}

const MODEL_KEY_PATTERN = /(^|_|\b)(model|modelid|model_id|modelname|model_name|selectedmodel|selected_model|chatmodel|chat_model|completionmodel|completion_model)$/i;

function modelFromProfile(profile = {}) {
  const seen = new Set();
  function visit(value, depth = 0) {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 5) return '';
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (child === null || child === undefined) continue;
      if (typeof child !== 'object' && MODEL_KEY_PATTERN.test(String(key).replace(/[^a-z0-9_]/ig, ''))) {
        const model = textValue(child);
        if (model) return model;
      }
    }
    for (const key of ['settings', 'generationSettings', 'generation_settings', 'provider', 'completion', 'chatCompletion', 'chat_completion', 'config', 'data']) {
      const model = visit(value[key], depth + 1);
      if (model) return model;
    }
    return '';
  }
  return visit(profile);
}

export function listProviderConnectionProfiles(options = {}) {
  if (typeof options?.host?.providerProfiles?.list === 'function') {
    const profiles = options.host.providerProfiles.list(options);
    return Array.isArray(profiles) ? profiles : [];
  }
  if (typeof options?.listConnectionProfiles === 'function') {
    const profiles = options.listConnectionProfiles(options);
    return Array.isArray(profiles) ? profiles : [];
  }
  return [];
}

function currentHostModel(options = {}) {
  const { globals } = controlOptions(options);
  const context = options?.context ?? hostContext(globals);
  const roots = [
    context?.chatCompletionSettings,
    context?.completionSettings,
    context?.settings,
    context?.power_user,
    globals?.power_user,
    globals?.oai_settings,
    globals?.nai_settings,
    globals?.textgenerationwebui_settings
  ];
  for (const root of roots) {
    const model = modelFromProfile(root);
    if (model) return model;
  }
  return '';
}

function sourceLabel(source) {
  const normalized = sourceName(source);
  if (normalized === 'host-connection-profile') return 'Host Connection Profile';
  if (normalized === 'openai-compatible') return 'OpenAI-Compatible Endpoint';
  return 'Current Host Model';
}

export function validateProviderConfiguration(provider = {}, options = {}) {
  const source = sourceName(provider.source);
  const missing = [];
  let ready = true;
  let message = 'Ready.';
  if (source === 'host-current-model') {
    if (options.hostGenerationAvailable === false) {
      ready = false;
      missing.push('hostGeneration');
      message = 'Host generation API unavailable.';
    } else {
      message = 'Uses the active SillyTavern model.';
    }
  } else if (source === 'host-connection-profile') {
    const profile = textValue(provider.hostConnectionProfileId);
    const profiles = Array.isArray(options.profiles)
      ? options.profiles
      : listProviderConnectionProfiles(options);
    if (!profile) {
      ready = false;
      missing.push('hostConnectionProfileId');
      message = profiles.length ? 'Select a host connection profile.' : 'No host connection profiles detected.';
    } else if (!profiles.some((entry) => entry.id === profile)) {
      ready = false;
      missing.push('connectionProfile');
      message = profiles.length ? 'Saved profile was not detected.' : 'Connection profile service unavailable.';
    } else {
      message = 'Uses the selected SillyTavern connection profile.';
    }
  } else if (source === 'openai-compatible') {
    const direct = plainObject(provider.openAICompatible) ? provider.openAICompatible : {};
    if (!textValue(direct.baseUrl)) missing.push('baseUrl');
    if (!textValue(direct.model)) missing.push('model');
    if (!textValue(options.apiKey) && direct.sessionApiKeyPresent !== true) missing.push('sessionApiKey');
    ready = missing.length === 0;
    message = ready ? 'Direct endpoint configured for this session.' : `Missing ${missing.join(', ')}.`;
  } else {
    ready = false;
    missing.push('source');
    message = 'Unsupported provider source.';
  }
  return {
    ready,
    missing,
    source,
    sourceLabel: sourceLabel(source),
    message
  };
}

export function providerModelStatus(provider = {}, options = {}) {
  const source = sourceName(provider.source);
  if (source === 'host-connection-profile') {
    const profiles = Array.isArray(options.profiles) ? options.profiles : listProviderConnectionProfiles(options);
    const validation = validateProviderConfiguration(provider, { ...options, profiles });
    const selected = profiles.find((entry) => entry.id === textValue(provider.hostConnectionProfileId));
    return {
      ...validation,
      model: selected?.model || '',
      label: selected?.label || (provider.hostConnectionProfileId ? `${provider.hostConnectionProfileId} (saved)` : sourceLabel(source)),
      profileId: selected?.id || textValue(provider.hostConnectionProfileId),
      profileLabel: selected?.name || ''
    };
  }
  const validation = validateProviderConfiguration(provider, options);
  if (source === 'openai-compatible') {
    const model = textValue(provider.openAICompatible?.model);
    return {
      ...validation,
      model,
      label: model ? `OpenAI-Compatible / ${model}` : 'OpenAI-Compatible Endpoint'
    };
  }
  const model = currentHostModel(options);
  return {
    ...validation,
    model,
    label: 'Current Host Model'
  };
}

export function providerRouteSummary(settings = {}) {
  const level = String(settings?.reasoningLevel || 'medium').toLowerCase();
  const normalizedLevel = ['low', 'medium', 'high', 'ultra'].includes(level) ? level : 'medium';
  const reasoner = settings?.providers?.reasoner || {};
  const reasonerHealthy = reasoner.enabled === true && reasoner.lastTest?.status === 'pass';
  const reasonerLabel = reasonerHealthy ? 'Reasoner' : 'Utility fallback';
  const summary = normalizedLevel === 'low'
    ? { arbiter: 'Utility', cards: 'Utility', composer: 'Utility' }
    : normalizedLevel === 'medium'
      ? { arbiter: 'Utility', cards: 'Utility', composer: reasonerLabel }
      : normalizedLevel === 'high'
        ? { arbiter: reasonerLabel, cards: reasonerHealthy ? 'Priority Reasoner, Utility lower priority' : 'Utility fallback', composer: reasonerLabel }
        : { arbiter: reasonerLabel, cards: reasonerLabel, composer: reasonerLabel };
  return {
    level: normalizedLevel,
    reasonerHealthy,
    ...summary,
    text: `Arbiter: ${summary.arbiter}; Cards: ${summary.cards}; Composer: ${summary.composer}`
  };
}

function normalizeOpenAiBaseUrl(baseUrl) {
  let base = String(baseUrl || '').trim().replace(/\/+$/g, '');
  if (!base) {
    throw providerError('RECURSION_PROVIDER_CONFIG_INVALID', 'OpenAI-compatible base URL is required.', { retryable: false });
  }
  try {
    const parsed = new URL(base);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol');
  } catch {
    throw providerError('RECURSION_PROVIDER_CONFIG_INVALID', 'OpenAI-compatible base URL is invalid.', { retryable: false });
  }
  base = base.replace(/\/chat\/completions$/i, '');
  base = base.replace(/\/responses$/i, '');
  base = base.replace(/\/models$/i, '');
  return base.replace(/\/+$/g, '');
}

export function openAiModelsEndpoint(baseUrl) {
  return `${normalizeOpenAiBaseUrl(baseUrl)}/models`;
}

function normalizeModelList(payload = {}) {
  const source = Array.isArray(payload?.data)
    ? payload.data
    : (Array.isArray(payload?.models) ? payload.models : []);
  const byId = new Map();
  for (const entry of source) {
    const id = textValue(typeof entry === 'string' ? entry : (entry?.id || entry?.model || entry?.name));
    if (!id || byId.has(id)) continue;
    byId.set(id, {
      id,
      label: textValue(typeof entry === 'string' ? entry : (entry?.name || entry?.label || entry?.id || entry?.model), id)
    });
  }
  return [...byId.values()];
}

export async function fetchOpenAICompatibleModels({
  baseUrl,
  apiKey = '',
  fetchImpl = globalThis.fetch,
  signal = undefined
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw providerError('RECURSION_PROVIDER_FETCH_UNAVAILABLE', 'Fetch is unavailable for OpenAI-compatible model discovery.', {
      retryable: false
    });
  }
  const key = String(apiKey || '').trim();
  if (!key) {
    throw providerError('RECURSION_PROVIDER_KEY_MISSING', 'OpenAI-compatible provider key is missing for model discovery.', {
      retryable: false
    });
  }
  const endpoint = openAiModelsEndpoint(baseUrl);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      credentials: 'omit',
      signal
    });
  } catch (error) {
    if (error?.code === 'RECURSION_PROVIDER_CONFIG_INVALID') throw error;
    if (error?.name === 'AbortError') throw abortError();
    throw providerError('RECURSION_PROVIDER_TRANSPORT_FAILED', 'Provider model discovery transport failed.', {
      retryable: true,
      cause: error
    });
  }
  if (!response?.ok) {
    const status = Number(response?.status || 0);
    throw providerError('RECURSION_PROVIDER_HTTP_ERROR', `Provider model discovery failed with HTTP ${status || 'error'}.`, {
      retryable: status === 429 || (status >= 500 && status < 600),
      status
    });
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw providerError('RECURSION_PROVIDER_RESPONSE_JSON_INVALID', 'Provider model discovery response was not valid JSON.', {
      retryable: false,
      cause: error
    });
  }
  return {
    ok: true,
    endpoint,
    models: normalizeModelList(payload)
  };
}

function chatMessages(request = {}) {
  if (Array.isArray(request.messages) && request.messages.length > 0) return request.messages;
  return [{ role: 'user', content: String(request.prompt ?? '') }];
}

function providerResponseFailureError(error, enriched = {}) {
  const code = String(error?.code || '');
  const details = error?.details || {};
  const providerDiagnostics = sanitize({
    providerSource: enriched.providerSource,
    model: details.model || enriched.providerConfig?.resolvedModelLabel || enriched.providerConfig?.openAICompatible?.model || '',
    effectiveMaxTokens: Number(details.maxTokens || providerRequestMaxTokens(enriched) || 0) || 0,
    finishReason: details.finishReason,
    promptTokens: details.promptTokens,
    completionTokens: details.completionTokens,
    reasoningTokens: details.reasoningTokens,
    totalTokens: details.totalTokens,
    visibleContentLength: details.visibleContentLength,
    reasoningLength: details.reasoningLength
  }, 300);
  if (code === PROVIDER_RESPONSE_ERROR_CODES.TOKEN_LIMIT) {
    throw providerError('RECURSION_PROVIDER_TOKEN_LIMIT', 'Provider response stopped at the token limit before returning complete visible JSON.', {
      retryable: false,
      providerDiagnostics
    });
  }
  if (code === PROVIDER_RESPONSE_ERROR_CODES.REASONING_ONLY) {
    throw providerError('RECURSION_PROVIDER_REASONING_ONLY', 'Provider returned hidden reasoning without visible JSON content.', {
      retryable: false
    });
  }
  if (code === PROVIDER_RESPONSE_ERROR_CODES.EMPTY_CONTENT) {
    throw providerError('RECURSION_PROVIDER_EMPTY_RESPONSE', 'Provider response did not include message content.', {
      retryable: false
    });
  }
  throw providerError('RECURSION_PROVIDER_EMPTY_RESPONSE', details.message || 'Provider response did not include message content.', {
    retryable: false
  });
}

function providerVisibleText(value, enriched = {}) {
  try {
    return assertProviderResponseText(value, {
      providerTitle: enriched.providerSource || 'Provider',
      maxTokens: providerRequestMaxTokens(enriched)
    });
  } catch (error) {
    providerResponseFailureError(error, enriched);
  }
}

function positiveTokenLimit(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function providerRequestMaxTokens(enriched = {}) {
  const configured = positiveTokenLimit(enriched.providerConfig?.maxTokens);
  const requested = positiveTokenLimit(enriched.responseLength)
    ?? positiveTokenLimit(enriched.maxTokens);
  if (configured && requested) return Math.min(configured, requested);
  return configured ?? requested;
}

function parseOpenAiText(payload, enriched = {}) {
  return providerVisibleText(payload, {
    ...enriched,
    providerSource: enriched.providerSource || 'OpenAI-compatible'
  });
}

function normalizeProviderResponse(response, enriched) {
  const output = response && typeof response === 'object' ? { ...response } : { text: String(response ?? '') };
  const text = providerVisibleText(output, enriched);
  return {
    ...output,
    text,
    roleId: enriched.roleId,
    lane: enriched.lane,
    providerSource: enriched.providerSource,
    providerId: output.providerId || enriched.providerSource,
    model: output.model || enriched.providerConfig?.resolvedModelLabel || enriched.providerConfig?.openAICompatible?.model || '',
    providerConfig: enriched.providerConfig,
    ...reasoningDiagnostics({ ...enriched, ...output })
  };
}

function batchCapabilityDiagnostics(capability = {}) {
  const source = plainObject(capability) ? capability : {};
  const mode = String(source.mode || '').trim();
  const maxConcurrency = Number(source.maxConcurrency);
  return sanitize({
    ...(mode ? { batchMode: mode } : {}),
    ...(Number.isFinite(maxConcurrency) ? { concurrencyLimit: Math.max(1, Math.round(maxConcurrency)) } : {}),
    ...(Object.prototype.hasOwnProperty.call(source, 'slotIsolation') ? { slotIsolation: source.slotIsolation === true } : {}),
    ...(Object.prototype.hasOwnProperty.call(source, 'supportsAbortSignal') ? { supportsAbortSignal: source.supportsAbortSignal === true } : {}),
    ...(source.source ? { batchCapabilitySource: String(source.source).slice(0, 120) } : {})
  }, 200);
}

function batchDiagnosticsFromResponse(response = {}) {
  const source = plainObject(response) ? response : {};
  return sanitize({
    ...(source.batchMode ? { batchMode: String(source.batchMode).slice(0, 80) } : {}),
    ...(Number.isFinite(Number(source.concurrencyLimit)) ? { concurrencyLimit: Math.max(1, Math.round(Number(source.concurrencyLimit))) } : {}),
    ...(Object.prototype.hasOwnProperty.call(source, 'slotIsolation') ? { slotIsolation: source.slotIsolation === true } : {}),
    ...(Object.prototype.hasOwnProperty.call(source, 'supportsAbortSignal') ? { supportsAbortSignal: source.supportsAbortSignal === true } : {}),
    ...(source.batchCapabilitySource ? { batchCapabilitySource: String(source.batchCapabilitySource).slice(0, 120) } : {})
  }, 200);
}

function normalizeProviderSlotFailure(response = {}, enriched = {}, batchDiagnostics = {}) {
  const rawError = plainObject(response.error) ? response.error : {};
  const code = String(rawError.code || 'RECURSION_PROVIDER_BATCH_SLOT_FAILED').trim()
    || 'RECURSION_PROVIDER_BATCH_SLOT_FAILED';
  const message = String(rawError.message || 'Provider batch slot failed.').replace(/\s+/g, ' ').trim()
    || 'Provider batch slot failed.';
  return {
    ...batchDiagnostics,
    text: '',
    roleId: enriched.roleId,
    lane: enriched.lane,
    providerSource: enriched.providerSource,
    providerId: enriched.providerSource,
    model: '',
    providerConfig: enriched.providerConfig,
    slotError: sanitize({
      code: code.slice(0, 120),
      message: message.slice(0, 300),
      retryable: rawError.retryable === true,
      ...(rawError.status !== undefined ? { status: rawError.status } : {})
    }, 300)
  };
}

function responseTextHash(text) {
  return hashJson(String(text ?? ''));
}

function errorChain(error, limit = 6) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (current && typeof current === 'object' && chain.length < limit && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = current.cause;
  }
  return chain;
}

function retryability(error) {
  const chain = errorChain(error);
  for (const entry of chain) {
    if (entry?.retryable === true) return true;
    if (entry?.retryable === false) return false;
    if (TRANSIENT_CODES.has(entry?.code)) return true;
    const status = Number(entry?.status);
    if (status === 429 || (status >= 500 && status < 600)) return true;
    if (status >= 400 && status < 500) return false;
  }
  return chain.some((entry) => /^api request failed$/i.test(String(entry?.message || '').trim()))
    ? true
    : null;
}

function retryableError(error) {
  return retryability(error) === true;
}

function actionableError(error) {
  const chain = errorChain(error);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const entry = chain[index];
    const code = String(entry?.code || '').trim();
    const status = Number(entry?.status);
    if ((code && code !== 'Error') || Number.isFinite(status) || typeof entry?.retryable === 'boolean') return entry;
  }
  return chain.at(-1) || error;
}

function structuredOutputRecoveryKind(error, request = {}) {
  const code = String(error?.code || '');
  if (code === 'RECURSION_PROVIDER_TOKEN_LIMIT' && request?.machineJson === true) return 'token_limit_compact_retry';
  if (code === 'RECURSION_JSON_PARSE_FAILED'
    || code === 'RECURSION_JSON_OBJECT_REQUIRED'
    || code === 'RECURSION_PROVIDER_SCHEMA_MISMATCH') return 'slot_correction_retry';
  return '';
}

function structuredOutputRetryableError(error, request = {}) {
  return Boolean(structuredOutputRecoveryKind(error, request));
}

function structuredOutputFieldHint(roleId, request = {}) {
  const expected = expectedResponseSchema(roleId);
  const fields = [];
  if (expected) fields.push(`"schema": "${expected}"`);
  const snapshotHash = String(request?.snapshotHash || '').trim();
  if (snapshotHash) fields.push(`"snapshotHash": "${snapshotHash}"`);
  return fields.length
    ? `Required top-level fields include ${fields.join(', ')}.`
    : 'Required top-level fields must match the requested role contract.';
}

function requestWithStructuredRetryPrompt(request = {}, { roleId = '', error = null } = {}) {
  const expected = expectedResponseSchema(roleId);
  const tokenLimit = String(error?.code || '') === 'RECURSION_PROVIDER_TOKEN_LIMIT';
  const correction = tokenLimit ? [
    '',
    'Previous response stopped at the provider token limit.',
    `Return exactly one complete compact JSON object with schema "${expected}".`,
    structuredOutputFieldHint(roleId, request),
    'Use concise claims and evidence references. Do not include markdown, prose, comments, analysis, hidden reasoning, or alternate schemas.'
  ].join('\n') : [
    '',
    'Previous response was rejected by Recursion structured-output validation.',
    `Return exactly one JSON object with schema "${expected}".`,
    structuredOutputFieldHint(roleId, request),
    'Do not include markdown fences, prose, comments, hidden reasoning, or alternate schemas.',
    `Validation error code: ${String(error?.code || 'RECURSION_PROVIDER_FORMAT_RETRY')}.`
  ].join('\n');
  return {
    ...request,
    prompt: `${String(request?.prompt ?? '')}${correction}`,
    ...(tokenLimit ? { reasoningIntent: 'low' } : {})
  };
}

function scrubKnownRequestText(value, request = {}) {
  let output = String(value ?? '');
  const needles = [];
  if (typeof request.prompt === 'string') needles.push(request.prompt);
  if (request.messages !== undefined) {
    needles.push(JSON.stringify(request.messages));
    collectStrings(request.messages, needles);
  }
  for (const needle of Array.from(new Set(needles)).sort((a, b) => b.length - a.length)) {
    if (!needle) continue;
    output = output.split(needle).join('[redacted]');
    output = output.split(compact(needle)).join('[redacted]');
  }
  return output;
}

function collectStrings(value, target) {
  if (typeof value === 'string') {
    target.push(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, target);
    return;
  }
  for (const child of Object.values(value)) collectStrings(child, target);
}

function sanitizedError(error, request = {}) {
  const actionable = actionableError(error);
  const rawCode = String(actionable?.code || actionable?.name || 'RECURSION_PROVIDER_FAILED');
  const message = actionable?.external === true
    ? 'Provider generation failed.'
    : scrubKnownRequestText(actionable?.message || 'Provider generation failed.', request);
  const actualSchema = scrubKnownRequestText(actionable?.actualSchema || '', request);
  const responseFields = Array.isArray(actionable?.responseFields)
    ? actionable.responseFields.map((field) => String(field).replace(/[^a-zA-Z0-9_-]+/g, '').slice(0, 80)).filter(Boolean).slice(0, 24)
    : [];
  return sanitize({
    code: scrubKnownRequestText(rawCode, request),
    message: truncate(compact(message), 300),
    retryable: retryableError(error),
    ...providerFailureDiagnostics(error),
    ...(actualSchema ? { actualSchema: truncate(compact(actualSchema), 120) } : {}),
    ...(responseFields.length ? { responseFields } : {})
  }, 300);
}

function providerFailureDiagnostics(error) {
  const chain = errorChain(error);
  const source = chain.map((entry) => entry?.providerDiagnostics).find((entry) => plainObject(entry)) || {};
  return sanitize({
    providerSource: source.providerSource,
    model: source.model,
    effectiveMaxTokens: source.effectiveMaxTokens,
    finishReason: source.finishReason,
    promptTokens: source.promptTokens,
    completionTokens: source.completionTokens,
    reasoningTokens: source.reasoningTokens,
    totalTokens: source.totalTokens,
    visibleContentLength: source.visibleContentLength,
    reasoningLength: source.reasoningLength
  }, 300);
}

function sanitizedBatchError(error, entries = []) {
  const safeError = { ...sanitizedError(error) };
  for (const entry of entries) {
    safeError.code = scrubKnownRequestText(safeError.code, entry.request);
    safeError.message = scrubKnownRequestText(safeError.message, entry.request);
  }
  return sanitize(safeError, 300);
}

function statusForError(error) {
  if (error?.code === 'RECURSION_JSON_PARSE_FAILED' || error?.code === 'RECURSION_JSON_OBJECT_REQUIRED') {
    return 'validation-failed';
  }
  if (error?.code === 'RECURSION_PROVIDER_TIMEOUT') return 'timeout';
  if (error?.code === 'RECURSION_PROVIDER_ABORTED') return 'aborted';
  return 'provider-failed';
}

function safeInvoke(fn) {
  if (typeof fn !== 'function') return undefined;
  try {
    const result = fn();
    if (result && typeof result.catch === 'function') result.catch(() => {});
    return result;
  } catch {
    return undefined;
  }
}

async function journalAppend(journal, entry) {
  if (!journal) return;
  const safeEntry = sanitize(entry, 300);
  const methods = ['append', 'record', 'write', 'push'];
  for (const method of methods) {
    if (typeof journal?.[method] === 'function') {
      try {
        await journal[method](cloneSafe(safeEntry, safeEntry));
      } catch {
        // Journal writes are diagnostic only.
      }
      return;
    }
  }
  if (typeof journal === 'function') {
    try {
      await journal(cloneSafe(safeEntry, safeEntry));
    } catch {
      // Journal writes are diagnostic only.
    }
  }
}

function activityStart(activity, event) {
  if (!activity || typeof activity.start !== 'function') return event.runId;
  const safeEvent = sanitize(event, 300);
  let runId = event.runId;
  safeInvoke(() => {
    const started = activity.start(cloneSafe(safeEvent, safeEvent));
    if (started?.runId) runId = started.runId;
    return started;
  });
  return runId;
}

function activityStage(activity, event) {
  if (!activity || typeof activity.stage !== 'function') return;
  const safeEvent = sanitize(event, 300);
  safeInvoke(() => activity.stage(cloneSafe(safeEvent, safeEvent)));
}

function activitySettle(activity, event) {
  if (!activity || typeof activity.settle !== 'function') return;
  const safeEvent = sanitize(event, 300);
  safeInvoke(() => activity.settle(cloneSafe(safeEvent, safeEvent)));
}

function abortError() {
  return providerError('RECURSION_PROVIDER_ABORTED', 'Provider generation was aborted.', { retryable: false });
}

function timeoutError(timeoutMs) {
  return providerError('RECURSION_PROVIDER_TIMEOUT', `Provider generation timed out after ${timeoutMs}ms.`, {
    retryable: true
  });
}

async function withTimeout(operation, request, timeoutMs, externalSignal = null) {
  if (externalSignal?.aborted) throw abortError();

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const requestWithSignal = controller ? { ...request, signal: controller.signal } : { ...request };
  let timeoutId = null;
  let removeAbortListener = () => {};

  const timeoutPromise = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller?.abort?.();
        reject(timeoutError(timeoutMs));
      }, timeoutMs);
    })
    : null;

  const abortPromise = externalSignal
    ? new Promise((_, reject) => {
      const onAbort = () => {
        controller?.abort?.();
        reject(abortError());
      };
      externalSignal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => externalSignal.removeEventListener('abort', onAbort);
    })
    : null;

  try {
    const generation = operation(requestWithSignal);
    const racers = [generation];
    if (timeoutPromise) racers.push(timeoutPromise);
    if (abortPromise) racers.push(abortPromise);
    return await Promise.race(racers);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    removeAbortListener();
  }
}

function composeAbortSignal(signals = []) {
  const activeSignals = signals.filter((signal) => signal && typeof signal.addEventListener === 'function');
  if (activeSignals.length === 0) return { signal: undefined, cleanup: () => {} };
  if (activeSignals.length === 1) return { signal: activeSignals[0], cleanup: () => {} };

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  if (!controller) return { signal: activeSignals[0], cleanup: () => {} };

  const cleanupHandlers = [];
  const abort = () => controller.abort();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort();
      continue;
    }
    signal.addEventListener('abort', abort, { once: true });
    cleanupHandlers.push(() => signal.removeEventListener('abort', abort));
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const cleanup of cleanupHandlers) cleanup();
    }
  };
}

async function withBatchTimeout(operation, requests, timeoutMs, externalSignal = null) {
  if (externalSignal?.aborted) throw abortError();

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timeoutId = null;
  let removeAbortListener = () => {};
  const signalCleanups = [];

  const timeoutPromise = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller?.abort?.();
        reject(timeoutError(timeoutMs));
      }, timeoutMs);
    })
    : null;

  const abortPromise = externalSignal
    ? new Promise((_, reject) => {
      const onAbort = () => {
        controller?.abort?.();
        reject(abortError());
      };
      externalSignal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => externalSignal.removeEventListener('abort', onAbort);
    })
    : null;

  const requestsWithSignals = requests.map((request) => {
    const composed = composeAbortSignal([controller?.signal, request.signal]);
    signalCleanups.push(composed.cleanup);
    return composed.signal ? { ...request, signal: composed.signal } : { ...request };
  });

  try {
    const generation = operation(requestsWithSignals);
    const racers = [generation];
    if (timeoutPromise) racers.push(timeoutPromise);
    if (abortPromise) racers.push(abortPromise);
    return await Promise.race(racers);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    removeAbortListener();
    for (const cleanup of signalCleanups) cleanup();
  }
}

function diagnosticsTimeout(timeoutMs) {
  const number = Number(timeoutMs);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : null;
}

function diagnosticsSnapshotHash(request = {}) {
  const snapshotHash = compact(String(request.snapshotHash || ''));
  return snapshotHash ? truncate(snapshotHash, 180) : undefined;
}

function diagnosticsBase({ roleId, lane, request, runId, startedAt, timeoutMs }) {
  const snapshotHash = diagnosticsSnapshotHash(request);
  return sanitize({
    runId,
    roleId,
    lane,
    ...reasoningDiagnostics(request),
    timeoutMs: diagnosticsTimeout(timeoutMs),
    ...(snapshotHash ? { snapshotHash } : {}),
    requestHash: hashJson({ roleId, lane, request: cleanRequestForDiagnostics(request) }),
    startedAt
  }, 300);
}

export function roleLane(roleId) {
  const id = String(roleId || '').trim();
  if (REASONER_ROLES.has(id)) return 'reasoner';
  if (UTILITY_ROLES.has(id)) return 'utility';
  return '';
}

export function parseStructuredOutput(text) {
  const parsed = parseStructuredJsonText(text);
  if (!parsed.ok) {
    const error = new Error(parsed.error || 'Provider output was not a valid JSON object.');
    error.code = parsed.diagnostic?.code === STRUCTURED_OUTPUT_PARSE_ERROR_CODES.JSON_NOT_OBJECT
      ? 'RECURSION_JSON_OBJECT_REQUIRED'
      : 'RECURSION_JSON_PARSE_FAILED';
    error.diagnostic = parsed.diagnostic;
    throw error;
  }
  return parsed.value;
}

function parseProviderStructuredOutput(text) {
  const parsed = parseStructuredJsonText(text);
  if (!parsed.ok) {
    const code = parsed.diagnostic?.code === STRUCTURED_OUTPUT_PARSE_ERROR_CODES.JSON_NOT_OBJECT
      ? 'RECURSION_JSON_OBJECT_REQUIRED'
      : 'RECURSION_JSON_PARSE_FAILED';
    const error = providerError(code, 'Provider output was not a valid JSON object.', { retryable: false });
    error.diagnostic = parsed.diagnostic;
    throw error;
  }
  return {
    data: parsed.value,
    diagnostics: {
      structuredOutputRepaired: parsed.repaired === true,
      ...(parsed.repaired ? { structuredOutputRepairCode: 'json_repaired' } : {}),
      visibleContentLength: parsed.visibleContentLength
    }
  };
}

export function createProviderClient({ host = null, settingsStore = null, fetchImpl = globalThis.fetch } = {}) {
  function enrich(roleId, request = {}) {
    const resolvedRoleId = String(roleId || '').trim();
    if (!resolvedRoleId) {
      throw providerError('RECURSION_PROVIDER_ROLE_MISSING', 'Provider request is missing roleId.', { retryable: false });
    }
    if (!isProviderRole(resolvedRoleId)) {
      throw unsupportedRoleError(resolvedRoleId);
    }

    const lane = laneName(requestLane(resolvedRoleId, request));
    const { settings, config } = providerConfigFor(settingsStore, lane);
    if (lane === 'reasoner' && resolvedRoleId !== 'providerTest' && !shouldAllowReasoner(settings, config)) {
      throw providerError('RECURSION_REASONER_DISABLED', 'Reasoner provider lane is disabled.', { retryable: false });
    }

    return {
      ...request,
      roleId: resolvedRoleId,
      lane,
      ...(normalizeReasoningIntent(request.reasoningIntent) ? { reasoningIntent: normalizeReasoningIntent(request.reasoningIntent) } : {}),
      ...(reasoningCategoryName(request.reasoningCategory) ? { reasoningCategory: reasoningCategoryName(request.reasoningCategory) } : {}),
      responseSchema: expectedResponseSchema(resolvedRoleId),
      machineJson: true,
      providerSource: sourceName(config.source),
      providerConfig: cloneJson(config)
    };
  }

  async function generate(roleId, request = {}) {
    const enriched = enrich(roleId, request);
    const source = enriched.providerSource;

    if (HOST_SOURCES.has(source)) {
      if (typeof host?.generation?.generate !== 'function') {
        throw providerError('RECURSION_HOST_GENERATION_UNAVAILABLE', 'Host generation API is unavailable.', {
          retryable: false
        });
      }
      const response = await host.generation.generate(enriched);
      return normalizeProviderResponse(response, enriched);
    }

    if (source !== 'openai-compatible') {
      throw providerError('RECURSION_PROVIDER_SOURCE_UNSUPPORTED', `Unsupported provider source: ${source}`, {
        retryable: false
      });
    }

    if (typeof fetchImpl !== 'function') {
      throw providerError('RECURSION_PROVIDER_FETCH_UNAVAILABLE', 'Fetch is unavailable for OpenAI-compatible provider calls.', {
        retryable: false
      });
    }

    const apiKey = settingsStore?.getApiKey?.(enriched.lane) || '';
    if (!apiKey) {
      throw providerError('RECURSION_PROVIDER_KEY_MISSING', 'OpenAI-compatible provider key is missing for this session.', {
        retryable: false
      });
    }

    const model = String(enriched.providerConfig?.openAICompatible?.model || '').trim();
    if (!model) {
      throw providerError('RECURSION_PROVIDER_CONFIG_INVALID', 'OpenAI-compatible model is required.', { retryable: false });
    }

    function buildOpenAiCompatibleBody({ omitReasoning = false } = {}) {
      const machineSchema = machineJsonSchemaForRequest(enriched);
      const reasoningPlan = openAiCompatibleReasoningPlan(enriched, { omitReasoning });
      return {
        body: {
          model,
          messages: chatMessages(enriched),
          temperature: enriched.providerConfig.temperature,
          top_p: enriched.providerConfig.topP,
          max_tokens: providerRequestMaxTokens(enriched),
          response_format: machineSchema
            ? {
                type: 'json_schema',
                json_schema: {
                  name: machineSchema.name,
                  strict: false,
                  schema: machineSchema.schema
                }
              }
            : { type: 'json_object' },
          stream: false,
          ...reasoningPlan.body
        },
        reasoningDiagnostics: reasoningPlan.diagnostics
      };
    }

    const endpoint = openAiEndpoint(enriched.providerConfig?.openAICompatible?.baseUrl);
    let requestBody = buildOpenAiCompatibleBody();

    async function sendOpenAiCompatible(body) {
      return await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: enriched.signal
      });
    }

    let response;
    try {
      response = await sendOpenAiCompatible(requestBody.body);
    } catch (error) {
      if (error?.code === 'RECURSION_PROVIDER_CONFIG_INVALID') throw error;
      if (error?.name === 'AbortError') throw abortError();
      throw providerError('RECURSION_PROVIDER_TRANSPORT_FAILED', 'Provider transport failed.', {
        retryable: true,
        cause: error
      });
    }

    if (!response?.ok) {
      const status = Number(response?.status || 0);
      if (status === 401 || status === 403) {
        markOpenAiAuthFailure(settingsStore, enriched.lane);
        throw providerError('RECURSION_PROVIDER_AUTH_FAILED', 'OpenAI-compatible authentication failed.', {
          retryable: false,
          status
        });
      }
      if (requestBody.reasoningDiagnostics?.reasoningApplied === true) {
        const errorMessage = await readProviderErrorMessage(response);
        if (providerRejectedReasoningFields(status, errorMessage)) {
          requestBody = buildOpenAiCompatibleBody({ omitReasoning: true });
          try {
            response = await sendOpenAiCompatible(requestBody.body);
          } catch (error) {
            if (error?.name === 'AbortError') throw abortError();
            throw providerError('RECURSION_PROVIDER_TRANSPORT_FAILED', 'Provider transport failed.', {
              retryable: true,
              cause: error
            });
          }
        }
      }
    }

    if (!response?.ok) {
      const status = Number(response?.status || 0);
      if (status === 401 || status === 403) {
        markOpenAiAuthFailure(settingsStore, enriched.lane);
        throw providerError('RECURSION_PROVIDER_AUTH_FAILED', 'OpenAI-compatible authentication failed.', {
          retryable: false,
          status
        });
      }
      throw providerError('RECURSION_PROVIDER_HTTP_ERROR', `Provider request failed with HTTP ${status || 'error'}.`, {
        retryable: status === 429 || (status >= 500 && status < 600),
        status
      });
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw providerError('RECURSION_PROVIDER_RESPONSE_JSON_INVALID', 'Provider response was not valid JSON.', {
        retryable: false,
        cause: error
      });
    }
    return normalizeProviderResponse({
      text: parseOpenAiText(payload, enriched),
      providerId: 'openai-compatible',
      model: payload?.model || model,
      responseId: payload?.id || '',
      ...requestBody.reasoningDiagnostics
    }, enriched);
  }

  async function batch(requests = [], options = {}) {
    const normalized = requests.map((entry) => normalizeBatchRequest(entry));
    const enriched = normalized.map(({ roleId, request }) => enrich(roleId, request));
    const onSlotSettled = typeof options?.onSlotSettled === 'function' ? options.onSlotSettled : null;

    function normalizeHostBatchSlot(response, index, batchDiagnostics = {}) {
      const responseObject = response && typeof response === 'object' && !Array.isArray(response)
        ? response
        : { text: String(response ?? '') };
      if (responseObject.ok === false && responseObject.error) {
        return normalizeProviderSlotFailure(responseObject, enriched[index], batchDiagnostics);
      }
      return normalizeProviderResponse({ ...batchDiagnostics, ...responseObject }, enriched[index]);
    }

    function notifyClientSlotSettled(index, response, batchDiagnostics = {}) {
      if (!onSlotSettled) return;
      if (!Number.isInteger(index) || index < 0 || index >= enriched.length) return;
      let normalizedResponse;
      try {
        normalizedResponse = normalizeHostBatchSlot(response, index, batchDiagnostics);
      } catch (error) {
        normalizedResponse = normalizeProviderSlotFailure({ ok: false, error }, enriched[index], batchDiagnostics);
      }
      safeInvoke(() => onSlotSettled({
        index,
        roleId: normalized[index].roleId,
        request: enriched[index],
        response: normalizedResponse
      }));
    }

    const canUseHostBatch = typeof host?.generation?.batch === 'function'
      && enriched.every((request) => HOST_SOURCES.has(request.providerSource));

    if (canUseHostBatch) {
      const batchDiagnostics = batchCapabilityDiagnostics(host.generation.capabilities?.batch);
      const responses = await host.generation.batch(enriched, {
        onSlotSettled: (slot = {}) => {
          const index = Number(slot.index);
          const response = Object.prototype.hasOwnProperty.call(slot, 'response')
            ? slot.response
            : (Object.prototype.hasOwnProperty.call(slot, 'result') ? slot.result : slot.value);
          notifyClientSlotSettled(index, response, batchDiagnostics);
        }
      });
      if (!Array.isArray(responses) || responses.length !== enriched.length) {
        throw providerError('RECURSION_PROVIDER_BATCH_INVALID', 'Host batch response shape did not match request batch.', {
          retryable: false
        });
      }
      return responses.map((response, index) => normalizeHostBatchSlot(response, index, batchDiagnostics));
    }

    return Promise.all(normalized.map(({ roleId, request }, index) => generate(roleId, request)
      .then((response) => {
        notifyClientSlotSettled(index, response);
        return response;
      }, (error) => {
        notifyClientSlotSettled(index, { ok: false, error });
        throw error;
      })));
  }

  function listProfiles(options = {}) {
    return listProviderConnectionProfiles({ ...options, host });
  }

  function status(lane = 'utility', options = {}) {
    const resolvedLane = laneName(lane);
    const { config } = providerConfigFor(settingsStore, resolvedLane);
    return providerModelStatus(config, {
      ...options,
      host,
      apiKey: settingsStore?.getApiKey?.(resolvedLane) || options.apiKey || ''
    });
  }

  async function fetchModels(lane = 'utility', patch = {}) {
    const resolvedLane = laneName(lane);
    const { config } = providerConfigFor(settingsStore, resolvedLane);
    const cleanPatch = plainObject(patch) ? patch : {};
    const provider = {
      ...config,
      ...cleanPatch,
      openAICompatible: {
        ...(config.openAICompatible || {}),
        ...(plainObject(cleanPatch.openAICompatible) ? cleanPatch.openAICompatible : {})
      }
    };
    if (sourceName(provider.source) !== 'openai-compatible') {
      throw providerError(
        'RECURSION_PROVIDER_MODEL_DISCOVERY_UNSUPPORTED',
        'Model discovery is only available for OpenAI-compatible endpoints.',
        { retryable: false }
      );
    }
    return fetchOpenAICompatibleModels({
      baseUrl: provider.openAICompatible?.baseUrl,
      apiKey: cleanPatch.apiKey || settingsStore?.getApiKey?.(resolvedLane) || '',
      fetchImpl,
      signal: cleanPatch.signal
    });
  }

  return { generate, batch, listProfiles, status, fetchModels };
}

export function createGenerationRouter({ client, activity = null, journal = null, timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS, isCurrent = null } = {}) {
  if (!client || typeof client.generate !== 'function') {
    throw new Error('createGenerationRouter requires a client with generate(roleId, request).');
  }

  let journalQueue = Promise.resolve();
  function queueJournalAppend(entry) {
    const write = journalQueue.then(() => journalAppend(journal, entry));
    journalQueue = write.catch(() => {});
    return write;
  }

  function retryFreshnessGuard(options = {}) {
    return options.isRetryCurrent || options.isCurrent || isCurrent;
  }

  async function checkRetryFreshness(context, options = {}, signals = []) {
    if (signals.some((signal) => signal?.aborted === true)) {
      return { ok: false, reason: 'aborted' };
    }
    const guard = retryFreshnessGuard(options);
    if (typeof guard !== 'function') return { ok: true };
    try {
      const current = await guard(sanitize(context, 300));
      if (current === false) return { ok: false, reason: 'stale-current-guard' };
      return { ok: true };
    } catch {
      return { ok: false, reason: 'current-guard-failed' };
    }
  }

  async function generate(roleId, request = {}, options = {}) {
    const providerRoleKnown = isProviderRole(roleId);
    const lane = laneName(requestLane(roleId, request));
    const started = Date.now();
    const startedAt = nowIso();
    const effectiveTimeoutMs = options.timeoutMs ?? timeoutMs;
    let runId = String(options.runId || request.runId || makeId('provider'));
    let retryCount = 0;
    let retryFormatError = null;
    let structuredRecoverySpent = options.allowStructuredRecovery === false;
    let structuredOutputRecovery = '';
    let lastDiagnostics = diagnosticsBase({ roleId, lane, request, runId, startedAt, timeoutMs: effectiveTimeoutMs });

    const activityRunId = activityStart(activity, {
      runId,
      phase: 'providerCallStarted',
      mode: 'background',
      severity: 'info',
      providerLane: lane,
      composerLane: lane === 'reasoner' ? 'reasoner' : 'utility',
      label: `${lane === 'reasoner' ? 'Reasoner' : 'Utility'} provider call started.`,
      detail: lastDiagnostics
    });
    if (options.lockRunId !== true) runId = activityRunId || runId;
    lastDiagnostics = diagnosticsBase({ roleId, lane, request, runId, startedAt, timeoutMs: effectiveTimeoutMs });
    queueJournalAppend({
      ...lastDiagnostics,
      status: 'started',
      recordedAt: nowIso()
    });

    const composedExternalSignal = composeAbortSignal([options.signal, request.signal]);
    try {
      let raw = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const attemptRequest = attempt === 0
          ? request
          : requestWithStructuredRetryPrompt(request, { roleId, error: retryFormatError });
        activityStage(activity, {
          runId,
          phase: attempt === 0 ? 'providerCallRunning' : 'providerCallRetrying',
          severity: attempt === 0 ? 'info' : 'warning',
          providerLane: lane,
          composerLane: lane === 'reasoner' ? 'reasoner' : 'utility',
          label: attempt === 0 ? 'Provider call running.' : 'Retrying provider call.',
          detail: { roleId, lane, attempt }
        });

        try {
          if (!providerRoleKnown) throw unsupportedRoleError(roleId);
          raw = await withTimeout(
            (requestWithSignal) => client.generate(roleId, requestWithSignal),
            attemptRequest,
            effectiveTimeoutMs,
            composedExternalSignal.signal || null
          );
          const parsed = parseProviderStructuredOutput(raw.text);
          const data = normalizeRoleResponseEnvelope(roleId, parsed.data, attemptRequest);
          validateRoleResponseSchema(roleId, data);
          const latencyMs = Date.now() - started;
          const diagnostics = sanitize({
            ...lastDiagnostics,
            ...parsed.diagnostics,
            ...reasoningDiagnostics(raw),
            providerSource: raw.providerSource,
            providerId: raw.providerId,
            model: raw.model,
            responseId: raw.responseId,
            responseHash: responseTextHash(raw.text),
            schema: data.schema,
            retryCount,
            ...(structuredOutputRecovery ? { structuredOutputRecovery } : {}),
            latencyMs,
            completedAt: nowIso()
          }, 300);

          await queueJournalAppend({
            ...diagnostics,
            status: 'success',
            recordedAt: nowIso()
          });
          activitySettle(activity, {
            runId,
            phase: 'settled',
            outcome: 'success',
            providerLane: lane,
            composerLane: lane === 'reasoner' ? 'reasoner' : 'utility',
            label: 'Provider call completed.',
            detail: diagnostics
          });

          return {
            ok: true,
            roleId,
            lane,
            data,
            text: JSON.stringify(data),
            diagnostics,
            recoverySpent: structuredRecoverySpent
          };
        } catch (error) {
          const structuredRecoveryKind = structuredOutputRecoveryKind(error, attemptRequest);
          const structuredRetry = Boolean(structuredRecoveryKind);
          const canRetry = attempt === 0 && (retryableError(error) || (structuredRetry && options.allowStructuredRecovery !== false));
          let retrySkippedReason = '';
          const latencyMs = Date.now() - started;
          if (canRetry) {
            const retryFreshness = await checkRetryFreshness({
              roleId,
              lane,
              runId,
              attempt: attempt + 1,
              batch: false,
              retryCount: retryCount + 1,
              error: sanitizedError(error, request),
              request: cleanRequestForDiagnostics(request)
            }, options, [options.signal, request.signal]);
            if (retryFreshness.ok) {
              retryCount = 1;
              retryFormatError = structuredRetry ? error : null;
              if (structuredRetry) {
                structuredRecoverySpent = true;
                structuredOutputRecovery = structuredRecoveryKind;
              }
              continue;
            }
            retrySkippedReason = retryFreshness.reason;
          }
          lastDiagnostics = sanitize({
            ...lastDiagnostics,
            ...providerFailureDiagnostics(error),
            retryCount,
            latencyMs,
            error: sanitizedError(error, request),
            failedAt: nowIso(),
            ...(retrySkippedReason ? { retrySkippedReason } : {})
          }, 300);

          const safeError = sanitizedError(error, request);
          const diagnostics = sanitize({
            ...lastDiagnostics,
            retryCount,
            ...(structuredOutputRecovery ? { structuredOutputRecovery } : {}),
            error: safeError,
            status: statusForError(error)
          }, 300);
          await queueJournalAppend({
            ...diagnostics,
            status: statusForError(error),
            recordedAt: nowIso()
          });
          activitySettle(activity, {
            runId,
            phase: 'settled',
            outcome: 'error',
            providerLane: lane,
            composerLane: lane === 'reasoner' ? 'reasoner' : 'utility',
            label: 'Provider call failed.',
            detail: diagnostics
          });

          return {
            ok: false,
            roleId,
            lane,
            error: safeError,
            diagnostics,
            recoverySpent: structuredRecoverySpent,
            recoverableText: roleId === 'fusedCardBundle' ? truncate(String(raw?.text || ''), 12000) : ''
          };
        }
      }
    } finally {
      composedExternalSignal.cleanup();
    }

    return {
      ok: false,
      roleId,
      lane,
      error: { code: 'RECURSION_PROVIDER_FAILED', message: 'Provider generation failed.', retryable: false },
      diagnostics: lastDiagnostics,
      recoverySpent: structuredRecoverySpent
    };
  }

  async function batch(requests = [], options = {}) {
    const rawRequests = Array.isArray(requests) ? requests : [];
    const batchRunId = String(options.runId || makeId('provider-batch'));
    const effectiveTimeoutMs = options.timeoutMs ?? timeoutMs;
    const results = new Array(rawRequests.length);

    function fallbackBatchRequest(entry) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { roleId: '', request: {} };
      const request = { ...entry };
      const roleId = String(request.roleId || request.role || '').trim();
      delete request.roleId;
      delete request.role;
      return { roleId, request };
    }

    function makeBatchEntry(entry, index) {
      let roleId = '';
      let request = {};
      let normalizationError = null;
      try {
        ({ roleId, request } = normalizeBatchRequest(entry));
      } catch (error) {
        normalizationError = error;
        ({ roleId, request } = fallbackBatchRequest(entry));
      }
      const lane = laneName(requestLane(roleId, request));
      const started = Date.now();
      const startedAt = nowIso();
      const diagnostics = diagnosticsBase({ roleId, lane, request, runId: batchRunId, startedAt, timeoutMs: effectiveTimeoutMs });
      return {
        index,
        roleId,
        request,
        lane,
        started,
        startedAt,
        diagnostics,
        providerRoleKnown: isProviderRole(roleId),
        normalizationError
      };
    }

    async function failureResult(entry, error, retryCount = 0, extraDiagnostics = {}) {
      const safeError = sanitizedError(error, entry.request);
      const diagnostics = sanitize({
        ...entry.diagnostics,
        retryCount,
        latencyMs: Date.now() - entry.started,
        error: safeError,
        status: statusForError(error),
        failedAt: nowIso(),
        ...extraDiagnostics
      }, 300);
      await queueJournalAppend({
        ...diagnostics,
        status: statusForError(error),
        recordedAt: nowIso()
      });
      return {
        ok: false,
        roleId: entry.roleId,
        lane: entry.lane,
        error: safeError,
        diagnostics
      };
    }

    if (typeof client.batch !== 'function') {
      const entries = rawRequests.map(makeBatchEntry);
      for (const entry of entries) {
        if (entry.normalizationError) {
          results[entry.index] = await failureResult(entry, entry.normalizationError);
          continue;
        }
        results[entry.index] = await generate(entry.roleId, entry.request, {
          ...options,
          runId: batchRunId,
          lockRunId: true
        });
      }
      return results;
    }

    const entries = rawRequests.map((entry, index) => {
      const batchEntry = makeBatchEntry(entry, index);
      activityStart(activity, {
        runId: batchRunId,
        phase: 'providerCallStarted',
        mode: 'background',
        severity: 'info',
        providerLane: batchEntry.lane,
        composerLane: batchEntry.lane === 'reasoner' ? 'reasoner' : 'utility',
        label: `${batchEntry.lane === 'reasoner' ? 'Reasoner' : 'Utility'} provider batch call started.`,
        detail: batchEntry.diagnostics
      });
      return batchEntry;
    });

    function throwSlotFailure(raw) {
      if (raw?.slotError) {
        throw providerError(
          raw.slotError.code || 'RECURSION_PROVIDER_BATCH_SLOT_FAILED',
          raw.slotError.message || 'Provider batch slot failed.',
          {
            retryable: raw.slotError.retryable === true,
            status: raw.slotError.status
          }
        );
      }
    }

    async function successResult(entry, raw, retryCount = 0, extraDiagnostics = {}) {
      throwSlotFailure(raw);
      const parsed = parseProviderStructuredOutput(raw?.text);
      const data = normalizeRoleResponseEnvelope(entry.roleId, parsed.data, entry.request);
      validateRoleResponseSchema(entry.roleId, data);
      const diagnostics = sanitize({
        ...entry.diagnostics,
        ...parsed.diagnostics,
        ...reasoningDiagnostics(raw),
        providerSource: raw?.providerSource,
        providerId: raw?.providerId,
        model: raw?.model,
        responseId: raw?.responseId,
        responseHash: responseTextHash(raw?.text),
        schema: data.schema,
        ...batchDiagnosticsFromResponse(raw),
        retryCount,
        ...extraDiagnostics,
        latencyMs: Date.now() - entry.started,
        completedAt: nowIso()
      }, 300);

      await queueJournalAppend({
        ...diagnostics,
        status: 'success',
        recordedAt: nowIso()
      });

      return {
        ok: true,
        roleId: entry.roleId,
        lane: entry.lane,
        data,
        text: JSON.stringify(data),
        diagnostics
      };
    }

    const settledActivitySlots = new Set();

    function emitSlotActivity(entry, event, { force = false } = {}) {
      if (!entry) return;
      const key = String(entry.index);
      if (!force && settledActivitySlots.has(key)) return;
      settledActivitySlots.add(key);
      activityStage(activity, {
        runId: batchRunId,
        phase: 'providerCallSettled',
        severity: event.severity,
        outcome: event.outcome,
        providerLane: entry.lane,
        composerLane: entry.lane === 'reasoner' ? 'reasoner' : 'utility',
        label: event.label,
        detail: event.detail
      });
    }

    function emitSlotSuccessActivity(entry, raw, retryCount = 0) {
      const parsed = parseProviderStructuredOutput(raw?.text);
      const data = normalizeRoleResponseEnvelope(entry.roleId, parsed.data, entry.request);
      validateRoleResponseSchema(entry.roleId, data);
      emitSlotActivity(entry, {
        severity: retryCount > 0 ? 'warning' : 'success',
        outcome: retryCount > 0 ? 'warning' : 'success',
        label: retryCount > 0 ? 'Provider batch slot completed after retry.' : 'Provider batch slot completed.',
        detail: sanitize({
          ...entry.diagnostics,
          ...parsed.diagnostics,
          ...reasoningDiagnostics(raw),
          providerSource: raw?.providerSource,
          providerId: raw?.providerId,
          model: raw?.model,
          responseId: raw?.responseId,
          responseHash: responseTextHash(raw?.text),
          schema: data.schema,
          ...batchDiagnosticsFromResponse(raw),
          retryCount,
          latencyMs: Date.now() - entry.started,
          completedAt: nowIso(),
          batchIndex: entry.index
        }, 300)
      });
    }

    function emitSlotFailureActivity(entry, error, raw = null, retryCount = 0, options = {}) {
      const safeError = sanitizedError(error, entry.request);
      emitSlotActivity(entry, {
        severity: 'error',
        outcome: 'error',
        label: 'Provider batch slot failed.',
        detail: sanitize({
          ...entry.diagnostics,
          ...batchDiagnosticsFromResponse(raw),
          retryCount,
          latencyMs: Date.now() - entry.started,
          error: safeError,
          status: statusForError(error),
          failedAt: nowIso(),
          batchIndex: entry.index
        }, 300)
      }, options);
    }

    function emitSlotSettledActivity(entry, raw, retryCount = 0) {
      try {
        throwSlotFailure(raw);
        emitSlotSuccessActivity(entry, raw, retryCount);
      } catch (error) {
        emitSlotFailureActivity(entry, error, raw, retryCount);
      }
    }

    function settleBatchActivity() {
      if (!results.length) return;
      const completed = results.filter(Boolean);
      const failed = completed.filter((entry) => entry.ok === false).length;
      const succeeded = completed.filter((entry) => entry.ok === true).length;
      const outcome = failed === 0 ? 'success' : (succeeded > 0 ? 'warning' : 'error');
      const representative = completed.find((entry) => entry.ok === false) || completed[0];
      activitySettle(activity, {
        runId: batchRunId,
        phase: 'settled',
        outcome,
        providerLane: representative?.lane || null,
        composerLane: representative?.lane === 'reasoner' ? 'reasoner' : 'utility',
        label: failed === 0 ? 'Provider batch call completed.' : 'Provider batch completed with warnings.',
        detail: {
          total: completed.length,
          succeeded,
          failed
        }
      });
    }

    const pendingEntries = [];
    for (const entry of entries) {
      if (entry.normalizationError) {
        results[entry.index] = await failureResult(entry, entry.normalizationError);
        continue;
      }
      if (!entry.providerRoleKnown) {
        results[entry.index] = await failureResult(entry, unsupportedRoleError(entry.roleId));
        continue;
      }
      if (entry.request.signal?.aborted) {
        results[entry.index] = await failureResult(entry, abortError());
        continue;
      }
      pendingEntries.push(entry);
      queueJournalAppend({
        ...entry.diagnostics,
        status: 'started',
        recordedAt: nowIso()
      });
      activityStage(activity, {
        runId: batchRunId,
        phase: 'providerCallRunning',
        severity: 'info',
        providerLane: entry.lane,
        composerLane: entry.lane === 'reasoner' ? 'reasoner' : 'utility',
        label: 'Provider batch call running.',
        detail: { roleId: entry.roleId, lane: entry.lane, batchIndex: entry.index }
      });
    }

    if (pendingEntries.length === 0) {
      settleBatchActivity();
      return results;
    }

    let rawResponses;
    let batchRetryCount = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        rawResponses = await withBatchTimeout(
          (requestsWithSignals) => client.batch(requestsWithSignals, {
            onSlotSettled: (slot = {}) => {
              const batchIndex = Number(slot.index);
              if (!Number.isInteger(batchIndex) || batchIndex < 0 || batchIndex >= pendingEntries.length) return;
              const raw = Object.prototype.hasOwnProperty.call(slot, 'response')
                ? slot.response
                : (Object.prototype.hasOwnProperty.call(slot, 'result') ? slot.result : slot.value);
              emitSlotSettledActivity(pendingEntries[batchIndex], raw, batchRetryCount);
            }
          }),
          pendingEntries.map((entry) => ({ roleId: entry.roleId, ...entry.request })),
          effectiveTimeoutMs,
          options.signal || null
        );
        if (!Array.isArray(rawResponses) || rawResponses.length !== pendingEntries.length) {
          throw providerError('RECURSION_PROVIDER_BATCH_INVALID', 'Provider batch response shape did not match request batch.', {
            retryable: false
          });
        }
        break;
      } catch (error) {
        const canRetry = attempt === 0 && retryableError(error);
        let retrySkippedReason = '';
        if (canRetry) {
          const retryFreshness = await checkRetryFreshness({
            runId: batchRunId,
            attempt: attempt + 1,
            batch: true,
            retryCount: batchRetryCount + 1,
            error: sanitizedBatchError(error, pendingEntries),
            entries: pendingEntries.map((entry) => ({
              index: entry.index,
              roleId: entry.roleId,
              lane: entry.lane,
              request: cleanRequestForDiagnostics(entry.request)
            }))
          }, options, [options.signal, ...pendingEntries.map((entry) => entry.request.signal)]);
          if (!retryFreshness.ok) {
            retrySkippedReason = retryFreshness.reason;
          }
        }
        if (canRetry && !retrySkippedReason) {
          batchRetryCount = 1;
          activityStage(activity, {
            runId: batchRunId,
            phase: 'providerCallRetrying',
            severity: 'warning',
            providerLane: pendingEntries[0]?.lane || 'utility',
            composerLane: pendingEntries[0]?.lane === 'reasoner' ? 'reasoner' : 'utility',
            label: 'Retrying provider batch call.',
            detail: { attempt: 1 }
          });
          continue;
        }
        for (const entry of pendingEntries) {
          results[entry.index] = await failureResult(entry, error, batchRetryCount, retrySkippedReason ? { retrySkippedReason } : {});
          emitSlotFailureActivity(entry, error, null, batchRetryCount, { force: true });
        }
        settleBatchActivity();
        return results;
      }
    }

    const retryCandidates = [];
    for (let batchIndex = 0; batchIndex < rawResponses.length; batchIndex += 1) {
      const raw = rawResponses[batchIndex];
      const entry = pendingEntries[batchIndex];
      try {
        results[entry.index] = await successResult(entry, raw, batchRetryCount);
        emitSlotSettledActivity(entry, raw, batchRetryCount);
      } catch (error) {
        const structuredOutputRecovery = structuredOutputRecoveryKind(error, entry.request);
        if (structuredOutputRecovery && options.allowStructuredRecovery !== false && entry.request.signal?.aborted !== true) {
          retryCandidates.push({ entry, error, raw, structuredOutputRecovery });
          continue;
        }
        results[entry.index] = await failureResult(entry, error, batchRetryCount, batchDiagnosticsFromResponse(raw));
        emitSlotFailureActivity(entry, error, raw, batchRetryCount, { force: true });
      }
    }

    if (retryCandidates.length) {
      const retryFreshness = await checkRetryFreshness({
        runId: batchRunId,
        attempt: 1,
        batch: true,
        retryCount: 1,
        entries: retryCandidates.map(({ entry, error }) => ({
          index: entry.index,
          roleId: entry.roleId,
          lane: entry.lane,
          error: sanitizedError(error, entry.request),
          request: cleanRequestForDiagnostics(entry.request)
        }))
      }, options, [options.signal, ...retryCandidates.map(({ entry }) => entry.request.signal)]);
      if (retryFreshness.ok) {
        try {
          const retriedRaw = await withBatchTimeout(
            (requestsWithSignals) => client.batch(requestsWithSignals),
            retryCandidates.map(({ entry, error }) => ({
              roleId: entry.roleId,
              ...requestWithStructuredRetryPrompt(entry.request, { roleId: entry.roleId, error })
            })),
            effectiveTimeoutMs,
            options.signal || null
          );
          if (!Array.isArray(retriedRaw) || retriedRaw.length !== retryCandidates.length) {
            throw providerError('RECURSION_PROVIDER_BATCH_INVALID', 'Provider correction batch response shape did not match its request batch.', { retryable: false });
          }
          for (let index = 0; index < retryCandidates.length; index += 1) {
            const { entry, structuredOutputRecovery } = retryCandidates[index];
            const raw = retriedRaw[index];
            try {
              results[entry.index] = await successResult(entry, raw, 1, { structuredOutputRecovery });
              emitSlotSettledActivity(entry, raw, 1);
            } catch (error) {
              results[entry.index] = await failureResult(entry, error, 1, {
                ...batchDiagnosticsFromResponse(raw),
                structuredOutputRecovery
              });
              emitSlotFailureActivity(entry, error, raw, 1, { force: true });
            }
          }
        } catch (error) {
          for (const { entry, raw, structuredOutputRecovery } of retryCandidates) {
            results[entry.index] = await failureResult(entry, error, 1, {
              ...batchDiagnosticsFromResponse(raw),
              structuredOutputRecovery
            });
            emitSlotFailureActivity(entry, error, raw, 1, { force: true });
          }
        }
      } else {
        for (const { entry, error, raw, structuredOutputRecovery } of retryCandidates) {
          results[entry.index] = await failureResult(entry, error, batchRetryCount, {
            ...batchDiagnosticsFromResponse(raw),
            structuredOutputRecovery,
            retrySkippedReason: retryFreshness.reason
          });
          emitSlotFailureActivity(entry, error, raw, batchRetryCount, { force: true });
        }
      }
    }

    settleBatchActivity();
    return results;
  }

  return { generate, batch };
}
