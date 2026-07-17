# Redirect Reasoner Routing and Status Severity Design

## Status

Approved for implementation on 2026-07-17.

## Redirect Writer Routing

Redirect diagnosis, transformation, and verification remain separate model roles.
Only `editorialTransformer` writes the final Redirect prose.

- Low routes the Redirect transformer through Utility.
- Medium, High, and Ultra route the Redirect transformer through Reasoner.
- Medium and above make at most two actual Reasoner transformer model calls.
- The second call receives the first provider or semantic-validation failure as
  correction context.
- Provider-internal retry is disabled for these calls so the two-call ceiling is
  literal.
- A second failure ends Redirect, preserves the original assistant response, and
  never falls back to Utility.
- Repair and Recompose retain their existing routing and recovery behavior.

## Visible Severity

Recursion continues to use its existing status surfaces. It does not restore the
hidden activity ribbon and does not add toast notifications.

Every user-facing status surface derives color from one normalized severity:

- `error` uses `--recursion-error` (`#ff8a8a`);
- `warning` uses `--recursion-warning` (`#ffd479`);
- other severities retain their existing neutral treatment.

The contract covers the desktop current-step text, mobile status drawer, progress
title and subtitle, and warning/failed progress row labels, metadata, and reasons.
The UI carries severity through semantic `data-recursion-severity` attributes and
existing row state classes. It does not recolor chat prose, settings content, or
normal operational chrome.

## Verification

Focused runtime tests prove Low Utility routing, Medium+ Reasoner routing, exactly
two failed Reasoner writer calls, correction context on the second call, no Utility
fallback, original preservation, and no swipe mutation.

Focused UI tests prove warning and error severity attributes and CSS token usage on
desktop, mobile, progress headers, and progress rows. The complete `npm.cmd test`
suite remains the regression gate before deployment.
