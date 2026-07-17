# Redirect Experimental Label Design

## Goal

Mark Redirect as experimental in the Enhancements selector without changing
its stored mode, runtime behavior, ordering, icon, or description.

## UI Contract

The Redirect row renders one inline label group:

```html
<span class="recursion-enhancements-choice-name">
  <span>Redirect</span>
  <small class="recursion-enhancements-choice-qualifier">Experimental</small>
</span>
```

`Redirect` remains the primary 11.5px choice label. `Experimental` uses the
existing 10px helper scale, muted foreground color, normal weight, and a small
inline gap. It remains on the same line when space permits and does not alter
the other Enhancement rows.

The Redirect button exposes `Redirect (Experimental)` through its accessible
name. The stored option value remains `redirect`, and compact status surfaces
continue to use `Redirect` where they describe the active mode rather than the
menu option's maturity.

## Integration

Add an optional qualifier to the Redirect entry in
`ENHANCEMENT_TARGET_OPTIONS`. `enhancementTargetChoice` renders the qualifier
only when present. This keeps the maturity label owned by option metadata and
avoids mode-specific DOM branching.

Update `docs/design/UI_SPEC.md` so the visible menu contract records the
experimental qualifier.

## Tests

Focused UI tests must assert:

- the Redirect row contains visible `Redirect` and `Experimental` text;
- the qualifier has its dedicated subordinate class;
- other Enhancement rows do not render a qualifier;
- the Redirect button's accessible label is `Redirect (Experimental)`;
- the underlying choice value and mode order remain unchanged.

The CSS contract test must assert that the qualifier uses the 10px helper scale
and muted treatment. The full repository suite must pass after implementation.
