# Scene selection and character sense-making evaluation

Scope: source-based qualitative review and deterministic runtime regressions. This is not a live SillyTavern narrator comparison, and does not establish a measured improvement in generated prose.

## Acceptance criteria

- A surprising claim can prompt clarification of meaning and answerable questions, shaped by the character's knowledge and personal stakes.
- Doubt, trust, and willingness to help are distinct. Neither immediate acceptance nor perpetual suspicion is prescribed.
- Fear, anger, and unfairness remain possible when grounded in the character and relationship; the cards do not require uniformly rational dialogue.
- A question or proposed test should offer relevant information the other person could reasonably supply. Failure to perform an ability need not prove its absence.
- Unresolved truth permits conversational progress and provisional action. Established reveal boundaries and player agency remain protected.
- The hand should differ when the scene's unresolved work differs. Mandatory Priority cards always survive; optional cards should each add something distinct.

## Cases reviewed

| Case | Useful contribution | Failure to avoid | Source review result |
| --- | --- | --- | --- |
| A familiar person claims to be someone else and unable to use an expected ability; friends are shocked and privacy is requested | Knowledge distinguishes interpretations and answerable uncertainty; Motivation connects concern for the missing friend to questions; Relationship permits privacy without accepting the explanation | Impossible proof demand; generic disbelief; invented facts about the missing person; frozen confrontation | Revised stock instructions explicitly support clarification and concern while leaving the truth unresolved |
| A stranger makes an extraordinary identity claim | Knowledge and Relationship preserve limited evidence and lack of established trust; precautions may be proportionate | Automatic trust or mandatory cooperation merely because the speaker asks | Help is permitted, not required; claims remain distinct from knowledge |
| An exit is blocked while danger approaches | Environment, Items, and Consequences can have higher marginal value than social interpretation | Mandatory social questioning or fixed scene bookkeeping crowds out urgent action | Arbiter instructions favor the scene's actual need; ordered selection retains those physical families |

These judgments were independently reviewed against the revised instructions. They are design evaluations, not sampled narrator outputs. The original diagnostics did not contain both requested narrative swipes, so no verbatim before/after prose comparison is claimed.

## Executable evidence

- `test-scene-aware-selection.mjs`: identity-revelation and blocked-escape proposals retain different literal expected families; final hand order survives reversed generation order; mandatory families survive exhausted discretionary capacity.
- `test-runtime-preprocess.mjs`: scene-specific proposals reach the final hand; disabled-family proposals remain visible with eligibility omissions distinct from budget omissions; successful model plans have no fallback label; new turns do not silently consume old scene cards; old selection checkpoints become stale.
- `test-runtime.mjs`: both Segmented and Fused paths preserve mandatory authored and generated Priority coverage above and below the ordinary hand limit and install their evidence.
- `test-diagnostics.mjs`: compact export preserves proposal, omission, and actual selected-source evidence.

The remaining empirical question is how the user's narrator model responds to the revised guidance in real play. A live evaluation should compare multiple fresh turns under equivalent model/preset settings, score these criteria, and report individual failures rather than treating a green runtime suite as proof of writing quality. It must not regenerate or alter the user's live story without authorization.
