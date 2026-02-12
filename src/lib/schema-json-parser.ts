/**
 * Schema-aware JSON parser for LLM output.
 *
 * LLMs frequently produce JSON with unescaped double quotes inside string
 * values. Generic parsers (including jsonrepair) can't resolve the ambiguity
 * because they don't know where one field ends and the next begins. This
 * parser uses a declared field order to anchor string boundaries: a closing
 * quote is only accepted when it's followed by the next expected field name
 * (or the object's closing brace for the last field).
 */

type FieldType = 'string' | 'string[]';

export interface FieldDef {
  name: string;
  type: FieldType;
}

class ParseError extends Error {
  constructor(message: string, public readonly position: number) {
    super(`${message} (at position ${position})`);
    this.name = 'ParseError';
  }
}

export function parseItemsArray<T>(
  json: string,
  fields: FieldDef[]
): T[] {
  const p = new Parser(json, fields);
  return p.parse() as T[];
}

class Parser {
  private pos = 0;

  constructor(
    private json: string,
    private fields: FieldDef[]
  ) {}

  parse(): Record<string, unknown>[] {
    // Navigate to the items array: { "items": [ ... ] }
    this.skipTo('{');
    this.advance(); // skip {
    this.expectKey('items');
    this.skipTo('[');
    this.advance(); // skip [
    this.skipWs();

    const items: Record<string, unknown>[] = [];

    while (!this.atEnd() && this.peek() !== ']') {
      items.push(this.parseObject());
      this.skipWs();
      this.tryConsume(',');
      this.skipWs();
    }

    return items;
  }

  private parseObject(): Record<string, unknown> {
    this.skipTo('{');
    this.advance(); // skip {
    this.skipWs();

    const item: Record<string, unknown> = {};

    for (let i = 0; i < this.fields.length; i++) {
      const field = this.fields[i];
      const nextField = i < this.fields.length - 1 ? this.fields[i + 1] : null;

      this.expectKey(field.name);
      this.skipWs();

      if (field.type === 'string') {
        item[field.name] = this.readAnchoredString(nextField?.name ?? null);
      } else {
        item[field.name] = this.readStringArray();
      }

      this.skipWs();
      this.tryConsume(',');
      this.skipWs();
    }

    this.skipTo('}');
    this.advance(); // skip }
    return item;
  }

  /**
   * Read a string value using the next field name as an anchor.
   *
   * When we encounter a `"`, we check whether it's the real closing quote by
   * looking ahead for the expected continuation:
   *   - If nextField is set: `"` must be followed by `, "nextField":`
   *   - If nextField is null (last field): `"` must be followed by `}` or `,`
   *     (trailing comma before `}`)
   *
   * Any `"` that doesn't match the anchor is treated as embedded content.
   */
  private readAnchoredString(nextField: string | null): string {
    this.expect('"');
    this.advance(); // skip opening "
    const start = this.pos;
    const parts: string[] = [];
    let segStart = this.pos;

    while (!this.atEnd()) {
      const ch = this.json[this.pos];

      if (ch === '\\') {
        // Escape sequence — consume both chars
        this.pos += 2;
        continue;
      }

      if (ch === '"') {
        if (this.isClosingQuote(nextField)) {
          parts.push(this.json.slice(segStart, this.pos));
          this.advance(); // skip closing "
          return this.unescape(parts.join(''));
        }
        // Embedded quote — replace it with escaped version
        parts.push(this.json.slice(segStart, this.pos));
        parts.push('\\"');
        this.pos++;
        segStart = this.pos;
        continue;
      }

      this.pos++;
    }

    throw new ParseError('Unterminated string', start);
  }

  private isClosingQuote(nextField: string | null): boolean {
    // Save position for lookahead
    let j = this.pos + 1;
    j = this.skipWsFrom(j);

    if (nextField !== null) {
      // Expect: , "nextField" :
      if (this.json[j] !== ',') return false;
      j++;
      j = this.skipWsFrom(j);
      if (this.json[j] !== '"') return false;
      j++;
      if (this.json.slice(j, j + nextField.length) !== nextField) return false;
      j += nextField.length;
      if (this.json[j] !== '"') return false;
      j++;
      j = this.skipWsFrom(j);
      return this.json[j] === ':';
    } else {
      // Last field — expect } (possibly with trailing comma)
      if (this.json[j] === '}') return true;
      if (this.json[j] === ',') {
        j++;
        j = this.skipWsFrom(j);
        return this.json[j] === '}';
      }
      if (j >= this.json.length) return true;
      if (this.json[j] === ']') return true;
      return false;
    }
  }

  private readStringArray(): string[] {
    this.expect('[');
    this.advance(); // skip [
    this.skipWs();

    const values: string[] = [];

    while (!this.atEnd() && this.peek() !== ']') {
      values.push(this.readSimpleString());
      this.skipWs();
      this.tryConsume(',');
      this.skipWs();
    }

    this.expect(']');
    this.advance(); // skip ]
    return values;
  }

  /** Read a regular JSON string (no embedded-quote concerns). */
  private readSimpleString(): string {
    this.expect('"');
    this.advance(); // skip opening "
    const start = this.pos;

    while (!this.atEnd()) {
      const ch = this.json[this.pos];
      if (ch === '\\') { this.pos += 2; continue; }
      if (ch === '"') {
        const value = this.json.slice(start, this.pos);
        this.advance(); // skip closing "
        return this.unescape(value);
      }
      this.pos++;
    }

    throw new ParseError('Unterminated string', start);
  }

  private expectKey(name: string): void {
    this.skipTo('"');
    this.advance(); // skip "
    const keyStart = this.pos;
    const keyEnd = this.json.indexOf('"', keyStart);
    if (keyEnd === -1) throw new ParseError(`Unterminated key`, keyStart);
    const key = this.json.slice(keyStart, keyEnd);
    if (key !== name) {
      throw new ParseError(`Expected key "${name}", got "${key}"`, keyStart);
    }
    this.pos = keyEnd + 1;
    this.skipWs();
    this.expect(':');
    this.advance(); // skip :
    this.skipWs();
  }

  private unescape(raw: string): string {
    return raw.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, seq: string) => {
      switch (seq[0]) {
        case '"': return '"';
        case '\\': return '\\';
        case '/': return '/';
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case 'b': return '\b';
        case 'f': return '\f';
        case 'u': return String.fromCharCode(parseInt(seq.slice(1), 16));
        default: return seq;
      }
    });
  }

  // -- Cursor helpers --

  private peek(): string { return this.json[this.pos]; }
  private atEnd(): boolean { return this.pos >= this.json.length; }
  private advance(): void { this.pos++; }

  private expect(ch: string): void {
    if (this.json[this.pos] !== ch) {
      throw new ParseError(
        `Expected '${ch}', got '${this.json[this.pos] ?? 'EOF'}'`,
        this.pos
      );
    }
  }

  private tryConsume(ch: string): boolean {
    if (this.json[this.pos] === ch) {
      this.pos++;
      return true;
    }
    return false;
  }

  private skipWs(): void {
    while (this.pos < this.json.length && /\s/.test(this.json[this.pos])) {
      this.pos++;
    }
  }

  private skipWsFrom(j: number): number {
    while (j < this.json.length && /\s/.test(this.json[j])) j++;
    return j;
  }

  private skipTo(ch: string): void {
    while (this.pos < this.json.length && this.json[this.pos] !== ch) {
      this.pos++;
    }
    if (this.atEnd()) {
      throw new ParseError(`Expected '${ch}' not found`, this.pos);
    }
  }
}
