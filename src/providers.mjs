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
  assertProviderResponseText,
  getProviderResponseFailure,
  normalizeProviderEnvelope
} from './providers/provider-response-normalizer.mjs';
import {
  STRUCTURED_OUTPUT_PARSE_ERROR_CODES,
  parseStructuredJsonText
} from './providers/structured-output-parser.mjs';
import { createProfileRequestQueue } from './providers/profile-request-queue.mjs';
import { normalizeProviderError } from './providers/provider-errors.mjs';
import { outputBudgetForRequest } from './providers/stage-output-budgets.mjs';
import { DEFAULT_RECURSION_SETTINGS } from './settings.mjs';
import {
  resolveProviderCapability,
  effectiveProfileConcurrency
} from './provider-capability.mjs';
import {
  EDITORIAL_EFFECTIVENESS_SCHEMA,
  REDIRECT_EFFECTIVENESS_CRITERIA,
  REDIRECT_FAILURE_CATEGORIES,
  REDIRECT_VERIFICATION_CHECKS
} from './editorial-transform.mjs';
import { providerFailure } from './failures.mjs';
import {
  POST_PROCESS_GUIDANCE_JSON_SCHEMA,
  POST_PROCESS_GUIDANCE_SCHEMA,
  normalizePostProcessGuidanceResponse
} from './post-process-guidance.mjs';

const LANES = new Set(['utility', 'reasoner']);
const EDITORIAL_PATCH_DOMAINS = new Set([
  'dialogue',
  'narrative-execution',
  'anti-slop',
  'card-fidelity'
]);
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
  'guidanceComposer',
  'cardAuthoringAssist',
  'generationReviewer',
  'editorialDiagnostician',
  'editorialTransformer',
  'editorialVerifier',
  'editorialEffectivenessJudge',
  'postProcessGuidanceUtility',
  'providerTest'
]);
export const REASONER_ROLE_IDS = Object.freeze(['reasonerComposer', 'postProcessGuidanceReasoner']);
export const PROVIDER_CONTRACT_VERSION = 9;
const ROLE_RESPONSE_SCHEMAS = Object.freeze({
  utilityArbiter: 'recursion.utilityArbiter.v1',
  sceneFrameCard: 'recursion.cardPayload.v1',
  activeCastCard: 'recursion.cardPayload.v1',
  characterMotivationCard: 'recursion.cardPayload.v1',
  dialogueRelationshipCard: 'recursion.cardPayload.v1',
  socialSubtextCard: 'recursion.cardPayload.v1',
  sceneConstraintsCard: 'recursion.cardPayload.v1',
  knowledgeSecretsCard: 'recursion.cardPayload.v1',
  clocksConsequencesCard: 'recursion.cardPayload.v1',
  environmentAffordancesCard: 'recursion.cardPayload.v1',
  possessionsItemsCard: 'recursion.cardPayload.v1',
  openThreadsCard: 'recursion.cardPayload.v1',
  fusedCardBundle: 'recursion.cardBundlePayload.v1',
  guidanceComposer: 'recursion.guidanceComposer.v1',
  cardAuthoringAssist: 'recursion.cardAuthoringAssist.v1',
  generationReviewer: 'recursion.generationReview.v1',
  editorialDiagnostician: 'recursion.editorialDiagnosis.v1',
  editorialTransformer: 'recursion.editorialPass.v1',
  editorialVerifier: 'recursion.editorialVerification.v1',
  editorialEffectivenessJudge: EDITORIAL_EFFECTIVENESS_SCHEMA,
  postProcessGuidanceUtility: POST_PROCESS_GUIDANCE_SCHEMA,
  reasonerComposer: 'recursion.reasonerComposer.v1',
  postProcessGuidanceReasoner: POST_PROCESS_GUIDANCE_SCHEMA,
  providerTest: 'recursion.providerTest.v1'
});
const SEGMENTED_CARD_ROLES = new Set(
  Object.entries(ROLE_RESPONSE_SCHEMAS)
    .filter(([, schema]) => schema === 'recursion.cardPayload.v1')
    .map(([roleId]) => roleId)
);
export const PROVIDER_CONTRACT_HASH = hashJson({
  providerContractVersion: PROVIDER_CONTRACT_VERSION,
  utilityRoles: UTILITY_ROLE_IDS,
  reasonerRoles: REASONER_ROLE_IDS,
  responseSchemas: ROLE_RESPONSE_SCHEMAS
});
const UTILITY_ROLES = new Set(UTILITY_ROLE_IDS);
const REASONER_ROLES = new Set(REASONER_ROLE_IDS);
const SECRET_TEXT_PATTERN = /(sk-[a-z0-9_-]+|bearer\s+[a-z0-9._-]+|session-key|secret[-_\s]*value|private[-_\s]*key[-_\s]*material)/ig;
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

function laneName(value, fallback = 'utility') {
  const lane = String(value || '').trim();
  return LANES.has(lane) ? lane : fallback;
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

function providerCapabilityHost(host = null) {
  return {
    connectionProfiles: listProviderConnectionProfiles({ host })
  };
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

function hasAdjacentRepeatedWord(value = '') {
  const source = String(value || '');
  const match = source.match(/\b([\p{L}\p{N}'’-]+)\s+\1\b/iu);
  return Boolean(match);
}

const AMBIGUOUS_ADJACENT_REPEAT_TOKENS = new Set([
  'had', 'that', 'is', 'was', 'were', 'do', 'did', 'very', 'no', 'yes', 'bye', 'go'
]);

function removeDeterministicAdjacentRepeatedWords(value = '') {
  return String(value).replace(/\b([\p{L}\p{N}'’-]+)\s+\1\b/giu, (match, token) => (
    AMBIGUOUS_ADJACENT_REPEAT_TOKENS.has(String(token).toLowerCase()) ? match : token
  ));
}

function indicatesAdjacentRepeatDefect(value) {
  let serialized = '';
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value ?? '');
  }
  const bounded = serialized.slice(0, 6000);
  return /\b(?:adjacent(?:ly)?\s+)?(?:duplicate(?:d)?|repeat(?:ed|ing)?|repetition|double(?:d)?|redundan\w*|typo(?:graphical)?|extra\s+(?:word|token)|(?:wording|copy)\s+error)\b/iu.test(bounded)
    || /\b(?:word|token)\b.{0,40}\btwice\b/iu.test(bounded);
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

function redirectPressureSchema(validEvidenceIds) {
  const optionalEvidenceRefs = (values) => ({
    ...editorialEvidenceRefsSchema(values),
    minItems: 0
  });
  const properties = {
    character: { type: 'string' },
    immediateWant: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    wantEvidenceRefs: optionalEvidenceRefs(validEvidenceIds),
    sourcePressureEffect: { type: 'string' },
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
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false
  };
}

function redirectDiagnosisProperties(validEvidenceIds) {
  const evidenceRefs = editorialEvidenceRefsSchema(validEvidenceIds);
  const optionalEvidenceRefs = { ...evidenceRefs, minItems: 0 };
  return {
    sourceFailure: {
      type: 'object',
      properties: {
        category: { enum: [...REDIRECT_FAILURE_CATEGORIES] },
        problem: { type: 'string' },
        establishedEvidenceRefs: evidenceRefs,
        conflictingSourceRefs: evidenceRefs
      },
      required: ['category', 'problem', 'establishedEvidenceRefs', 'conflictingSourceRefs'],
      additionalProperties: false
    },
    replacementObjective: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        evidenceRefs
      },
      required: ['summary', 'evidenceRefs'],
      additionalProperties: false
    },
    requiredBeats: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        properties: { summary: { type: 'string' }, evidenceRefs },
        required: ['summary', 'evidenceRefs'],
        additionalProperties: false
      }
    },
    forbiddenSourceBeats: {
      type: 'array',
      minItems: 1,
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
        properties: { character: { type: 'string' }, evidenceRefs: optionalEvidenceRefs },
        required: ['character', 'evidenceRefs'],
        additionalProperties: false
      }
    },
    characterPressure: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: redirectPressureSchema(validEvidenceIds)
    }
  };
}

function editorialBriefSchema(mode, validEvidenceIds, validPreservationEvidenceIds = validEvidenceIds) {
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
      forbiddenChanges: { type: 'array', maxItems: 12, items: { type: 'string' } }
    },
    required: ['mode', 'diagnosis', 'preserve', 'discard', 'allowedChanges', 'forbiddenChanges'],
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

export function jsonSchemaForRequest(request = {}) {
  const schema = String(request?.responseSchema || '').trim();
  if (!schema) return null;
  if (schema === 'recursion.cardPayload.v1') {
    return {
      name: schemaSafeName(schema),
      schema: {
        type: 'object',
        properties: {
          promptText: { type: 'string', minLength: 1 },
          evidenceRefs: {
            type: 'array',
            minItems: 1,
            maxItems: 12,
            items: { type: 'string' }
          }
        },
        required: ['promptText', 'evidenceRefs'],
        additionalProperties: false
      }
    };
  }
  if (schema === 'recursion.cardBundlePayload.v1') {
    const requestedFamilies = uniqueRequestStrings(
      (Array.isArray(request?.requestedCards) ? request.requestedCards : [])
        .map((entry) => entry?.family)
    );
    return {
      name: schemaSafeName(schema),
      schema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            minItems: 0,
            maxItems: Math.max(1, requestedFamilies.length || 12),
            items: {
              type: 'object',
              properties: {
                family: requestedFamilies.length ? { enum: requestedFamilies } : { type: 'string' },
                promptText: { type: 'string', minLength: 1 },
                evidenceRefs: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 12,
                  items: { type: 'string' }
                },
                coveredSourceCardIds: {
                  type: 'array',
                  maxItems: 32,
                  uniqueItems: true,
                  items: { type: 'string' }
                }
              },
              required: ['family', 'promptText', 'evidenceRefs'],
              additionalProperties: false
            }
          }
        },
        required: ['items'],
        additionalProperties: false
      }
    };
  }
  if (schema === POST_PROCESS_GUIDANCE_SCHEMA) {
    return {
      name: schemaSafeName(schema),
      schema: POST_PROCESS_GUIDANCE_JSON_SCHEMA
    };
  }
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
    const validSourceEvidenceIds = uniqueRequestStrings(request?.validSourceEvidenceIds);
    const decisions = mode === 'redirect'
      ? ['proceed']
      : mode === 'recompose'
        ? ['proceed', 'no-change', 'requires-redirect']
        : ['proceed', 'no-change', 'requires-recompose', 'requires-redirect'];
    const identityProperties = {
      schema: { const: schema },
      mode: mode ? { const: mode } : { enum: ['repair', 'recompose', 'redirect'] },
      sourceHash: sourceHash ? { const: sourceHash } : { type: 'string' },
      snapshotHash: snapshotHash ? { const: snapshotHash } : { type: 'string' },
      decision: { enum: decisions }
    };
    if (mode === 'redirect') {
      const redirectProperties = redirectDiagnosisProperties(validEvidenceIds);
      return {
        name: schemaSafeName(schema),
        schema: {
          type: 'object',
          properties: {
            ...identityProperties,
            ...redirectProperties
          },
          required: [
            'schema',
            'mode',
            'sourceHash',
            'snapshotHash',
            'decision',
            ...Object.keys(redirectProperties)
          ],
          additionalProperties: false
        }
      };
    }
    return {
      name: schemaSafeName(schema),
      schema: {
        type: 'object',
        properties: {
          ...identityProperties,
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
    const identityProperties = {
      schema: { const: schema },
      mode: mode ? { const: mode } : { enum: ['repair', 'recompose', 'redirect'] },
      sourceHash: sourceHash ? { const: sourceHash } : { type: 'string' },
      snapshotHash: snapshotHash ? { const: snapshotHash } : { type: 'string' },
      diagnosisHash: diagnosisHash ? { const: diagnosisHash } : { type: 'string' }
    };
    if (mode === 'redirect') {
      return {
        name: schemaSafeName(schema),
        schema: {
          type: 'object',
          properties: {
            ...identityProperties,
            text: { type: 'string' }
          },
          required: ['schema', 'mode', 'sourceHash', 'snapshotHash', 'diagnosisHash', 'text'],
          additionalProperties: false
        }
      };
    }
    const properties = {
      ...identityProperties,
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
    const mode = ['repair', 'recompose', 'redirect'].includes(String(request?.mode || '').trim())
      ? String(request.mode).trim()
      : '';
    const sourceHash = String(request?.sourceHash || '').trim();
    const snapshotHash = String(request?.snapshotHash || '').trim();
    const diagnosisHash = String(request?.diagnosisHash || '').trim();
    const candidateHash = String(request?.candidateHash || '').trim();
    const validEvidenceIds = uniqueRequestStrings(request?.validEvidenceIds);
    const identityProperties = {
      schema: { const: schema },
      mode: mode ? { const: mode } : { enum: ['repair', 'recompose', 'redirect'] },
      sourceHash: sourceHash ? { const: sourceHash } : { type: 'string' },
      snapshotHash: snapshotHash ? { const: snapshotHash } : { type: 'string' },
      diagnosisHash: diagnosisHash ? { const: diagnosisHash } : { type: 'string' },
      candidateHash: candidateHash ? { const: candidateHash } : { type: 'string' }
    };
    if (mode === 'repair') {
      const installedCardIds = uniqueRequestStrings(request?.installedCardIds);
      return {
        name: schemaSafeName(schema),
        schema: {
          type: 'object',
          properties: {
            ...identityProperties,
            failedCardIds: {
              type: 'array',
              minItems: 0,
              maxItems: installedCardIds.length,
              uniqueItems: true,
              items: requestStringSchema(installedCardIds)
            },
            reason: { type: 'string' }
          },
          required: [
            'schema', 'mode', 'sourceHash', 'snapshotHash', 'diagnosisHash', 'candidateHash', 'failedCardIds', 'reason'
          ],
          additionalProperties: false
        }
      };
    }
    if (mode === 'redirect') {
      return {
        name: schemaSafeName(schema),
        schema: {
          type: 'object',
          properties: {
            ...identityProperties,
            failedChecks: {
              type: 'array',
              minItems: 0,
              maxItems: REDIRECT_VERIFICATION_CHECKS.length,
              uniqueItems: true,
              items: { enum: [...REDIRECT_VERIFICATION_CHECKS] }
            },
            reason: { type: 'string' }
          },
          required: ['schema', 'mode', 'sourceHash', 'snapshotHash', 'diagnosisHash', 'candidateHash', 'failedChecks', 'reason'],
          additionalProperties: false
        }
      };
    }
    const properties = {
      ...identityProperties,
      decision: { enum: ['accept', 'reject'] },
      evidenceRefs: editorialEvidenceRefsSchema(validEvidenceIds),
      reason: { type: 'string' }
    };
    return {
      name: schemaSafeName(schema),
      schema: {
        type: 'object',
        properties,
        required: [
          'schema', 'mode', 'sourceHash', 'snapshotHash', 'diagnosisHash', 'candidateHash', 'decision'
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

function responseStructure(value) {
  if (!plainObject(value)) return [];
  return Object.keys(value)
    .filter((key) => /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(key))
    .sort()
    .slice(0, 24)
    .map((key) => {
      const child = value[key];
      if (Array.isArray(child)) return `${key}:array(${Math.min(child.length, 999)})`;
      if (plainObject(child)) {
        const fields = Object.keys(child)
          .filter((field) => /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(field))
          .sort()
          .slice(0, 12);
        return `${key}:object(${fields.join(',')})`;
      }
      if (child === null) return `${key}:null`;
      return `${key}:${typeof child}`;
    });
}

function validateCardPayload(data) {
  return plainObject(data)
    && typeof data.promptText === 'string'
    && data.promptText.trim().length > 0
    && Array.isArray(data.evidenceRefs)
    && data.evidenceRefs.length > 0
    && data.evidenceRefs.every((ref) => typeof ref === 'string' && ref.trim().length > 0);
}

function validateCardBundlePayload(data) {
  if (!plainObject(data) || !Array.isArray(data.items)) return false;
  return data.items.every((item) => plainObject(item)
    && typeof item.family === 'string'
    && item.family.trim().length > 0
    && typeof item.promptText === 'string'
    && item.promptText.trim().length > 0
    && Array.isArray(item.evidenceRefs)
    && item.evidenceRefs.length > 0
    && item.evidenceRefs.every((ref) => typeof ref === 'string' && ref.trim().length > 0)
    && (!Object.hasOwn(item, 'coveredSourceCardIds')
      || (Array.isArray(item.coveredSourceCardIds)
        && item.coveredSourceCardIds.every((id) => typeof id === 'string'))));
}

function validateRoleResponseSchema(roleId, data) {
  const expected = expectedResponseSchema(roleId);
  if (!expected) throw unsupportedRoleError(roleId);
  if (SEGMENTED_CARD_ROLES.has(roleId)) {
    if (validateCardPayload(data)) return;
  } else if (roleId === 'fusedCardBundle') {
    if (validateCardBundlePayload(data)) return;
  } else if (String(data?.schema || '').trim() === expected) {
    return;
  }
  const actual = String(data?.schema || '').trim();
  const error = providerError(
    'RECURSION_PROVIDER_SCHEMA_MISMATCH',
    'Provider output schema did not match the requested role.',
    { retryable: false }
  );
  error.roleId = roleId;
  error.expectedSchema = expected;
  error.actualSchema = actual || '(missing)';
  error.responseFields = plainObject(data)
    ? Object.keys(data).filter((key) => /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(key)).sort().slice(0, 24)
    : [];
  error.responseShape = responseStructure(data);
  throw error;
}

function normalizeRepairFailedCardIds(failedCardIds, request = {}) {
  if (!Array.isArray(failedCardIds)) return null;
  const installedCardIds = uniqueRequestStrings(request?.installedCardIds);
  const installed = new Set(installedCardIds);
  const normalized = failedCardIds.map((entry) => {
    const returnedCardId = String(entry || '').trim();
    if (installed.has(returnedCardId)) return returnedCardId;
    if (returnedCardId.startsWith('card:') && installed.has(returnedCardId.slice(5))) {
      return returnedCardId.slice(5);
    }
    if (installed.has(`card:${returnedCardId}`)) return `card:${returnedCardId}`;
    return '';
  });
  if (normalized.some((cardId) => !cardId) || new Set(normalized).size !== normalized.length) return null;
  return normalized;
}

function identityValuesAgree(values, expected) {
  return values
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .every((value) => value === expected);
}

function normalizeNestedCardEnvelope(roleId, data, request = {}) {
  if (!SEGMENTED_CARD_ROLES.has(roleId) || !plainObject(data)) return null;
  if (String(data.schema || '').trim()) return null;
  const envelope = plainObject(data.envelope) ? data.envelope : null;
  const items = Array.isArray(data.items) ? data.items : [];
  const item = items.length === 1 && plainObject(items[0]) ? items[0] : null;
  const metadata = plainObject(request?.metadata) ? request.metadata : {};
  const expectedRole = String(metadata.role || '').trim();
  const expectedFamily = String(metadata.family || '').trim();
  const expectedSnapshotHash = String(request?.snapshotHash || '').trim();
  if (
    !envelope
    || !item
    || expectedRole !== roleId
    || !expectedFamily
    || !expectedSnapshotHash
  ) {
    return null;
  }
  if (!identityValuesAgree(
    [data.schema, envelope.schema, item.schema],
    'recursion.card.v1'
  )) return null;
  if (!identityValuesAgree(
    [data.role, data.roleId, envelope.role, envelope.roleId, item.role, item.roleId],
    expectedRole
  )) return null;
  if (!identityValuesAgree(
    [data.family, envelope.family, item.family],
    expectedFamily
  )) return null;
  if (!identityValuesAgree(
    [data.snapshotHash, envelope.snapshotHash, item.snapshotHash],
    expectedSnapshotHash
  )) return null;
  return {
    data: {
      schema: 'recursion.card.v1',
      snapshotHash: expectedSnapshotHash,
      role: expectedRole,
      family: expectedFamily,
      items
    },
    diagnostics: {
      semanticNormalization: 'nested-card-envelope'
    }
  };
}

function normalizeRoleResponse(roleId, data, request = {}) {
  if (roleId === 'fusedCardBundle' && plainObject(data) && Array.isArray(data.items)) {
    const requested = new Set((request.requestedCards || []).map((card) => card.family));
    const counts = new Map();
    for (const item of data.items) counts.set(item?.family, (counts.get(item?.family) || 0) + 1);
    const rejections = [];
    const items = data.items.filter((item) => {
      const reason = !validateCardBundlePayload({ items: [item] }) ? 'invalid-item-shape'
        : counts.get(item.family) > 1 ? 'duplicate-family'
        : requested.size && !requested.has(item.family) ? 'unrequested-family' : '';
      if (!reason) return true;
      if (rejections.length < 40) rejections.push({ family: String(item?.family || '').slice(0, 120), reason });
      return false;
    });
    return { data: { ...data, items }, diagnostics: { bundleItemRejections: rejections } };
  }
  const nestedCard = normalizeNestedCardEnvelope(roleId, data, request);
  if (nestedCard) return nestedCard;
  return {
    data: normalizeRoleResponseEnvelope(roleId, data, request),
    diagnostics: {}
  };
}

function normalizeRoleResponseEnvelope(roleId, data, request = {}) {
  if (!plainObject(data)) return data;
  if (roleId === 'postProcessGuidanceUtility' || roleId === 'postProcessGuidanceReasoner') {
    return normalizePostProcessGuidanceResponse(data, request);
  }
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
    if (roleId === 'editorialDiagnostician') {
      delete normalized.repairSignals;
      const displacedDecision = String(data.schema || '').trim();
      normalized.schema = expectedResponseSchema(roleId);
      if (mode && mode !== 'redirect' && plainObject(normalized.brief)) {
        normalized.brief = { ...normalized.brief, mode };
      }
      if (mode && mode !== 'redirect') {
        const legalDecisions = mode === 'repair'
          ? new Set(['proceed', 'no-change', 'requires-recompose', 'requires-redirect'])
          : new Set(['proceed', 'no-change', 'requires-redirect']);
        if (!legalDecisions.has(normalized.decision) && legalDecisions.has(displacedDecision)) {
          normalized.decision = displacedDecision;
        } else if (mode === 'repair' && !legalDecisions.has(normalized.decision) && Array.isArray(normalized.decision)) {
          const validEvidenceIds = new Set(uniqueRequestStrings(request?.validEvidenceIds));
          const validTargetIds = new Set(uniqueRequestStrings(request?.validTargetIds));
          const validTargets = new Map(
            (Array.isArray(request?.repairTargets) ? request.repairTargets : [])
              .filter(plainObject)
              .map((entry) => [String(entry.id || ''), entry])
              .filter(([id]) => validTargetIds.has(id))
          );
          const defectList = normalized.decision;
          const displacedDefectList = defectList.length > 0
            && defectList.length <= 12
            && indicatesAdjacentRepeatDefect(defectList)
            && plainObject(normalized.brief)
            && defectList.every((entry) => {
              if (!plainObject(entry)) return false;
              const reason = String(entry.reason || entry.problem || '').trim();
              const evidenceIds = uniqueRequestStrings(
                entry.evidenceRefs
                || [entry.sourceId, entry.evidenceId, entry.evidence_id]
              );
              return Boolean(reason)
                && evidenceIds.length > 0
                && evidenceIds.every((id) => validEvidenceIds.has(id));
            });
          const displacedPatchList = defectList.length > 0
            && defectList.length <= 120
            && validTargetIds.size > 0
            && defectList.every((entry) => {
              if (!plainObject(entry)) return false;
              const id = String(entry.id || '').trim();
              const before = String(entry.before || '');
              const after = String(entry.after || '');
              return validTargetIds.has(id)
                && Boolean(before)
                && Boolean(after.trim())
                && after !== before;
            });
          const exactAdjacentDuplicateProposalSignals = displacedPatchList ? defectList.flatMap((entry) => {
            const target = validTargets.get(String(entry.id || ''));
            if (!target) return [];
            const trustedBefore = String(target.before || '');
            const deterministicAfter = removeDeterministicAdjacentRepeatedWords(trustedBefore);
            const exact = deterministicAfter !== trustedBefore
              && String(entry.before || '') === trustedBefore
              && String(entry.after || '') === deterministicAfter;
            return exact
              ? [{
                  kind: 'exact-adjacent-duplicate-proposal',
                  targetId: String(entry.id || ''),
                  beforeHash: hashJson(trustedBefore),
                  afterHash: hashJson(deterministicAfter)
                }]
              : [];
          }) : [];
          if (displacedDefectList || displacedPatchList) normalized.decision = 'proceed';
          if (exactAdjacentDuplicateProposalSignals.length) {
            normalized.repairSignals = exactAdjacentDuplicateProposalSignals;
          }
        }
        if (
          mode === 'repair'
          && !legalDecisions.has(normalized.decision)
          && hasAdjacentRepeatedWord(request?.sourceText)
          && indicatesAdjacentRepeatDefect({
            decision: normalized.decision,
            brief: normalized.brief
          })
        ) {
          normalized.decision = 'proceed';
        }
      }
      if (mode === 'redirect') {
        const flat = {
          schema: normalized.schema,
          mode,
          sourceHash: normalized.sourceHash,
          snapshotHash: normalized.snapshotHash,
          decision: 'proceed'
        };
        for (const field of ['sourceFailure', 'replacementObjective', 'requiredBeats', 'forbiddenSourceBeats', 'sceneCharacters', 'characterPressure']) {
          if (Object.prototype.hasOwnProperty.call(data, field)) flat[field] = data[field];
        }
        return flat;
      }
    }
    if (roleId === 'editorialTransformer' && mode === 'redirect') {
      const redirectChangeEvidenceRefs = uniqueRequestStrings(request?.redirectChangeEvidenceRefs).slice(0, 8);
      return {
        schema: expectedResponseSchema(roleId),
        mode,
        sourceHash: normalized.sourceHash,
        snapshotHash: normalized.snapshotHash,
        diagnosisHash: String(request?.diagnosisHash || '').trim(),
        cardOutcomes: [],
        candidate: {
          text: data.text,
          preservationLedger: [],
          changeLedger: redirectChangeEvidenceRefs.length
            ? [{
                kind: 'redirect',
                summary: 'Rebuilt the response around the validated replacement objective.',
                evidenceRefs: redirectChangeEvidenceRefs
              }]
            : [],
          riskFlags: []
        }
      };
    }
    if (roleId === 'editorialTransformer' && mode === 'repair' && Array.isArray(normalized.patches)) {
      const validEvidenceIds = new Set(uniqueRequestStrings(request?.validEvidenceIds));
      const repairTargets = new Map(
        (Array.isArray(request?.repairTargets) ? request.repairTargets : [])
          .filter(plainObject)
          .map((entry) => [String(entry.id || '').trim(), entry])
          .filter(([id, entry]) => id && EDITORIAL_PATCH_DOMAINS.has(String(entry.domain || '').trim()))
      );
      normalized.patches = normalized.patches.map((patch) => {
        if (!plainObject(patch)) return patch;
        const target = repairTargets.get(String(patch.id || '').trim());
        if (!target) return patch;
        const evidenceRefs = uniqueRequestStrings(patch.evidenceRefs);
        const displacedEvidenceRefs = uniqueRequestStrings(patch.domain);
        const evidenceFieldContainsOnlyDomains = evidenceRefs.length > 0
          && evidenceRefs.every((entry) => EDITORIAL_PATCH_DOMAINS.has(entry));
        const domainFieldContainsOnlyEvidence = displacedEvidenceRefs.length > 0
          && displacedEvidenceRefs.every((entry) => validEvidenceIds.has(entry));
        return {
          ...patch,
          domain: String(target.domain),
          evidenceRefs: evidenceFieldContainsOnlyDomains && domainFieldContainsOnlyEvidence
            ? displacedEvidenceRefs
            : patch.evidenceRefs
        };
      });
    }
    if (roleId === 'editorialVerifier' && mode === 'repair') {
      const installedCardIds = uniqueRequestStrings(request?.installedCardIds);
      const validEvidenceIds = new Set(uniqueRequestStrings(request?.validEvidenceIds));
      const failedCardIds = normalizeRepairFailedCardIds(normalized.failedCardIds, request);
      const validFailedCardIds = failedCardIds !== null
        && installedCardIds.every((cardId) => validEvidenceIds.has(`card:${cardId}`));
      const failed = new Set(validFailedCardIds ? failedCardIds : []);
      return {
        schema: expectedResponseSchema(roleId),
        mode,
        sourceHash: normalized.sourceHash,
        snapshotHash: normalized.snapshotHash,
        diagnosisHash: String(request?.diagnosisHash || '').trim(),
        candidateHash: String(request?.candidateHash || '').trim(),
        decision: validFailedCardIds ? (failed.size ? 'reject' : 'accept') : 'invalid',
        cardOutcomes: validFailedCardIds
          ? installedCardIds.map((cardId) => ({
              cardId,
              status: failed.has(cardId) ? 'partially-reflected' : 'honored',
              evidenceRefs: [`card:${cardId}`]
            }))
          : [],
        reason: String(normalized.reason || '').trim()
      };
    }
    if (roleId === 'editorialVerifier' && mode === 'redirect') {
      const failedChecks = Array.isArray(data.failedChecks) ? data.failedChecks.map(String) : null;
      const validFailedChecks = failedChecks !== null
        && new Set(failedChecks).size === failedChecks.length
        && failedChecks.every((check) => REDIRECT_VERIFICATION_CHECKS.includes(check));
      const evidenceRefs = uniqueRequestStrings(request?.verificationEvidenceRefs).slice(0, 8);
      const failed = new Set(validFailedChecks ? failedChecks : []);
      const reason = String(data.reason || '').trim();
      return {
        schema: expectedResponseSchema(roleId),
        mode,
        sourceHash: normalized.sourceHash,
        snapshotHash: normalized.snapshotHash,
        diagnosisHash: String(request?.diagnosisHash || '').trim(),
        candidateHash: String(request?.candidateHash || '').trim(),
        decision: validFailedChecks ? (failed.size ? 'reject' : 'accept') : 'invalid',
        evidenceRefs,
        reason,
        checks: validFailedChecks
          ? REDIRECT_VERIFICATION_CHECKS.map((check) => ({
              check,
              status: failed.has(check) ? 'fail' : 'pass',
              evidenceRefs,
              note: failed.has(check)
                ? (reason || 'Provider reported this required check as failed.')
                : 'Provider reported no failure for this required check.'
            }))
          : []
      };
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

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textValue(value, fallback = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
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

export function validateProviderConfiguration(provider = {}, options = {}) {
  const profiles = Array.isArray(options.profiles)
    ? options.profiles
    : listProviderConnectionProfiles(options);
  const lane = laneName(provider.lane);
  const capability = resolveProviderCapability({
    settings: {
      reasoningLevel: 'medium',
      providers: { [lane]: { ...provider, lane } }
    },
    lane,
    operation: 'provider-test',
    host: { connectionProfiles: profiles }
  });
  const missingByReason = {
    'provider-profile-missing': ['connectionProfileId'],
    'provider-profile-unavailable': ['connectionProfile']
  };
  return {
    ready: capability.testable,
    missing: missingByReason[capability.reasonCode] || [],
    providerType: 'sillytavern-connection-profile',
    sourceLabel: 'Connection Profile',
    message: capability.message
  };
}

export function providerModelStatus(provider = {}, options = {}) {
  const profiles = Array.isArray(options.profiles)
    ? options.profiles
    : listProviderConnectionProfiles(options);
  const validation = validateProviderConfiguration(provider, { ...options, profiles });
  const profileId = textValue(provider.connectionProfileId);
  const selected = profiles.find((entry) => entry.id === profileId);
  return {
    ...validation,
    model: selected?.model || '',
    label: selected?.label || (profileId ? `${profileId} (saved)` : 'Connection Profile'),
    profileId: selected?.id || profileId,
    profileLabel: selected?.name || '',
    completionMode: selected?.completionMode || 'unknown',
    presetName: selected?.presetName || '',
    instructName: selected?.instructName || ''
  };
}

export function providerRouteSummary(settings = {}, host = {}) {
  const level = String(settings?.reasoningLevel || 'medium').toLowerCase();
  const normalizedLevel = ['low', 'medium', 'high', 'ultra'].includes(level) ? level : 'medium';
  const capability = resolveProviderCapability({
    settings,
    lane: 'reasoner',
    operation: 'prompt-packet',
    host
  });
  const reasonerHealthy = capability.ready;
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

function providerResponseFailureError(error, enriched = {}) {
  const code = String(error?.code || '');
  const details = error?.details || {};
  const providerDiagnostics = sanitize({
    providerSource: enriched.providerSource,
    model: details.model || enriched.providerConfig?.resolvedModelLabel || '',
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
  if ([PROVIDER_RESPONSE_ERROR_CODES.REFUSAL, PROVIDER_RESPONSE_ERROR_CODES.CONTENT_FILTER].includes(code)) {
    throw providerError(code === PROVIDER_RESPONSE_ERROR_CODES.REFUSAL
      ? 'RECURSION_PROVIDER_REFUSAL' : 'RECURSION_PROVIDER_CONTENT_FILTER',
    'The provider declined this request.', { retryable: false, providerDiagnostics });
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
  const configured = positiveTokenLimit(enriched.providerConfig?.outputTokenCeiling);
  const requested = positiveTokenLimit(enriched.responseLength)
    ?? positiveTokenLimit(enriched.maxTokens);
  if (configured && requested) return Math.min(configured, requested);
  return requested ?? configured;
}

const EFFECTIVE_COMPLETION_MODES = new Set(['chat', 'text']);
const EFFECTIVE_SAMPLER_SOURCES = new Set(['profile', 'recursion', 'recursion-fallback']);
const EFFECTIVE_STRUCTURED_OUTPUT_METHODS = new Set(['native-schema', 'prompt-json']);
const EFFECTIVE_POLICY_DIAGNOSTIC_CODES = new Set([
  'structured-output-downgraded',
  'profile-sampler-projection-failed'
]);

function fixedPolicyDiagnosticCodes(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((code) => String(code || '').trim().toLowerCase())
      .filter((code) => EFFECTIVE_POLICY_DIAGNOSTIC_CODES.has(code))
  )].slice(0, 12);
}

function shortProfileDiagnosticHash(profileId = '') {
  const cleanId = String(profileId || '').trim();
  if (!cleanId) return '';
  return `${hashJson(cleanId)}${hashJson(`profile:${cleanId}`)}`.slice(0, 16);
}

function effectivePolicyDiagnostics(response = {}, enriched = {}) {
  const policy = plainObject(response?.generationPolicy) ? response.generationPolicy : {};
  const completionModeValue = String(
    response?.completionMode || response?.profile?.completionMode || ''
  ).trim().toLowerCase();
  const samplerSourceValue = String(policy.samplerSource || '').trim().toLowerCase();
  const structuredOutputValue = String(policy.structuredOutputMethod || '').trim().toLowerCase();
  return Object.freeze({
    connectionProfileIdHash: shortProfileDiagnosticHash(enriched.connectionProfileId),
    completionMode: EFFECTIVE_COMPLETION_MODES.has(completionModeValue)
      ? completionModeValue
      : 'chat',
    presetMode: policy.includePreset === true ? 'full-profile' : 'isolated',
    instructApplied: policy.includeInstruct === true,
    samplerSource: EFFECTIVE_SAMPLER_SOURCES.has(samplerSourceValue)
      ? samplerSourceValue
      : 'recursion-fallback',
    structuredOutputMethod: EFFECTIVE_STRUCTURED_OUTPUT_METHODS.has(structuredOutputValue)
      ? structuredOutputValue
      : 'prompt-json',
    responseLength: Math.max(0, Math.trunc(Number(providerRequestMaxTokens(enriched)) || 0)),
    queueConcurrency: Math.max(1, Math.trunc(Number(enriched.queueConcurrency) || 1)),
    diagnosticCodes: fixedPolicyDiagnosticCodes(policy.diagnosticCodes)
  });
}

function responsePolicyDiagnostics(response = {}) {
  if (!plainObject(response?.effectivePolicy)) return {};
  const policy = response.effectivePolicy;
  return {
    effectivePolicy: sanitize({
      connectionProfileIdHash: String(policy.connectionProfileIdHash || '').slice(0, 16),
      completionMode: EFFECTIVE_COMPLETION_MODES.has(policy.completionMode) ? policy.completionMode : 'chat',
      presetMode: policy.presetMode === 'full-profile' ? 'full-profile' : 'isolated',
      instructApplied: policy.instructApplied === true,
      samplerSource: EFFECTIVE_SAMPLER_SOURCES.has(policy.samplerSource) ? policy.samplerSource : 'recursion-fallback',
      structuredOutputMethod: EFFECTIVE_STRUCTURED_OUTPUT_METHODS.has(policy.structuredOutputMethod)
        ? policy.structuredOutputMethod
        : 'prompt-json',
      responseLength: Math.max(0, Math.trunc(Number(policy.responseLength) || 0)),
      queueConcurrency: Math.max(1, Math.trunc(Number(policy.queueConcurrency) || 1)),
      diagnosticCodes: fixedPolicyDiagnosticCodes(policy.diagnosticCodes)
    }, 120)
  };
}

function normalizeProviderResponse(response, enriched) {
  const envelope = normalizeProviderEnvelope(response);
  const raw = response?.raw ?? response;
  const failure = getProviderResponseFailure(raw, {
    providerTitle: enriched.providerSource || 'Provider',
    maxTokens: providerRequestMaxTokens(enriched)
  });
  if ([PROVIDER_RESPONSE_ERROR_CODES.TOKEN_LIMIT, PROVIDER_RESPONSE_ERROR_CODES.REFUSAL,
    PROVIDER_RESPONSE_ERROR_CODES.CONTENT_FILTER].includes(failure?.code)
      || (!envelope.structured && !String(envelope.text || '').trim())) {
    if (failure) {
      providerResponseFailureError({ code: failure.code, details: failure }, enriched);
    }
    providerVisibleText(raw, enriched);
  }
  return {
    text: envelope.text,
    structured: envelope.structured,
    reasoning: envelope.reasoning,
    finishReasons: envelope.finishReasons,
    usage: envelope.usage,
    roleId: enriched.roleId,
    lane: enriched.lane,
    providerId: envelope.source,
    model: envelope.model,
    responseId: envelope.responseId,
    providerConfig: enriched.providerConfig,
    completionMode: response?.completionMode || response?.profile?.completionMode || 'unknown',
    effectivePolicy: effectivePolicyDiagnostics(response, enriched),
    ...reasoningDiagnostics({ ...enriched, ...response })
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
  const originalCode = String(actionable?.code || actionable?.name || 'RECURSION_PROVIDER_FAILED');
  const normalizedFailure = normalizeProviderError(error);
  const rawCode = originalCode.startsWith('RECURSION_')
    ? originalCode
    : normalizedFailure.code;
  const useNormalizedMessage = actionable?.external === true
    || normalizedFailure.code === rawCode;
  const message = useNormalizedMessage
    ? normalizedFailure.message
    : scrubKnownRequestText(actionable?.message || normalizedFailure.message, request);
  const actualSchema = scrubKnownRequestText(actionable?.actualSchema || '', request);
  const expectedSchema = scrubKnownRequestText(actionable?.expectedSchema || '', request);
  const roleId = String(actionable?.roleId || '')
    .replace(/[^a-zA-Z0-9_-]+/g, '')
    .slice(0, 80);
  const responseFields = Array.isArray(actionable?.responseFields)
    ? actionable.responseFields.map((field) => String(field).replace(/[^a-zA-Z0-9_-]+/g, '').slice(0, 80)).filter(Boolean).slice(0, 24)
    : [];
  const responseShape = Array.isArray(actionable?.responseShape)
    ? actionable.responseShape
      .map((entry) => String(entry).replace(/[^a-zA-Z0-9_():,-]+/g, '').slice(0, 240))
      .filter(Boolean)
      .slice(0, 24)
    : [];
  return sanitize({
    code: scrubKnownRequestText(rawCode, request),
    ...(Number.isFinite(normalizedFailure.retryAfterMs) ? { retryAfterMs: normalizedFailure.retryAfterMs } : {}),
    message: truncate(compact(message), 300),
    retryable: originalCode.startsWith('RECURSION_')
      ? retryableError(error)
      : normalizedFailure.retryable,
    ...providerFailureDiagnostics(error),
    ...(roleId ? { roleId } : {}),
    ...(expectedSchema ? { expectedSchema: truncate(compact(expectedSchema), 120) } : {}),
    ...(actualSchema ? { actualSchema: truncate(compact(actualSchema), 120) } : {}),
    ...(responseFields.length ? { responseFields } : {}),
    ...(responseShape.length ? { responseShape } : {})
  }, 300);
}

function responseIdentityDiagnostics(response = {}) {
  const source = plainObject(response) ? response : {};
  const providerSource = String(source.providerSource || '').trim();
  const providerId = String(source.providerId || '').trim();
  const model = String(source.model || '').trim();
  const responseId = String(source.responseId || '').trim();
  const visibleContentLength = String(source.text || '').length;
  return sanitize({
    ...responsePolicyDiagnostics(source),
    ...(plainObject(source.usage) ? source.usage : {}),
    ...(plainObject(source.timings) ? {timings: source.timings} : {}),
    ...(source.finishReasons?.length ? {finishReason: source.finishReasons[0]} : {}),
    ...(source.effectivePolicy?.responseLength ? {effectiveMaxTokens: source.effectivePolicy.responseLength} : {}),
    ...(providerSource ? { providerSource } : {}),
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {}),
    ...(responseId ? { responseId } : {}),
    ...(visibleContentLength ? { visibleContentLength } : {})
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
    reasoningLength: source.reasoningLength,
    timings: source.timings
  }, 300);
}

function statusForError(error) {
  if (error?.code === 'RECURSION_JSON_PARSE_FAILED' || error?.code === 'RECURSION_JSON_OBJECT_REQUIRED') {
    return 'validation-failed';
  }
  if (error?.code === 'RECURSION_PROVIDER_TIMEOUT') return 'timeout';
  if (error?.code === 'RECURSION_PROVIDER_ABORTED') return 'aborted';
  return 'provider-failed';
}

function failureStageForRole(roleId = '') {
  if (roleId === 'editorialDiagnostician') return 'editorial-diagnosis';
  if (roleId === 'editorialTransformer') return 'editorial-transform';
  if (roleId === 'editorialVerifier') return 'editorial-verification';
  if (roleId === 'generationReviewer') return 'generation-review';
  if (roleId === 'providerTest') return 'provider-test';
  return 'provider-call';
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

async function withTimeout(operation, request, timeoutMs, externalSignal = null, deferUntilDispatch = false) {
  if (externalSignal?.aborted) throw abortError();

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const requestWithSignal = controller ? { ...request, signal: controller.signal } : { ...request };
  let timeoutId = null;
  let removeAbortListener = () => {};
  let settled = false;

  const timeoutPromise = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? new Promise((_, reject) => {
      const startDeadline = () => {
        if (settled || timeoutId !== null) return;
        timeoutId = setTimeout(() => {
          reject(timeoutError(timeoutMs));
          controller?.abort?.();
        }, timeoutMs);
      };
      if (deferUntilDispatch) requestWithSignal.onProviderDispatch = startDeadline;
      else startDeadline();
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
    settled = true;
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
  if (timeoutMs === null || timeoutMs === undefined) return null;
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

function parseProviderStructuredOutput(envelope = {}) {
  if (envelope?.structured && typeof envelope.structured === 'object' && !Array.isArray(envelope.structured)) {
    return {
      data: envelope.structured,
      diagnostics: {
        structuredOutputSource: 'provider-structured',
        structuredOutputRepaired: false,
        visibleContentLength: String(envelope.text || '').length
      }
    };
  }
  const text = String(envelope?.text || '');
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
      structuredOutputSource: 'visible-content',
      structuredOutputRepaired: parsed.repaired === true,
      ...(parsed.repaired ? { structuredOutputRepairCode: 'json_repaired' } : {}),
      ...(parsed.repairKind ? {
        structuredOutputRecovery: parsed.repairKind,
        originalResponseHash: responseTextHash(text),
        repairedResponseHash: responseTextHash(parsed.candidate)
      } : {}),
      visibleContentLength: parsed.visibleContentLength
    }
  };
}

export function createProviderClient({
  host = null,
  settingsStore = null,
  requestQueue = createProfileRequestQueue()
} = {}) {
  function enrich(roleId, request = {}) {
    const resolvedRoleId = String(roleId || '').trim();
    if (!resolvedRoleId) {
      throw providerError('RECURSION_PROVIDER_ROLE_MISSING', 'Provider request is missing roleId.', { retryable: false });
    }
    if (!isProviderRole(resolvedRoleId)) throw unsupportedRoleError(resolvedRoleId);

    const postProcessGuidanceRole = resolvedRoleId === 'postProcessGuidanceUtility'
      || resolvedRoleId === 'postProcessGuidanceReasoner';
    const lane = laneName(requestLane(resolvedRoleId, request));
    if (postProcessGuidanceRole && lane !== roleLane(resolvedRoleId)) {
      throw providerError(
        'RECURSION_PROVIDER_ROLE_LANE_MISMATCH',
        'Post-process guidance roles cannot be dispatched on a different provider lane.',
        { retryable: false }
      );
    }
    const { settings, config } = providerConfigFor(settingsStore, lane);
    const operation = request.certification === true
      ? 'provider-test'
      : resolvedRoleId === 'providerTest'
        ? 'provider-test'
        : postProcessGuidanceRole
          ? 'post-process'
          : 'prompt-packet';
    const capabilitySettings = postProcessGuidanceRole
      ? { ...settings, reasoningLevel: request.reasoningLevel }
      : settings;
    const capability = resolveProviderCapability({
      settings: capabilitySettings,
      lane,
      operation,
      host: providerCapabilityHost(host)
    });
    if (resolvedRoleId === 'providerTest' && !capability.testable) {
      throw providerError(
        'RECURSION_PROVIDER_NOT_READY',
        capability.message,
        { retryable: false, providerDiagnostics: { capability } }
      );
    }
    if (!config.connectionProfileId) {
      throw providerError(
        'RECURSION_PROFILE_MISSING',
        'Select a SillyTavern Connection Profile.',
        { retryable: false, providerDiagnostics: { capability } }
      );
    }

    const responseLength = outputBudgetForRequest(
      resolvedRoleId,
      request,
      config.outputTokenCeiling
    );

    return {
      ...request,
      roleId: resolvedRoleId,
      lane,
      responseLength,
      ...((normalizeReasoningIntent(request.reasoningIntent) || lane === 'utility')
        ? { reasoningIntent: lane === 'utility' ? 'none' : normalizeReasoningIntent(request.reasoningIntent) }
        : {}),
      ...(reasoningCategoryName(request.reasoningCategory)
        ? { reasoningCategory: reasoningCategoryName(request.reasoningCategory) }
        : {}),
      responseSchema: expectedResponseSchema(resolvedRoleId),
      connectionProfileId: config.connectionProfileId,
      providerConfig: cloneJson(config)
    };
  }

  async function generateEnriched(enriched) {
    if (typeof host?.generation?.generate !== 'function') {
      throw providerError(
        'RECURSION_CONNECTION_MANAGER_UNAVAILABLE',
        'SillyTavern Connection Manager generation is unavailable.',
        { retryable: false }
      );
    }
    const concurrencyLimit = () =>
      enriched.certification === true && enriched.roleId === 'providerTest' && enriched.concurrencyProbe
        ? Math.min(3, Math.max(1, Number(enriched.concurrencyProbe.limit) || 1))
        : effectiveProfileConcurrency(readSettings(settingsStore), enriched.connectionProfileId);
    requestQueue.setConcurrency?.(enriched.connectionProfileId, concurrencyLimit());
    let dispatchTiming = {};
    return requestQueue.run(
      enriched.connectionProfileId,
      async () => {
        const startedAt = Date.now();
        const transportStartedAt = performance.now();
        try {
          const response = await host.generation.generate(enriched);
          const transportCompletedAt = performance.now();
          const providerCompletedAt = Date.now();
          const normalized = normalizeProviderResponse(response, {
            ...enriched,
            queueConcurrency: dispatchTiming.concurrency || requestQueue.stats(enriched.connectionProfileId).concurrency
          });
          return { ...normalized, timings: {
            ...dispatchTiming,
            ...response?.timings,
            transportStartedAt,
            transportCompletedAt,
            providerCompletedAt,
            providerMs: providerCompletedAt - startedAt,
            normalizationMs: Date.now() - providerCompletedAt
          } };
        } catch (error) {
          const failure = normalizeProviderError(error);
          if (failure.code === 'RECURSION_PROVIDER_RATE_LIMIT') {
            error.retryAfterMs = failure.retryAfterMs;
            requestQueue.cooldown?.(enriched.connectionProfileId, failure.retryAfterMs);
          }
          error.providerDiagnostics = { ...error.providerDiagnostics, timings: {
            ...dispatchTiming, ...error.providerDiagnostics?.timings, providerMs: Date.now() - startedAt
          } };
          throw error;
        } finally {
          if (enriched.concurrencyProbe) requestQueue.setConcurrency?.(enriched.connectionProfileId,
            effectiveProfileConcurrency(readSettings(settingsStore), enriched.connectionProfileId));
        }
      },
      { signal: enriched.signal ?? null, concurrencyLimit, onDispatch: (timing) => {
        dispatchTiming = timing;
        enriched.onProviderDispatch?.();
      } }
    );
  }

  async function generate(roleId, request = {}) {
    return generateEnriched(enrich(roleId, request));
  }

  async function batch(requests = [], options = {}) {
    const normalized = requests.map((entry) => normalizeBatchRequest(entry));
    const enriched = normalized.map(({ roleId, request }) => enrich(roleId, request));
    const onSlotSettled = typeof options?.onSlotSettled === 'function' ? options.onSlotSettled : null;
    return Promise.all(enriched.map((request, index) => generateEnriched(request).then(
      (response) => {
        safeInvoke(() => onSlotSettled?.({
          index,
          roleId: normalized[index].roleId,
          request,
          response
        }));
        return response;
      },
      (error) => {
        const operationAborted = error?.code === 'RECURSION_PROVIDER_ABORTED'
          || request.signal?.aborted
          || options.signal?.aborted;
        const response = operationAborted
          ? { ok: false, error }
          : normalizeProviderSlotFailure({ error }, request, { slotIsolation: true });
        safeInvoke(() => onSlotSettled?.({
          index,
          roleId: normalized[index].roleId,
          request,
          response
        }));
        if (!operationAborted) return response;
        throw error;
      }
    )));
  }

  function listProfiles(options = {}) {
    return listProviderConnectionProfiles({ ...options, host });
  }

  function status(lane = 'utility', options = {}) {
    const resolvedLane = laneName(lane);
    const { config } = providerConfigFor(settingsStore, resolvedLane);
    return providerModelStatus(config, { ...options, host });
  }

  return Object.freeze({ generate, batch, listProfiles, status, dispatchTiming: true });
}

export function createGenerationRouter({ client, activity = null, journal = null, timeoutMs = 180000 } = {}) {
  if (!client || typeof client.generate !== 'function') {
    throw new Error('createGenerationRouter requires a client with generate(roleId, request).');
  }

  let journalQueue = Promise.resolve();
  function queueJournalAppend(entry) {
    const write = journalQueue.then(() => journalAppend(journal, entry));
    journalQueue = write.catch(() => {});
    return write;
  }

  async function generate(roleId, request = {}, options = {}) {
    const providerRoleKnown = isProviderRole(roleId);
    const lane = laneName(requestLane(roleId, request));
    const started = Date.now();
    const startedAt = nowIso();
    const effectiveTimeoutMs = options.timeoutMs ?? (typeof timeoutMs === 'function' ? timeoutMs() : timeoutMs);
    let runId = String(options.runId || request.runId || makeId('provider'));
    let lastDiagnostics = diagnosticsBase({ roleId, lane, request, runId, startedAt, timeoutMs: effectiveTimeoutMs });
    const nestedActivityLifecycle = options.activityLifecycle === 'nested';

    const startedActivityEvent = {
      runId,
      phase: 'providerCallStarted',
      mode: 'background',
      severity: 'info',
      providerLane: lane,
      composerLane: lane === 'reasoner' ? 'reasoner' : 'utility',
      label: `${lane === 'reasoner' ? 'Reasoner' : 'Utility'} provider call started.`,
      detail: lastDiagnostics
    };
    const activityRunId = nestedActivityLifecycle
      ? (activityStage(activity, startedActivityEvent), runId)
      : activityStart(activity, startedActivityEvent);
    if (options.lockRunId !== true) runId = activityRunId || runId;
    lastDiagnostics = diagnosticsBase({ roleId, lane, request, runId, startedAt, timeoutMs: effectiveTimeoutMs });
    const settleProviderActivity = (event) => {
      if (nestedActivityLifecycle) {
        activityStage(activity, {
          ...event,
          phase: 'providerCallSettled',
          severity: event.outcome === 'error' ? 'error' : (event.outcome === 'warning' ? 'warning' : 'success')
        });
        return;
      }
      activitySettle(activity, event);
    };
    queueJournalAppend({
      ...lastDiagnostics,
      status: 'started',
      recordedAt: nowIso()
    });

    const composedExternalSignal = composeAbortSignal([options.signal, request.signal]);
    let raw = null;
    try {
      activityStage(activity, {
        runId,
        phase: 'providerCallRunning',
        severity: 'info',
        providerLane: lane,
        composerLane: lane === 'reasoner' ? 'reasoner' : 'utility',
        label: 'Provider call running.',
        detail: { roleId, lane, attempt: 1 }
      });

      if (!providerRoleKnown) throw unsupportedRoleError(roleId);
      raw = await withTimeout(
        (requestWithSignal) => client.generate(roleId, requestWithSignal),
        request,
        effectiveTimeoutMs,
        composedExternalSignal.signal || null,
        client.dispatchTiming === true
      );
      const parsed = parseProviderStructuredOutput(raw);
      const normalized = normalizeRoleResponse(roleId, parsed.data, request);
      const data = normalized.data;
      validateRoleResponseSchema(roleId, data);
      const diagnostics = sanitize({
        ...lastDiagnostics,
        ...parsed.diagnostics,
        ...normalized.diagnostics,
        ...reasoningDiagnostics(raw),
        ...responseIdentityDiagnostics(raw),
        ...responsePolicyDiagnostics(raw),
        providerSource: raw.providerSource,
        providerId: raw.providerId,
        model: raw.model,
        responseId: raw.responseId,
        responseHash: responseTextHash(raw.text),
        schema: data.schema,
        retryCount: 0,
        latencyMs: Date.now() - started,
        completedAt: nowIso()
      }, 300);

      await queueJournalAppend({
        ...diagnostics,
        status: 'success',
        recordedAt: nowIso()
      });
      settleProviderActivity({
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
        diagnostics
      };
    } catch (error) {
      const safeError = sanitizedError(error, request);
      const failure = providerFailure(safeError, { stage: failureStageForRole(roleId) });
      const diagnostics = sanitize({
        ...lastDiagnostics,
        ...providerFailureDiagnostics(error),
        ...responseIdentityDiagnostics(raw),
        retryCount: 0,
        latencyMs: Date.now() - started,
        error: safeError,
        failure,
        status: statusForError(error),
        failedAt: nowIso()
      }, 300);
      await queueJournalAppend({
        ...diagnostics,
        status: statusForError(error),
        recordedAt: nowIso()
      });
      settleProviderActivity({
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
        recoverableText: roleId === 'fusedCardBundle' ? truncate(String(raw?.text || ''), 12000) : ''
      };
    } finally {
      composedExternalSignal.cleanup();
    }
  }

  async function batch(requests = [], options = {}) {
    const rawRequests = Array.isArray(requests) ? requests : [];
    const batchRunId = String(options.runId || makeId('provider-batch'));
    const effectiveTimeoutMs = options.timeoutMs ?? (typeof timeoutMs === 'function' ? timeoutMs() : timeoutMs);
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
      const failure = providerFailure(safeError, { stage: failureStageForRole(entry.roleId) });
      const diagnostics = sanitize({
        ...entry.diagnostics,
        retryCount,
        latencyMs: Date.now() - entry.started,
        error: safeError,
        failure,
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
      return Promise.all(entries.map(async (entry) => {
        if (entry.normalizationError) {
          return failureResult(entry, entry.normalizationError);
        }
        return generate(entry.roleId, entry.request, {
          ...options,
          runId: batchRunId,
          lockRunId: true
        });
      }));
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
      const parsed = parseProviderStructuredOutput(raw);
      const normalized = normalizeRoleResponse(entry.roleId, parsed.data, entry.request);
      const data = normalized.data;
      validateRoleResponseSchema(entry.roleId, data);
      const diagnostics = sanitize({
        ...entry.diagnostics,
        ...responseIdentityDiagnostics(raw),
        ...parsed.diagnostics,
        ...normalized.diagnostics,
        ...reasoningDiagnostics(raw),
        ...responsePolicyDiagnostics(raw),
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
      const parsed = parseProviderStructuredOutput(raw);
      const normalized = normalizeRoleResponse(entry.roleId, parsed.data, entry.request);
      const data = normalized.data;
      validateRoleResponseSchema(entry.roleId, data);
      emitSlotActivity(entry, {
        severity: retryCount > 0 ? 'warning' : 'success',
        outcome: retryCount > 0 ? 'warning' : 'success',
        label: retryCount > 0 ? 'Provider batch slot completed after retry.' : 'Provider batch slot completed.',
        detail: sanitize({
          ...entry.diagnostics,
          ...parsed.diagnostics,
          ...normalized.diagnostics,
          ...reasoningDiagnostics(raw),
          ...responsePolicyDiagnostics(raw),
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
      const failure = providerFailure(safeError, { stage: failureStageForRole(entry.roleId) });
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
          failure,
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
    try {
      rawResponses = await withBatchTimeout(
        (requestsWithSignals) => client.batch(requestsWithSignals, {
          onSlotSettled: (slot = {}) => {
            const batchIndex = Number(slot.index);
            if (!Number.isInteger(batchIndex) || batchIndex < 0 || batchIndex >= pendingEntries.length) return;
            const raw = Object.prototype.hasOwnProperty.call(slot, 'response')
              ? slot.response
              : (Object.prototype.hasOwnProperty.call(slot, 'result') ? slot.result : slot.value);
            emitSlotSettledActivity(pendingEntries[batchIndex], raw, 0);
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
    } catch (error) {
      if (error?.code === 'RECURSION_PROVIDER_ABORTED' || options.signal?.aborted) {
        throw error;
      }
      for (const entry of pendingEntries) {
        results[entry.index] = await failureResult(entry, error, 0);
        emitSlotFailureActivity(entry, error, null, 0, { force: true });
      }
      settleBatchActivity();
      return results;
    }

    for (let batchIndex = 0; batchIndex < rawResponses.length; batchIndex += 1) {
      const raw = rawResponses[batchIndex];
      const entry = pendingEntries[batchIndex];
      try {
        results[entry.index] = await successResult(entry, raw, 0);
        emitSlotSettledActivity(entry, raw, 0);
      } catch (error) {
        results[entry.index] = await failureResult(entry, error, 0, {
          ...batchDiagnosticsFromResponse(raw),
          ...responseIdentityDiagnostics(raw)
        });
        emitSlotFailureActivity(entry, error, raw, 0, { force: true });
      }
    }

    settleBatchActivity();
    return results;
  }

  return { generate, batch };
}
