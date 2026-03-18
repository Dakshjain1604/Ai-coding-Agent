# Commit Skill

## Trigger

- /commit
- /cc
- "create a commit"
- "commit changes"

## Purpose

Create well-structured git commits following team conventions with proper co-authorship.

## Instructions

1. Analyze all staged changes using `git diff --cached`
2. If no changes staged, show `git status` and ask what to stage
3. Group changes by logical concern
4. Generate commit message following format:
   - Type: feat|fix|refactor|docs|test|chore|perf|ci
   - Scope: affected module in parentheses (optional)
   - Description: imperative mood, lowercase, no trailing period
   - Body: explain WHY, not WHAT
5. Show diff summary and message for confirmation
6. Execute commit only after confirmation

## Examples

### Input

```
Added user authentication with JWT tokens
```

### Output

```
feat(auth): add user authentication with JWT

- Implement login/logout endpoints
- Add JWT validation middleware
- Configure token refresh flow
- Add password hashing with bcrypt

Why: Users need secure authentication to access protected routes.

Co-Authored-By: CodingAgent <agent@coding.dev>
```

## Tools Required

- git_status
- git_diff
- git_commit
- file_read

## Constraints

- NEVER use --no-verify flag
- NEVER commit to main/master directly
- NEVER exceed 72 chars in title
- MUST ask confirmation before committing

## Error Handling

- If pre-commit fails: show error, offer to fix or abort
- If branch is main: warn and ask to create feature branch
- If sensitive files detected: warn and ask confirmation
