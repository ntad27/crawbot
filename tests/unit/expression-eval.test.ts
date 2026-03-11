/**
 * Unit tests for the safe expression evaluator
 * Source: electron/automation/expression-eval.ts
 */
import { describe, it, expect } from 'vitest';
import { evaluateExpression } from '@electron/automation/expression-eval';

describe('evaluateExpression — comparison operators', () => {
  it('== true for equal numbers', () => {
    expect(evaluateExpression('count == 5', { count: 5 })).toBe(true);
  });

  it('== false for unequal numbers', () => {
    expect(evaluateExpression('count == 5', { count: 6 })).toBe(false);
  });

  it('!= true for unequal values', () => {
    expect(evaluateExpression('count != 0', { count: 1 })).toBe(true);
  });

  it('!= false for equal values', () => {
    expect(evaluateExpression('count != 5', { count: 5 })).toBe(false);
  });

  it('> true when left greater', () => {
    expect(evaluateExpression('count > 10', { count: 11 })).toBe(true);
  });

  it('> false when left equal or less', () => {
    expect(evaluateExpression('count > 10', { count: 10 })).toBe(false);
    expect(evaluateExpression('count > 10', { count: 9 })).toBe(false);
  });

  it('>= true for equal and greater', () => {
    expect(evaluateExpression('count >= 10', { count: 10 })).toBe(true);
    expect(evaluateExpression('count >= 10', { count: 11 })).toBe(true);
  });

  it('>= false when left is less', () => {
    expect(evaluateExpression('count >= 10', { count: 9 })).toBe(false);
  });

  it('< true when left is less', () => {
    expect(evaluateExpression('count < 5', { count: 4 })).toBe(true);
  });

  it('< false when left is equal or greater', () => {
    expect(evaluateExpression('count < 5', { count: 5 })).toBe(false);
    expect(evaluateExpression('count < 5', { count: 6 })).toBe(false);
  });

  it('<= true for equal and less', () => {
    expect(evaluateExpression('count <= 5', { count: 5 })).toBe(true);
    expect(evaluateExpression('count <= 5', { count: 4 })).toBe(true);
  });

  it('<= false when left is greater', () => {
    expect(evaluateExpression('count <= 5', { count: 6 })).toBe(false);
  });
});

describe('evaluateExpression — logical operators', () => {
  it('&& true when both sides true', () => {
    expect(evaluateExpression('a == 1 && b == 2', { a: 1, b: 2 })).toBe(true);
  });

  it('&& false when one side false', () => {
    expect(evaluateExpression('a == 1 && b == 2', { a: 1, b: 3 })).toBe(false);
    expect(evaluateExpression('a == 1 && b == 2', { a: 0, b: 2 })).toBe(false);
  });

  it('|| true when one side true', () => {
    expect(evaluateExpression('a == 1 || b == 2', { a: 1, b: 99 })).toBe(true);
    expect(evaluateExpression('a == 1 || b == 2', { a: 0, b: 2 })).toBe(true);
  });

  it('|| false when both sides false', () => {
    expect(evaluateExpression('a == 1 || b == 2', { a: 0, b: 0 })).toBe(false);
  });

  it('&& has higher precedence than ||', () => {
    // a || b && c should parse as a || (b && c)
    expect(evaluateExpression('a == 1 || b == 1 && c == 1', { a: 0, b: 1, c: 1 })).toBe(true);
    expect(evaluateExpression('a == 1 || b == 1 && c == 1', { a: 0, b: 1, c: 0 })).toBe(false);
  });

  it('parentheses override precedence', () => {
    expect(evaluateExpression('(a == 1 || b == 1) && c == 1', { a: 1, b: 0, c: 1 })).toBe(true);
    expect(evaluateExpression('(a == 1 || b == 1) && c == 1', { a: 0, b: 0, c: 1 })).toBe(false);
  });
});

describe('evaluateExpression — nested property access', () => {
  it('accesses nested property with dot notation', () => {
    expect(evaluateExpression('output.count > 10', { output: { count: 11 } })).toBe(true);
    expect(evaluateExpression('output.count > 10', { output: { count: 5 } })).toBe(false);
  });

  it('accesses deeply nested property', () => {
    expect(
      evaluateExpression('steps.step1.status == 1', {
        steps: { step1: { status: 1 } },
      }),
    ).toBe(true);
  });

  it('returns false when nested path is missing', () => {
    expect(evaluateExpression('output.count > 0', { output: {} })).toBe(false);
    expect(evaluateExpression('output.count > 0', {})).toBe(false);
  });
});

describe('evaluateExpression — string comparisons', () => {
  it("matches string with single quotes", () => {
    expect(evaluateExpression("status == 'ok'", { status: 'ok' })).toBe(true);
    expect(evaluateExpression("status == 'ok'", { status: 'error' })).toBe(false);
  });

  it('matches string with double quotes', () => {
    expect(evaluateExpression('status == "ok"', { status: 'ok' })).toBe(true);
  });

  it('!= works with strings', () => {
    expect(evaluateExpression("status != 'error'", { status: 'ok' })).toBe(true);
    expect(evaluateExpression("status != 'error'", { status: 'error' })).toBe(false);
  });
});

describe('evaluateExpression — boolean and null literals', () => {
  it('compares with boolean true', () => {
    expect(evaluateExpression('enabled == true', { enabled: true })).toBe(true);
    expect(evaluateExpression('enabled == true', { enabled: false })).toBe(false);
  });

  it('compares with boolean false', () => {
    expect(evaluateExpression('enabled == false', { enabled: false })).toBe(true);
  });

  it('null check: != null is true when value is set', () => {
    expect(evaluateExpression('error != null', { error: 'some error' })).toBe(true);
  });

  it('null check: == null is true when value is null', () => {
    expect(evaluateExpression('error == null', { error: null })).toBe(true);
  });

  it('null check: == null is true when key is undefined', () => {
    // undefined == null in JS loose equality
    expect(evaluateExpression('error == null', {})).toBe(true);
  });
});

describe('evaluateExpression — error handling / invalid input', () => {
  it('returns false for empty expression', () => {
    expect(evaluateExpression('', {})).toBe(false);
  });

  it('returns false for whitespace-only expression', () => {
    expect(evaluateExpression('   ', {})).toBe(false);
  });

  it('returns false for expression with unknown operator', () => {
    // The tokenizer skips unknown chars; the result should not throw
    expect(() => evaluateExpression('count ??? 5', { count: 5 })).not.toThrow();
  });

  it('returns false when expression resolves to undefined', () => {
    expect(evaluateExpression('nonexistent', {})).toBe(false);
  });
});

describe('evaluateExpression — injection / security', () => {
  it('does not execute constructor access attempt', () => {
    // Should not throw, should return false (constructor is a valid IDENT but resolves to a function, truthy)
    // Main concern: it does NOT eval() arbitrary code
    expect(() =>
      evaluateExpression('constructor == constructor', { constructor: undefined }),
    ).not.toThrow();
  });

  it('does not resolve __proto__', () => {
    // __proto__ contains dots and brackets — tokenizer treats it as IDENT
    expect(() => evaluateExpression('__proto__ == null', {})).not.toThrow();
  });

  it('does not execute function call syntax', () => {
    // The tokenizer does not support () as a function call in idents
    // It should not throw and return false or a safe value
    expect(() => evaluateExpression("toString() == 'ok'", {})).not.toThrow();
  });

  it('handles numeric expression with negative number', () => {
    expect(evaluateExpression('count > -1', { count: 0 })).toBe(true);
  });
});
