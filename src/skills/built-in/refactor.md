# Refactor Skill

## Trigger

- /refactor
- /refactor
- "refactor this code"
- "improve this code"

## Purpose

Refactor code to improve readability, maintainability, and performance while preserving behavior.

## Instructions

### Step 1: Analyze Current Code

- Read and understand the entire file/module
- Identify code smells and issues
- Check existing tests to understand expected behavior
- Note any edge cases in current implementation

### Step 2: Plan Refactoring

- List specific improvements to make
- Group related changes
- Ensure each change is atomic and testable
- Identify any potential breaking changes

### Step 3: Execute Refactoring

- Make changes incrementally
- Run tests after each significant change
- Preserve comments that explain WHY
- Update variable names for clarity
- Extract repeated logic into functions
- Simplify complex conditionals
- Remove dead code

### Step 4: Verify

- Run full test suite
- Verify no behavioral changes
- Review diff for unintended modifications
- Ensure all tests pass

## Common Refactorings

### Naming

- Rename variables/functions to be descriptive
- Use consistent naming conventions
- Avoid abbreviations unless well-known

### Functions

- Extract helper functions
- Reduce function complexity
- Use early returns
- Limit parameters (max 3)

### Classes

- Apply SOLID principles
- Extract related methods
- Remove feature envy
- Remove dead code

### Code Style

- Consistent formatting
- Remove magic numbers
- Add type hints
- Improve comments

## Tools Required

- file_read
- file_write
- search
- shell_exec (for tests)

## Constraints

- NEVER change behavior without explicit approval
- NEVER remove tests
- MUST run tests after refactoring
- MUST preserve API contracts
