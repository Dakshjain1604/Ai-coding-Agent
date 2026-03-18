# Test Generation Skill

## Trigger

- /test
- /testgen
- "generate tests"
- "write tests for"

## Purpose

Generate comprehensive unit and integration tests for code.

## Instructions

### Step 1: Analyze Target Code

- Read the code to test
- Identify public APIs and functions
- Note edge cases and error conditions
- Check existing tests to avoid duplication

### Step 2: Determine Test Coverage Goals

- Aim for high coverage of business logic
- Focus on critical paths
- Include edge cases
- Test error conditions

### Step 3: Generate Tests

- Write unit tests for each function
- Test happy path and error cases
- Use descriptive test names
- Include setup/teardown as needed

### Step 4: Verify Tests

- Run generated tests
- Fix any syntax errors
- Ensure tests pass
- Check coverage report

## Test Structure

### Unit Test Template

```typescript
describe('FunctionName', () => {
  describe('when input is valid', () => {
    it('should return expected result', () => {
      // Arrange
      const input = ...;
      const expected = ...;

      // Act
      const result = functionName(input);

      // Assert
      expect(result).toEqual(expected);
    });
  });

  describe('when input is invalid', () => {
    it('should throw error', () => {
      // Arrange
      const input = ...;

      // Act & Assert
      expect(() => functionName(input)).toThrow();
    });
  });
});
```

### Integration Test Template

```typescript
describe("API Endpoint", () => {
  beforeAll(async () => {
    // Setup test database
    // Start test server
  });

  afterAll(async () => {
    // Cleanup
  });

  it("should return success for valid request", async () => {
    const response = await request(app)
      .post("/api/endpoint")
      .send({ data: "test" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true });
  });
});
```

## Tools Required

- file_read
- file_write
- shell_exec (to run tests)

## Constraints

- MUST follow project test conventions
- MUST use existing test framework
- MUST be deterministic (no flaky tests)
- MUST have meaningful assertions
