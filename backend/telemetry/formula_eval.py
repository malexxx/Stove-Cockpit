"""Évaluateur arithmétique sécurisé (parseur récursif sans eval) pour les formules Micronova Agua IOT."""
import re
from typing import Any

_TOKEN_RE = re.compile(
    r"\s*(?:"
    r"(?P<NUMBER>\d+(?:\.\d+)?)"
    r"|(?P<CMP>==|!=|<=|>=|<|>)"
    r"|(?P<OP>[+\-*/%(),])"
    r"|(?P<IDENT>[A-Za-z_][A-Za-z0-9_]*)"
    r")"
)


def _tokenize(expr: str) -> list[tuple[str, str]]:
    tokens: list[tuple[str, str]] = []
    pos = 0
    n = len(expr)
    while pos < n:
        if expr[pos].isspace():
            pos += 1
            continue
        m = _TOKEN_RE.match(expr, pos)
        if not m:
            raise ValueError(f"Jeton non autorisé dans la formule à l'index {pos}: {expr[pos:]!r}")
        kind = m.lastgroup
        val = m.group(kind)
        if kind == "IDENT":
            if val == "Mod":
                tokens.append(("OP", "%"))
            else:
                tokens.append(("IDENT", val))
        else:
            tokens.append((kind or "OP", val))
        pos = m.end()
    return tokens


class _FormulaParser:
    def __init__(self, tokens: list[tuple[str, str]]):
        self.tokens = tokens
        self.pos = 0

    def peek(self) -> tuple[str, str] | None:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def consume(self, expected_kind: str | None = None, expected_val: str | None = None) -> tuple[str, str]:
        tok = self.peek()
        if tok is None:
            raise ValueError("Fin inattendue de la formule")
        if expected_kind and tok[0] != expected_kind:
            raise ValueError(f"Attendu {expected_kind}, reçu {tok}")
        if expected_val and tok[1] != expected_val:
            raise ValueError(f"Attendu {expected_val!r}, reçu {tok[1]!r}")
        self.pos += 1
        return tok

    def parse(self) -> float | int | bool:
        if not self.tokens:
            raise ValueError("Formule vide")
        res = self._parse_comparison()
        if self.pos != len(self.tokens):
            raise ValueError(f"Jeton excédentaire dans la formule: {self.tokens[self.pos]}")
        return res

    def _parse_comparison(self) -> Any:
        left = self._parse_add_sub()
        tok = self.peek()
        if tok and tok[0] == "CMP":
            op = self.consume()[1]
            right = self._parse_add_sub()
            if op == "==":
                return left == right
            if op == "!=":
                return left != right
            if op == "<":
                return left < right
            if op == "<=":
                return left <= right
            if op == ">":
                return left > right
            if op == ">=":
                return left >= right
        return left

    def _parse_add_sub(self) -> float:
        val = self._parse_mul_div()
        while (tok := self.peek()) and tok[0] == "OP" and tok[1] in ("+", "-"):
            op = self.consume()[1]
            rhs = self._parse_mul_div()
            val = val + rhs if op == "+" else val - rhs
        return val

    def _parse_mul_div(self) -> float:
        val = self._parse_unary()
        while (tok := self.peek()) and tok[0] == "OP" and tok[1] in ("*", "/", "%"):
            op = self.consume()[1]
            rhs = self._parse_unary()
            if op == "*":
                val = val * rhs
            elif op == "/":
                val = val / rhs
            else:
                val = val % rhs
        return val

    def _parse_unary(self) -> float:
        tok = self.peek()
        if tok and tok[0] == "OP" and tok[1] in ("+", "-"):
            op = self.consume()[1]
            inner = self._parse_unary()
            return -inner if op == "-" else inner
        return self._parse_primary()

    def _parse_primary(self) -> float:
        tok = self.peek()
        if tok is None:
            raise ValueError("Opérande manquant dans la formule")

        if tok[0] == "NUMBER":
            self.consume()
            return int(tok[1]) if "." not in tok[1] else float(tok[1])

        if tok[0] == "OP" and tok[1] == "(":
            self.consume("OP", "(")
            val = self._parse_comparison()
            self.consume("OP", ")")
            return val

        if tok[0] == "IDENT":
            ident = self.consume()[1]
            ident_upper = ident.upper()
            if ident_upper in ("TRUE", "FALSE"):
                return 1 if ident_upper == "TRUE" else 0
            if ident_upper in ("IF", "INT"):
                self.consume("OP", "(")
                if ident_upper == "INT":
                    arg = self._parse_comparison()
                    self.consume("OP", ")")
                    return int(float(arg))
                cond = self._parse_comparison()
                self.consume("OP", ",")
                true_val = self._parse_comparison()
                self.consume("OP", ",")
                false_val = self._parse_comparison()
                self.consume("OP", ")")
                return true_val if bool(cond) else false_val
            raise ValueError(f"Identifiant non autorisé dans la formule: {ident!r}")

        raise ValueError(f"Jeton inattendu: {tok}")


def evaluate_micronova_formula(formula: str | None, value: float | int) -> float | int:
    """Évalue une formule Micronova (`#` = valeur, `Mod` = modulo, `IF`, `int`) sans eval()."""
    if formula is None:
        return value
    raw = str(formula).strip()
    if not raw or raw == "#":
        return value
    num_str = str(int(value)) if isinstance(value, int) or (isinstance(value, float) and value.is_integer()) else repr(float(value))
    substituted = raw.replace("#", f"({num_str})")
    tokens = _tokenize(substituted)
    result = _FormulaParser(tokens).parse()
    if isinstance(result, bool):
        return 1 if result else 0
    if isinstance(result, float) and result.is_integer():
        return int(result)
    return result
