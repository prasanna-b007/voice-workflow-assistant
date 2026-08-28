// Recursive-descent parser for the arithmetic the "calculate" voice action needs.
// Replaces eval(), which the bundler flags as a security risk and which blocks
// minification. Only numbers and + - * / ( ) are representable here, so there is
// no expression an input string could form that reaches the JS runtime.

const NUMBER = /^\d+(\.\d+)?/;

function tokenize(input) {
  const tokens = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }

    if ("+-*/()".includes(ch)) {
      tokens.push(ch);
      i++;
      continue;
    }

    const match = NUMBER.exec(input.slice(i));
    if (match) {
      tokens.push(parseFloat(match[0]));
      i += match[0].length;
      continue;
    }

    throw new Error(`Unexpected character "${ch}" at position ${i}`);
  }

  return tokens;
}

/**
 * Evaluates a basic arithmetic expression.
 * @param {string} expression e.g. "12 * (3 + 4.5)"
 * @returns {number}
 * @throws {Error} on malformed input or division by zero
 */
export function evaluateExpression(expression) {
  if (typeof expression !== "string" || !expression.trim()) {
    throw new Error("Empty expression");
  }

  const tokens = tokenize(expression);
  let pos = 0;

  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];

  // factor := number | "(" expr ")" | ("+" | "-") factor
  function parseFactor() {
    const token = peek();

    if (token === "+" || token === "-") {
      consume();
      const value = parseFactor();
      return token === "-" ? -value : value;
    }

    if (token === "(") {
      consume();
      const value = parseExpression();
      if (consume() !== ")") throw new Error("Unbalanced parenthesis");
      return value;
    }

    if (typeof token !== "number") throw new Error("Expected a number");
    return consume();
  }

  // term := factor (("*" | "/") factor)*
  function parseTerm() {
    let value = parseFactor();

    while (peek() === "*" || peek() === "/") {
      const op = consume();
      const rhs = parseFactor();
      if (op === "/" && rhs === 0) throw new Error("Division by zero");
      value = op === "*" ? value * rhs : value / rhs;
    }

    return value;
  }

  // expr := term (("+" | "-") term)*
  function parseExpression() {
    let value = parseTerm();

    while (peek() === "+" || peek() === "-") {
      const op = consume();
      const rhs = parseTerm();
      value = op === "+" ? value + rhs : value - rhs;
    }

    return value;
  }

  const result = parseExpression();
  if (pos !== tokens.length) throw new Error("Trailing input after expression");
  if (!Number.isFinite(result)) throw new Error("Result is not a finite number");

  return result;
}
