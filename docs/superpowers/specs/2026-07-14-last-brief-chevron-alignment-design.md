# Last Brief Chevron Alignment

## Scope

Vertically center the per-card disclosure chevrons in the Last Brief dropdown. The existing card-kind row already uses flex alignment, so the change removes the chevrons' explicit downward translations while preserving their size, rotation, expanded state, and row geometry.

## Verification

The UI contract test will assert that the collapsed and expanded chevron rules use rotation without `translateY` offsets.
