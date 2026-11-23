// Évaluateur arithmétique sécurisé (parseur récursif sans eval/Function) pour formules Micronova Agua IOT.

const TOKEN_RE = /\s*(?:(\d+(?:\.\d+)?)|(==|!=|<=|>=|<|>)|([+\-*/%(),])|([A-Za-z_][A-Za-z0-9_]*))/y;

export function tokenizeFormula(expr) {
  const tokens = [];
  let pos = 0;
  while (pos < expr.length) {
    if (/\s/.test(expr[pos])) {
      pos += 1;
      continue;
    }
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(expr);
    if (!m) {
      throw new Error(`Jeton non autorisé dans la formule à l'index ${pos}: ${expr.slice(pos)}`);
    }
    if (m[1] !== undefined) {
      tokens.push({ kind: "NUMBER", val: m[1] });
    } else if (m[2] !== undefined) {
      tokens.push({ kind: "CMP", val: m[2] });
    } else if (m[3] !== undefined) {
      tokens.push({ kind: "OP", val: m[3] });
    } else if (m[4] !== undefined) {
      if (m[4] === "Mod") {
        tokens.push({ kind: "OP", val: "%" });
      } else {
        tokens.push({ kind: "IDENT", val: m[4] });
      }
    }
    pos = TOKEN_RE.lastIndex;
  }
  return tokens;
}

class FormulaParser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.pos < this.tokens.length ? this.tokens[this.pos] : null;
  }

  consume(expectedKind = null, expectedVal = null) {
    const tok = this.peek();
    if (!tok) throw new Error("Fin inattendue de la formule");
    if (expectedKind && tok.kind !== expectedKind) {
      throw new Error(`Attendu ${expectedKind}, reçu ${tok.kind}`);
    }
    if (expectedVal && tok.val !== expectedVal) {
      throw new Error(`Attendu ${expectedVal}, reçu ${tok.val}`);
    }
    this.pos += 1;
    return tok;
  }

  parse() {
    if (this.tokens.length === 0) throw new Error("Formule vide");
    const res = this.parseComparison();
    if (this.pos !== this.tokens.length) {
      throw new Error(`Jeton excédentaire dans la formule: ${this.tokens[this.pos].val}`);
    }
    return res;
  }

  parseComparison() {
    const left = this.parseAddSub();
    const tok = this.peek();
    if (tok && tok.kind === "CMP") {
      const op = this.consume().val;
      const right = this.parseAddSub();
      if (op === "==") return left === right;
      if (op === "!=") return left !== right;
      if (op === "<") return left < right;
      if (op === "<=") return left <= right;
      if (op === ">") return left > right;
      if (op === ">=") return left >= right;
    }
    return left;
  }

  parseAddSub() {
    let val = this.parseMulDiv();
    while (true) {
      const tok = this.peek();
      if (!tok || tok.kind !== "OP" || (tok.val !== "+" && tok.val !== "-")) break;
      const op = this.consume().val;
      const rhs = this.parseMulDiv();
      val = op === "+" ? val + rhs : val - rhs;
    }
    return val;
  }

  parseMulDiv() {
    let val = this.parseUnary();
    while (true) {
      const tok = this.peek();
      if (!tok || tok.kind !== "OP" || (tok.val !== "*" && tok.val !== "/" && tok.val !== "%")) break;
      const op = this.consume().val;
      const rhs = this.parseUnary();
      if (op === "*") val = val * rhs;
      else if (op === "/") val = val / rhs;
      else val = val % rhs;
    }
    return val;
  }

  parseUnary() {
    const tok = this.peek();
    if (tok && tok.kind === "OP" && (tok.val === "+" || tok.val === "-")) {
      const op = this.consume().val;
      const inner = this.parseUnary();
      return op === "-" ? -inner : inner;
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const tok = this.peek();
    if (!tok) throw new Error("Opérande manquant dans la formule");

    if (tok.kind === "NUMBER") {
      this.consume();
      return Number(tok.val);
    }

    if (tok.kind === "OP" && tok.val === "(") {
      this.consume("OP", "(");
      const val = this.parseComparison();
      this.consume("OP", ")");
      return val;
    }

    if (tok.kind === "IDENT") {
      const ident = this.consume().val;
      const up = ident.toUpperCase();
      if (up === "TRUE" || up === "FALSE") {
        return up === "TRUE" ? 1 : 0;
      }
      if (up === "INT") {
        this.consume("OP", "(");
        const arg = this.parseComparison();
        this.consume("OP", ")");
        return Math.trunc(Number(arg));
      }
      if (up === "IF") {
        this.consume("OP", "(");
        const cond = this.parseComparison();
        this.consume("OP", ",");
        const tVal = this.parseComparison();
        this.consume("OP", ",");
        const fVal = this.parseComparison();
        this.consume("OP", ")");
        return cond ? tVal : fVal;
      }
      throw new Error(`Identifiant non autorisé dans la formule: ${ident}`);
    }

    throw new Error(`Jeton inattendu: ${tok.val}`);
  }
}

export function evaluateMicronovaFormula(formula, value) {
  if (formula === null || formula === undefined) return value;
  const raw = String(formula).trim();
  if (!raw || raw === "#") return value;
  const num = Number(value);
  const numStr = Number.isInteger(num) ? String(num) : String(num);
  const substituted = raw.replaceAll("#", `(${numStr})`).replace(/Mod(?=\d|\()/gi, "Mod ");
  const tokens = tokenizeFormula(substituted);
  const res = new FormulaParser(tokens).parse();
  if (typeof res === "boolean") return res ? 1 : 0;
  return res;
}
