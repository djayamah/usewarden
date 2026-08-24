# Every rule in your policy can actually fire

`usewarden policy` prints the rules protecting you. Until 2026-08-24 it printed one that could not
fire, and had done for months.

## What happened

`context.warn_pct` warns when the model's context window fills up. It reads a field called
`contextFill` on the normalized event. **No agent sends that field.** Claude Code's hook payload is
the best documented of the six usewarden supports and carries `session_id`, `prompt_id`,
`transcript_path`, `cwd`, `permission_mode`, `effort`, `hook_event_name`, `tool_name`, `tool_input`
and `tool_use_id` — and no token count, no context percentage, no remaining-context figure
(<https://code.claude.com/docs/en/hooks>, checked 2026-08-24).

The rule had a unit test and the test passed, because **the test supplied the field the product
never receives**. It proved the arithmetic was right and said nothing about whether the input ever
arrives. A user reading their own policy saw a protection they did not have.

## What changed

1. **`context.warn_pct` is `null` by default.** The logic is kept and still tested; it is no longer
   switched on. Setting it opts in to a rule documented as not-yet-implemented.
2. **`usewarden policy` refuses to print a rule whose every input is unpopulated.** It is removed
   from the printed document and listed separately, by name, with the reason — because suppressing
   it silently would swap one misleading output for a quieter one.
3. **The sabotage suite's headline came down, and the scenario stayed.** Layer-1 coverage was
   reported as 15 of 17. One of those catches was this rule, scored against a synthetic field. It
   is now **14 of 17**, and the scenario remains in the denominator marked as a miss. Deleting it
   would have raised the percentage by hiding the correction.

## The control that stops it happening again

The fix above is worth little on its own — the next rule can be added the same way tomorrow. So
`tests/policy-inputs.test.ts` does two things on every run:

- it **scans `src/adapters/`** to derive which event fields are really populated, and fails if the
  declaration in `src/policy/inputs.ts` disagrees, so the declaration cannot rot;
- it **enumerates every active element of the default policy** and fails if any of them depends on
  a field outside that set.

If that second check ever fails, there are two acceptable answers: wire the input, or take the rule
out of the default and document it as opt-in. "It is covered by a unit test" is not one of them.

A section that loses *one* of several inputs is narrowed, not killed — `scope.forbidden_paths`
reads both `filePath` and `command` and fires on either — so the check only reports a rule dead when
**every** input it needs is missing. A control that cries wolf is a control that gets switched off.

## Turning it on anyway

```yaml
context:
  warn_pct: 60      # opts in to a rule that cannot fire until an agent reports context fill
```

usewarden will accept it and say plainly that nothing populates the field yet.

## If an agent starts reporting it

Add the field in `normalizeCommon` (`src/adapters/index.ts`), add it to
`ADAPTER_POPULATED_FIELDS`, and restore the default. The adapter scan will fail until the
declaration is updated, which is the point. Three statements need to change together: this page,
the README limitation, and `src/receipt.ts`'s unavailability reason.
