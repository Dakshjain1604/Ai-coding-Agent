# Code Review

## Trigger

- /review
- /pr
- "review this code"
- "review changes"

## Purpose

Perform thorough code review following project standards with actionable feedback.

## Review Checklist

### Code Quality

- [ ] DRY: No repeated logic
- [ ] SOLID principles followed
- [ ] No magic numbers/strings
- [ ] Meaningful variable/function names

### Security

- [ ] No hardcoded credentials
- [ ] Input validation present
- [ ] SQL injection prevention
- [ ] XSS prevention

### Performance

- [ ] No N+1 queries
- [ ] Efficient data structures
- [ ] No unnecessary re-renders (frontend)

### Testing

- [ ] Unit tests for new logic
- [ ] Edge cases covered
- [ ] Integration tests for APIs

### Documentation

- [ ] Complex logic explained
- [ ] Public APIs documented
- [ ] README updated if needed

## Output Format

## Summary

Brief overall assessment

## Critical Issues 🚨

- [Issue 1] (file:line)
- [Issue 2] (file:line)

## Suggestions 💡

- [Suggestion 1]
- [Suggestion 2]

## Questions ❓

- [Question about code intent]

## Approved Changes ✓

- [What looks good]

## Tools Required

- file_read
- git_diff
- search

## Constraints

- Be constructive, not critical
- Focus on important issues first
- Acknowledge good patterns
