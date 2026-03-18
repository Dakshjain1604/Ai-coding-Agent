# Release Workflow

## Trigger

- /release
- /ship
- "create a release"
- "publish version"

## Purpose

Complete release workflow from version bump to publication.

## Workflow

### Step 1: Pre-flight Checks

- Run: npm test (or equivalent)
- Check: git status (must be clean)
- Verify: branch up-to-date with origin/main
- If any fail: stop and report issues

### Step 2: Version Bump

- Read: package.json version
- Ask: version bump type (major|minor|patch)
- Update: package.json, CHANGELOG.md, any other version files
- Commit: "chore: bump version to X.Y.Z"

### Step 3: Changelog Generation

- Fetch: commits since last tag
- Group: by type (feat, fix, refactor, etc.)
- Generate: CHANGELOG.md entry
- Format: Keep existing entries, add new at top

### Step 4: Git Operations

- Create: release/vX.Y.Z branch
- Commit: version bump changes
- Tag: vX.Y.Z (annotated)
- Push: branch and tag to origin

### Step 5: Post-release

- Create: GitHub release with changelog
- Trigger: CI/CD pipeline
- Notify: team channels (optional)

## Rollback Procedure

If any step fails after version bump:

1. Delete tag: git tag -d vX.Y.Z
2. Delete remote tag: git push --delete origin vX.Y.Z
3. Revert commits: git revert HEAD~n
4. Report: failure reason and rollback status

## Tools Required

- git
- file_read
- file_write
- shell_exec

## Constraints

- NEVER release from main directly
- NEVER skip tests
- NEVER force push tags
- MUST confirm version before tagging
