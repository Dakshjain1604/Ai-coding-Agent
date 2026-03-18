# Debug Skill

## Trigger

- /debug
- /fix
- "debug this"
- "fix this bug"

## Purpose

Diagnose and fix issues in code through systematic investigation.

## Instructions

### Step 1: Gather Information

- Read error message/stack trace
- Check relevant log files
- Review recent changes to the codebase
- Identify the affected component

### Step 2: Reproduce Issue

- Create minimal reproduction case
- Identify the exact conditions causing the bug
- Verify the bug is consistent

### Step 3: Root Cause Analysis

- Use debugging tools (console, debugger)
- Add temporary logging
- Check related code paths
- Identify the root cause

### Step 4: Propose Fix

- Consider multiple solutions
- Choose the best approach
- Evaluate potential side effects

### Step 5: Implement Fix

- Make the fix
- Test the fix
- Verify no regressions

## Common Debug Patterns

### Null/Undefined Errors

- Add null checks
- Provide default values
- Use optional chaining

### Async Errors

- Check await usage
- Add error handling
- Verify promises are awaited

### Logic Errors

- Add console logging
- Check boundary conditions
- Verify state transitions

### Performance Issues

- Profile the code
- Check for unnecessary loops
- Look for memory leaks

## Tools Required

- shell_exec (to run code)
- file_read
- file_write
- search (to find related code)
- git_diff (to see changes)

## Constraints

- NEVER commit debug code
- MUST verify fix works
- MUST test edge cases
- SHOULD add regression tests
