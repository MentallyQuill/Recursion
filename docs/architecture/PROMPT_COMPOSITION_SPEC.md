# Prompt Composition Spec

## Purpose

Recursion improves the next SillyTavern generation by composing a compact, inspectable prompt packet from the selected turn hand. It does not inject every selected card directly, and it does not try to own all story context. The packet is a small reasoning brief that helps the model notice the active scene's immediate implications: recent turn pressure, visible character posture, spatial and social affordances, reveal boundaries, and hard plausibility constraints.

Related specs:

- [Product Scope](../design/RECURSION_PRODUCT_SCOPE.md)
- [Card System Spec](../design/CARD_SYSTEM_SPEC.md)
- [Behavior Settings Policy Spec](../design/BEHAVIOR_SETTINGS_POLICY_SPEC.md)
- [Runtime Architecture](RUNTIME_ARCHITECTURE.md)
- [Provider and Generation Spec](PROVIDER_AND_GENERATION_SPEC.md)
- [Storage and Diagnostics](STORAGE_AND_DIAGNOSTICS.md)
- [UI Spec](../design/UI_SPEC.md)

## Composition Strategy

The selected hand is the input to prompt composition, not the final prompt. Cards are intermediate runtime artifacts used to decide what matters now. The composer fuses those cards into a bounded prompt packet with three user-inspectable sections:

- Scene Brief
- Turn Brief
- Guardrails

The composed packet is preferred because it can remove duplicates, resolve emphasis, fit the active footprint budget, and present one coherent instruction instead of a stack of fragmented card text. Compact card references may be retained internally for diagnostics, omission tracing, cache invalidation, and inspector display, but the model-facing prompt should read as a deliberate brief.

Raw or direct card injection is a narrow exception. It is reserved for critical guardrails that would lose force if paraphrased, such as a hard scene constraint, an active safety boundary, or a precise response-shape constraint that must remain exact. Raw card injection must be recorded in diagnostics with the reason it bypassed composition.

Composition must not:

- dump hidden internal reasoning;
- reveal spoilers, private motives, or future plot plans;
- rewrite or summarize the user's latest message as if it were an instruction to obey instead of story input;
- expand into general lore, world memory, transcript summary, continuity database behavior, or vector recall;
- compete with SillyTavern character prompts, author notes, World Info, Memory Books, Summaryception, VectFox, or other context providers.

## Prompt Packet Contract

A prompt packet is the complete model-facing Recursion artifact for one generation attempt.

Required fields:

- `packetId`: unique id for the composed packet.
- `packetVersion`: schema version for diagnostics and migration.
- `snapshotHash`: frozen source snapshot hash for this generation attempt.
- `chatId`: active SillyTavern chat identity or stable runtime alias.
- `sceneFingerprint`: current scene identity used for cache checks.
- `turnFingerprint`: current turn identity used to avoid stale installation.
- `footprint`: `compact`, `normal`, or `rich`.
- `sections`: composed model-facing sections.
- `selectedCardRefs`: compact internal references for selected hand items.
- `omissions`: budget and policy omissions.
- `injectionPlan`: lane, depth, order, and lifecycle metadata.
- `diagnostics`: sanitized composer and provider metadata.

Model-facing sections:

### Scene Brief

The Scene Brief is reusable while the scene fingerprint remains valid. It describes the current scene frame in compact prose:

- immediate location or situation;
- active cast and visible relationship posture;
- important recent scene implications that shape this response;
- unresolved near-term pressures;
- sensory or spatial constraints that improve prose grounding.

The Scene Brief should be stable enough to survive several turns but not so broad that it becomes a replacement for lore or memory. It should avoid backstory unless that backstory is immediately active in the scene.

### Turn Brief

The Turn Brief is regenerated for the current generation attempt. It captures what the next response must respect now:

- the user's latest move or request, without rewriting it;
- immediate scene constraints and plausibility traps;
- active dialogue, emotional, pacing, or action cues;
- response-shaping priorities selected by the Utility Arbiter;
- any short-lived instruction needed only for this turn.

The Turn Brief should sit closest to the active generation context. It is allowed to be more specific and volatile than the Scene Brief.

### Guardrails

Guardrails are concise constraints the response must not violate. They are limited to requirements that materially protect the next response:

- do not contradict a critical active fact;
- do not expose hidden internal thoughts or chain-of-thought;
- do not spoil unknown future events;
- do not advance broad plot plans without user-facing setup;
- do not overwrite the user's latest message or decide the player's intent;
- do not restate large external memory or lore blocks already owned elsewhere.

Guardrails may include a very small number of exact card-derived statements when exact wording is required. Those cases must be marked as raw/direct exceptions in diagnostics.

## Composer Inputs

The composer receives a bounded snapshot. Inputs should be explicit so failures can be diagnosed and cached state can be invalidated safely.

Core inputs:

- active chat id and current message index;
- latest user message fingerprint and bounded excerpt;
- scene fingerprint and scene freshness metadata;
- selected hand from the card system;
- candidate cards not selected but close to threshold, for omission explanation only;
- card emphasis profile: low, normal, high, or critical;
- card detail profile: terse, balanced, or descriptive;
- Utility Arbiter footprint state;
- Utility Arbiter next-turn need assessment;
- provider availability and Reasoner eligibility;
- prompt environment summary, including known active external context sources when available;
- user settings for enablement, Strength, Focus, Prompt Footprint, Reasoning Level, and diagnostics visibility;
- token budget and section caps.

Cards should provide structured fields rather than opaque prompt text wherever possible:

- `cardId`;
- `cardType`;
- `sceneScope`;
- `sourceMessageRefs`;
- `claim`;
- `instructionHint`;
- `continuityRisk`;
- `emphasis`;
- `detailProfile`;
- `estimatedTokens`;
- `externalOwnerHint`;
- `expiresAtSceneShift`.

The composer must treat cards as evidence and guidance, not as mandatory final prose. A high-emphasis card should usually survive into the packet, but the composer still controls phrasing, section placement, and duplication.

## Utility Composer vs Reasoner Composer

Recursion has two composition modes.

The names in this section describe composition paths. Provider generation role IDs are `briefUtilityComposer` for Utility-routed model composition and `reasonerComposer` for Reasoner synthesis.

### Utility Composer

The Utility Composer is the default. It is fast, bounded, schema-driven, and suitable for every generation attempt where Recursion is enabled. It may be implemented as deterministic runtime code, a Utility-model structured call, or a hybrid, but its output must pass the prompt packet contract.

Responsibilities:

- merge selected cards into packet sections;
- enforce section caps and total footprint budget;
- apply emphasis and detail profiles;
- remove duplicates and external-context repeats;
- record omission reasons;
- produce a stable injection plan;
- degrade cleanly when a provider is unavailable.

The Utility Composer should produce good-enough prompt guidance without requiring a Reasoner.

### Reasoner Composer

The Reasoner Composer is optional. It can fuse the selected hand into sharper, more nuanced instructions when the Utility Arbiter decides the next turn has enough complexity or risk to justify the extra call.

Reasoner Composer triggers may include:

- high scene-constraint risk;
- dense active cast or relationship tension;
- conflicting candidate cards;
- rapid scene shift;
- rich footprint selected by Utility Arbiter;
- user-enabled strong guidance mode;
- repeated diagnostics showing weak previous composition.

Reasoner output is not authoritative by itself. Runtime must validate, cap, and merge it into the packet. The Reasoner must echo the packet's frozen `snapshotHash`; missing or mismatched hashes are stale output and must be rejected. The Reasoner must not invent lore, future plot, hidden motivations, or private analysis. It should transform selected evidence into concise scene-reasoning guidance, then return structured output that the Utility Composer or runtime validator can accept, trim, or reject.

If the Reasoner fails, times out, returns invalid schema, returns the wrong snapshot hash, or exceeds safety limits, Recursion falls back to Utility Composer output and records the fallback in diagnostics.

## Injection Lanes/Depths

Recursion installs prompt packets through controlled SillyTavern prompt integration managed by the runtime. It should clear stale packets before installing a new one and must verify that the packet fingerprint matches the active generation context.

Default lanes:

- `recursion.sceneBrief`: scene-scoped packet content, reused while the scene remains valid.
- `recursion.turnBrief`: turn-scoped packet content, installed for the current generation.
- `recursion.guardrails`: compact high-priority constraints.
- `recursion.rawCriticalGuardrail`: optional exact statements for rare raw/direct exceptions.

Recommended depth behavior:

- Guardrails use the strongest Recursion lane priority and should be placed where they remain visible to the final generation without displacing SillyTavern's core character or system prompts.
- Turn Brief should be close to the current user message or active generation prompt because it is volatile and next-turn specific.
- Scene Brief should sit behind the Turn Brief as stable scene context, lower than strict guardrails but high enough to influence prose and continuity.
- Raw critical guardrails should be minimal, rare, and placed only as high as needed to protect the next response.

### User-Controlled Final Prompt Injection

V1 must include an advanced user setting group for the conditioned final prompt packet. The recommended concrete defaults are placement `in_prompt`, role `system`, and depth `4`, but advanced users can choose where the composed packet lands when a model or preset responds better to a different lane.

Settings contract:

- `injection.placement`: `in_prompt` or `in_chat`. The selected value applies to composed Recursion packet blocks.
- `injection.role`: `system`, `user`, or `assistant`. Default is `system`; unsupported host roles fall back to `system` and record a compact warning.
- `injection.depth`: an integer from `0` to `10`. Default is `4`; the selected numeric depth applies to composed Recursion packet blocks.

These settings apply only after Utility/Reasoner composition has produced the packet. They do not change card generation, Arbiter scoring, selected-hand contents, raw card storage, or external memory/lore behavior. They also do not create a per-card injection matrix; Recursion remains a composed-packet system, not a card micromanagement UI.

The runtime architecture owns the exact SillyTavern API calls, prompt identifiers, ordering, and cleanup behavior. This spec owns what Recursion is allowed to install and the policy constraints for that installation.

## Footprint Profiles

Prompt footprint is the size/detail control for the composed packet. The stored user setting is the baseline preference, and the Utility Arbiter may request a current-turn footprint only inside the policy defined by [Behavior Settings Policy Spec](../design/BEHAVIOR_SETTINGS_POLICY_SPEC.md). A valid current-turn footprint controls the packet being composed without mutating the stored setting.

### Compact

Compact is used when the scene is stable, the latest user message is straightforward, external context is already heavy, or provider confidence is low.

Typical shape:

- very short Turn Brief;
- critical Guardrails only;
- Scene Brief omitted or reduced to one sentence if already installed and fresh;
- no Reasoner unless explicitly justified.

Compact protects the active chat and external context from prompt bloat.

### Normal

Normal is the default. It includes all three packet sections within conservative caps.

Typical shape:

- concise Scene Brief;
- focused Turn Brief;
- short Guardrails list;
- selected-card references retained internally;
- Reasoner used only when Utility Arbiter sees material benefit.

Normal should be enough for most roleplay turns.

### Rich

Rich is used when the next response has high scene complexity or high risk of drift. It is still bounded and inspectable.

Typical shape:

- expanded Scene Brief with active cast, spatial state, and near-term pressure;
- more detailed Turn Brief with continuity and dialogue priorities;
- explicit Guardrails for high-risk contradictions;
- optional Reasoner synthesis when enabled and available.

Rich must not become a broad plot plan, transcript summary, or lore recap. It is a temporary current-turn response aid.

## Budgeting and Omission Reasons

Budgeting is part of the product contract. Recursion should prefer a smaller, sharper packet over exhaustive context. Each section has a soft cap and a hard cap; the packet has a total hard cap selected by the effective footprint profile. Strength can change assertiveness and selection pressure inside that footprint, but Prompt Footprint owns packet size.

Budget order:

1. Critical Guardrails.
2. Turn Brief scene constraints and plausibility traps.
3. Current user focus and response cues.
4. Scene Brief essentials.
5. Active cast and relationship posture.
6. Environment texture and prose craft guidance.
7. Lower-priority open threads.

Cards with higher emphasis are considered earlier, but emphasis does not override safety, freshness, ownership, or hard token caps. Detail profiles decide how much survives:

- terse cards usually become one clause or one bullet;
- balanced cards may become a sentence;
- descriptive cards may contribute texture only in normal or rich footprints.

Every excluded candidate that reached the composition stage should receive an omission reason. Standard omission reasons:

- `budget_exceeded`;
- `duplicate`;
- `already_in_scene_brief`;
- `already_in_external_context`;
- `external_owner`;
- `low_next_turn_need`;
- `stale_scene`;
- `stale_turn`;
- `weak_evidence`;
- `conflicts_with_user_message`;
- `would_rewrite_user_message`;
- `spoiler_or_future_plan`;
- `hidden_internal_thought`;
- `too_broad`;
- `provider_unavailable`;
- `reasoner_rejected`;
- `schema_invalid`;
- `raw_injection_not_critical`.

Omission reasons should appear in diagnostics and the inspector. They should not be injected into the model-facing prompt.

## Guardrails

Guardrails protect the prompt packet from becoming an invisible author, memory system, or hidden planner.

Composition guardrails:

- Compose from selected hand evidence; do not invent facts.
- Keep the packet current-scene oriented.
- Keep final prompt text inspectable.
- Do not store or inject hidden chain-of-thought.
- Do not include internal analysis dumps from Utility or Reasoner calls.
- Do not expose spoilers, secret motives, or future outcomes unless they are already player-visible and relevant.
- Do not write broad plot plans.
- Do not rewrite, correct, or replace the user's latest message.
- Do not decide player intent beyond what the user wrote.
- Do not include provider secrets or raw API diagnostics.
- Do not duplicate large blocks supplied by external context extensions.

Runtime guardrails:

- Validate packet schema before install.
- Enforce hard token caps.
- Clear stale packet lanes when chat, turn, scene, settings, or provider state invalidates them.
- Refuse Reasoner output that violates scope.
- Record fallbacks without exposing private provider details.
- Prefer no Recursion prompt over an invalid or stale prompt.

## External Extension Coexistence

Recursion is a near-term scene-reasoning compiler. It must coexist with, not replace, other SillyTavern context systems.

Memory Books and World Info own durable facts, lore, and authored background. Summaryception owns long transcript compression. VectFox owns vector-style recall. SillyTavern character prompts, author notes, presets, and instruct templates own the host's baseline generation behavior.

Recursion should:

- detect or summarize the prompt environment when the host exposes enough information;
- avoid restating broad lore or memory already present elsewhere;
- mark omitted candidates with `external_owner` or `already_in_external_context` when appropriate;
- keep its packet limited to current scene and next-turn writing value;
- respect host prompt order instead of assuming Recursion is the top-level system authority;
- avoid mutating external extension data;
- avoid requiring users to disable other context tools;
- degrade to compact footprint when the prompt environment is already crowded.

If external context conflicts with selected hand evidence, Recursion should not silently override it. The Utility Arbiter may flag a scene-constraint risk, but the composed packet should stay conservative unless the active chat clearly resolves the conflict.

## Prompt Packet Diagnostics

Diagnostics make prompt composition inspectable without turning Recursion into a card-management product.

Each composition run should record:

- packet id and version;
- run id;
- snapshot hash;
- chat id or sanitized alias;
- scene fingerprint and turn fingerprint;
- footprint profile;
- Utility Arbiter next-turn need summary;
- selected card refs with emphasis and detail profile;
- final section token estimates;
- total token estimate;
- injection lane and depth plan;
- Reasoner trigger, provider route, and result status;
- raw/direct guardrail exceptions;
- omissions with reasons;
- fallback path, if any;
- validation warnings;
- install, clear, or skip result.

Diagnostics should be visible through the UI inspector described by [UI Spec](../design/UI_SPEC.md) and persisted according to [Storage and Diagnostics](STORAGE_AND_DIAGNOSTICS.md). Stored diagnostics should be bounded, sanitized, and useful for understanding recent behavior. They should not contain provider secrets, hidden reasoning traces, full transcript copies, or unnecessary message text.

## V1 Cuts

V1 should stay focused on proving the compact prompt packet loop.

Cut from V1:

- direct injection of the full selected hand;
- user-authored card catalogs or per-card prompt editing;
- manual injection-depth matrix UI;
- long-term memory ownership;
- vector recall;
- transcript summarization;
- broad plot planning;
- hidden thought storage;
- chain-of-thought display;
- spoiler planning lanes;
- automatic mutation of Memory Books, World Info, Summaryception, VectFox, or SillyTavern prompts;
- multi-packet experiments competing for the same generation;
- legacy compatibility layers for early pre-alpha packet shapes.

Pre-alpha status allows Recursion to update prompt packet schemas, card fields, and storage records in place when the V1 contract improves. The invariant to preserve is product behavior: a compact, current-scene, inspectable packet composed from the selected hand and installed only when it helps the next generation.
