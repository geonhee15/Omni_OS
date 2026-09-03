#!/usr/bin/env python3
"""옴니 계산기 — 안전한 수식 평가기 (표준 라이브러리만).

LLM(텍스트/LIVE 음성/안경)이 자연어를 수식으로만 바꾸고, 실제 계산은 여기서
정확히 한다. ast 화이트리스트로 산술·수학 함수·통계·정수 연산만 허용
(임의 코드 실행 불가). 출력은 JSON 한 줄 {ok, expr, result, text}.

사용: omni_calc.py "<수식>"   또는  import 후 evaluate(expr)
지원: + - * / // % ** ( ) , 12,345 천단위, 15% → 0.15, ^ → **, ×÷,
      sqrt sin cos tan asin acos atan atan2 log ln log10 log2 exp
      floor ceil round abs factorial gcd lcm comb perm degrees radians hypot
      min max sum mean median stdev pi e tau, [리스트], 2**100 같은 큰 정수
"""
import ast
import json
import math
import operator
import re
import statistics
import sys
from fractions import Fraction

MAX_POW_EXP = 20000        # 지수 폭주 방지
MAX_FACT = 5000
MAX_DIGITS = 4000          # 결과 문자열 상한


class CalcError(Exception):
    pass


def _pow(a, b):
    if isinstance(b, int) and abs(b) > MAX_POW_EXP:
        raise CalcError("지수가 너무 큽니다")
    if isinstance(a, int) and isinstance(b, int) and b >= 0:
        if a not in (0, 1, -1) and b * a.bit_length() > 200000:
            raise CalcError("결과가 너무 큽니다")
        return a ** b
    return operator.pow(a, b)


def _fact(n):
    if not isinstance(n, int) or n < 0:
        raise CalcError("factorial은 0 이상 정수만")
    if n > MAX_FACT:
        raise CalcError("factorial 인수가 너무 큽니다")
    return math.factorial(n)


def _div(a, b):
    if b == 0:
        raise CalcError("0으로 나눌 수 없습니다")
    if isinstance(a, int) and isinstance(b, int):
        f = Fraction(a, b)
        return f.numerator if f.denominator == 1 else a / b
    return a / b


_BIN = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: _div, ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod,
    ast.Pow: _pow,
}
_UN = {ast.UAdd: operator.pos, ast.USub: operator.neg}

_FUNCS = {
    "sqrt": math.sqrt, "sin": math.sin, "cos": math.cos, "tan": math.tan,
    "asin": math.asin, "acos": math.acos, "atan": math.atan, "atan2": math.atan2,
    "log": lambda x, b=math.e: math.log(x, b), "ln": math.log,
    "log10": math.log10, "log2": math.log2, "exp": math.exp,
    "floor": math.floor, "ceil": math.ceil, "round": round, "abs": abs,
    "factorial": _fact, "gcd": math.gcd, "lcm": math.lcm,
    "comb": math.comb, "perm": math.perm,
    "degrees": math.degrees, "radians": math.radians, "hypot": math.hypot,
    "min": min, "max": max, "sum": sum,
    "mean": statistics.mean, "median": statistics.median,
    "stdev": statistics.stdev, "pstdev": statistics.pstdev,
    "int": int, "float": float,
}
_CONSTS = {"pi": math.pi, "e": math.e, "tau": math.tau, "inf": math.inf}


def _eval(node):
    if isinstance(node, ast.Expression):
        return _eval(node.body)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            return node.value
        raise CalcError("숫자만 허용됩니다")
    if isinstance(node, ast.BinOp) and type(node.op) in _BIN:
        return _BIN[type(node.op)](_eval(node.left), _eval(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UN:
        return _UN[type(node.op)](_eval(node.operand))
    if isinstance(node, ast.Name):
        if node.id in _CONSTS:
            return _CONSTS[node.id]
        raise CalcError(f"알 수 없는 이름: {node.id}")
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in _FUNCS:
            raise CalcError("허용되지 않은 함수")
        if node.keywords:
            raise CalcError("키워드 인수 불가")
        return _FUNCS[node.func.id](*[_eval(a) for a in node.args])
    if isinstance(node, (ast.List, ast.Tuple)):
        return [_eval(e) for e in node.elts]
    raise CalcError(f"지원하지 않는 구문: {type(node).__name__}")


def normalize(expr: str) -> str:
    s = expr.strip()
    s = s.replace("×", "*").replace("÷", "/").replace("−", "-").replace("^", "**")
    s = s.replace("√", "sqrt").replace("π", "pi")
    s = re.sub(r"(?<=\d),(?=\d{3}\b)", "", s)            # 12,345 → 12345
    s = re.sub(r"(\d+(?:\.\d+)?)\s*%", r"(\1/100)", s)     # 15% → (15/100)
    s = re.sub(r"(\d)\s*\(", r"\1*(", s)                   # 2(3+4) → 2*(3+4)
    s = re.sub(r"\)\s*(\d)", r")*\1", s)                   # (1+2)3 → (1+2)*3
    return s


def fmt(v) -> str:
    if isinstance(v, bool):
        return str(v)
    if isinstance(v, int):
        s = str(v)
        if len(s) > MAX_DIGITS:
            return f"{s[:20]}… ({len(s)}자리 정수)"
        return s
    if isinstance(v, float):
        if math.isinf(v) or math.isnan(v):
            return str(v)
        if v == int(v) and abs(v) < 1e21:
            return str(int(v))
        s = f"{v:.12g}"
        return s
    if isinstance(v, list):
        return "[" + ", ".join(fmt(x) for x in v) + "]"
    return str(v)


def evaluate(expr: str) -> dict:
    norm = normalize(expr)
    if not norm:
        return {"ok": False, "expr": expr, "error": "빈 수식"}
    try:
        tree = ast.parse(norm, mode="eval")
        val = _eval(tree)
        text = fmt(val)
        return {"ok": True, "expr": norm, "result": val if isinstance(val, (int, float)) and abs(val) < 1e300 else text,
                "text": text}
    except CalcError as e:
        return {"ok": False, "expr": norm, "error": str(e)}
    except (SyntaxError, ValueError, TypeError, OverflowError, ZeroDivisionError,
            statistics.StatisticsError, RecursionError) as e:
        return {"ok": False, "expr": norm, "error": f"계산 불가: {e}"}


if __name__ == "__main__":
    q = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else sys.stdin.read()
    print(json.dumps(evaluate(q), ensure_ascii=False, default=str))
