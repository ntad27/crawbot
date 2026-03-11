/**
 * Safe Expression Evaluator
 * Parses and evaluates simple boolean expressions against a context object.
 * NO eval() or new Function() — fully tokenized and interpreted.
 *
 * Supported operators: ==, !=, >, <, >=, <=, &&, ||
 * Supported literals: string ('ok', "error"), number, boolean (true/false), null
 * Dot notation for nested access: output.count, steps.step1.status
 */

// ---- Tokenizer ----

type TokenKind =
  | 'STRING'
  | 'NUMBER'
  | 'BOOL'
  | 'NULL'
  | 'IDENT'
  | 'EQ'
  | 'NEQ'
  | 'GT'
  | 'GTE'
  | 'LT'
  | 'LTE'
  | 'AND'
  | 'OR'
  | 'LPAREN'
  | 'RPAREN'
  | 'EOF';

interface Token {
  kind: TokenKind;
  value: unknown;
  raw: string;
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    // Skip whitespace
    if (/\s/.test(expr[i])) {
      i++;
      continue;
    }

    // String literals
    if (expr[i] === "'" || expr[i] === '"') {
      const quote = expr[i];
      i++;
      let str = '';
      while (i < expr.length && expr[i] !== quote) {
        if (expr[i] === '\\' && i + 1 < expr.length) {
          i++;
          str += expr[i];
        } else {
          str += expr[i];
        }
        i++;
      }
      i++; // consume closing quote
      tokens.push({ kind: 'STRING', value: str, raw: str });
      continue;
    }

    // Two-char operators
    const two = expr.slice(i, i + 2);
    if (two === '==') {
      tokens.push({ kind: 'EQ', value: '==', raw: '==' });
      i += 2;
      continue;
    }
    if (two === '!=') {
      tokens.push({ kind: 'NEQ', value: '!=', raw: '!=' });
      i += 2;
      continue;
    }
    if (two === '>=') {
      tokens.push({ kind: 'GTE', value: '>=', raw: '>=' });
      i += 2;
      continue;
    }
    if (two === '<=') {
      tokens.push({ kind: 'LTE', value: '<=', raw: '<=' });
      i += 2;
      continue;
    }
    if (two === '&&') {
      tokens.push({ kind: 'AND', value: '&&', raw: '&&' });
      i += 2;
      continue;
    }
    if (two === '||') {
      tokens.push({ kind: 'OR', value: '||', raw: '||' });
      i += 2;
      continue;
    }

    // Single-char operators
    if (expr[i] === '>') {
      tokens.push({ kind: 'GT', value: '>', raw: '>' });
      i++;
      continue;
    }
    if (expr[i] === '<') {
      tokens.push({ kind: 'LT', value: '<', raw: '<' });
      i++;
      continue;
    }
    if (expr[i] === '(') {
      tokens.push({ kind: 'LPAREN', value: '(', raw: '(' });
      i++;
      continue;
    }
    if (expr[i] === ')') {
      tokens.push({ kind: 'RPAREN', value: ')', raw: ')' });
      i++;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(expr[i]) || (expr[i] === '-' && /[0-9]/.test(expr[i + 1] ?? ''))) {
      let num = expr[i];
      i++;
      while (i < expr.length && /[0-9.]/.test(expr[i])) {
        num += expr[i];
        i++;
      }
      tokens.push({ kind: 'NUMBER', value: parseFloat(num), raw: num });
      continue;
    }

    // Identifiers (including dot-notation paths), keywords: true, false, null
    if (/[a-zA-Z_$]/.test(expr[i])) {
      let ident = '';
      while (i < expr.length && /[a-zA-Z0-9_$.[\]]/.test(expr[i])) {
        ident += expr[i];
        i++;
      }
      if (ident === 'true') {
        tokens.push({ kind: 'BOOL', value: true, raw: ident });
      } else if (ident === 'false') {
        tokens.push({ kind: 'BOOL', value: false, raw: ident });
      } else if (ident === 'null') {
        tokens.push({ kind: 'NULL', value: null, raw: ident });
      } else {
        tokens.push({ kind: 'IDENT', value: ident, raw: ident });
      }
      continue;
    }

    // Unknown character — skip
    i++;
  }

  tokens.push({ kind: 'EOF', value: null, raw: '' });
  return tokens;
}

// ---- Parser / Evaluator ----

class Parser {
  private tokens: Token[];
  private pos = 0;
  private context: Record<string, unknown>;

  constructor(tokens: Token[], context: Record<string, unknown>) {
    this.tokens = tokens;
    this.context = context;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private consume(): Token {
    return this.tokens[this.pos++];
  }

  // Resolve dot-notation path against context
  private resolveIdent(path: string): unknown {
    const parts = path.split('.');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let current: any = this.context;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return undefined;
      current = current[part];
    }
    return current;
  }

  // Parse primary: literal, identifier, or parenthesized expression
  private parsePrimary(): unknown {
    const tok = this.peek();

    if (tok.kind === 'LPAREN') {
      this.consume();
      const val = this.parseOr();
      if (this.peek().kind === 'RPAREN') this.consume();
      return val;
    }

    if (tok.kind === 'STRING' || tok.kind === 'NUMBER' || tok.kind === 'BOOL' || tok.kind === 'NULL') {
      this.consume();
      return tok.value;
    }

    if (tok.kind === 'IDENT') {
      this.consume();
      return this.resolveIdent(tok.value as string);
    }

    // Unexpected token
    return undefined;
  }

  // Parse comparison: primary op primary
  private parseComparison(): unknown {
    const left = this.parsePrimary();
    const op = this.peek();

    if (
      op.kind === 'EQ' ||
      op.kind === 'NEQ' ||
      op.kind === 'GT' ||
      op.kind === 'GTE' ||
      op.kind === 'LT' ||
      op.kind === 'LTE'
    ) {
      this.consume();
      const right = this.parsePrimary();

      switch (op.kind) {
        case 'EQ':
           
          return left == right;
        case 'NEQ':
           
          return left != right;
        case 'GT':
          return (left as number) > (right as number);
        case 'GTE':
          return (left as number) >= (right as number);
        case 'LT':
          return (left as number) < (right as number);
        case 'LTE':
          return (left as number) <= (right as number);
      }
    }

    return left;
  }

  // Parse && (AND)
  private parseAnd(): unknown {
    let left = this.parseComparison();

    while (this.peek().kind === 'AND') {
      this.consume();
      const right = this.parseComparison();
      left = Boolean(left) && Boolean(right);
    }

    return left;
  }

  // Parse || (OR)
  parseOr(): unknown {
    let left = this.parseAnd();

    while (this.peek().kind === 'OR') {
      this.consume();
      const right = this.parseAnd();
      left = Boolean(left) || Boolean(right);
    }

    return left;
  }
}

/**
 * Evaluate an expression string against a context object.
 * Returns boolean result, defaults to false on parse/eval errors.
 */
export function evaluateExpression(expr: string, context: Record<string, unknown>): boolean {
  try {
    const tokens = tokenize(expr.trim());
    const parser = new Parser(tokens, context);
    const result = parser.parseOr();
    return Boolean(result);
  } catch {
    return false;
  }
}
