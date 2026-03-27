/**
 * Lispy — A tiny Lisp VM for real-time agent control.
 *
 * The LLM writes a strategy as an s-expression (nano-prompt).
 * The VM evaluates it every tick at 60fps with zero latency.
 * No network, no async, no garbage — pure synchronous eval.
 *
 * Built-in environment for pong:
 *   ball-x, ball-y, ball-vx, ball-vy   — ball state
 *   paddle-y, paddle-center             — this paddle's position
 *   opponent-y                          — other paddle
 *   field-w, field-h, paddle-h          — dimensions
 *   (move :up speed) (move :down speed) — output actions
 *   (abs x) (min a b) (max a b)        — math
 *   (if cond then else)                 — branching
 *   (> < >= <= = != + - * /)            — operators
 *   (and a b) (or a b) (not a)          — logic
 *   (let ((x 1) (y 2)) body)           — local bindings
 *   (cond (test1 val1) (test2 val2) …)  — multi-branch
 *
 * Usage:
 *   const vm = new LispyVM();
 *   vm.setStrategy('(if (> ball-y paddle-center) (move :down 0.7) (move :up 0.7))');
 *   const action = vm.tick({ 'ball-y': 10, 'paddle-center': 8, ... });
 *   // action = { direction: 'down', speed: 0.7 }
 */

// ── Types ───────────────────────────────────────────────────────────────────

type LispVal = number | string | boolean | LispVal[] | null | LispAction;

export interface LispAction {
  direction: 'up' | 'down' | 'none';
  speed: number;
}

type Env = Map<string, LispVal>;

// ── Tokenizer ───────────────────────────────────────────────────────────────

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (ch === ';') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (ch === '(' || ch === ')') { tokens.push(ch); i++; continue; }
    if (ch === ':') {
      let sym = ':';
      i++;
      while (i < source.length && /[a-zA-Z0-9_-]/.test(source[i])) { sym += source[i]; i++; }
      tokens.push(sym);
      continue;
    }
    // Number or symbol
    let tok = '';
    while (i < source.length && source[i] !== ' ' && source[i] !== ')' && source[i] !== '(' && source[i] !== '\n' && source[i] !== '\r' && source[i] !== '\t') {
      tok += source[i]; i++;
    }
    tokens.push(tok);
  }
  return tokens;
}

// ── Parser ──────────────────────────────────────────────────────────────────

function parse(tokens: string[]): LispVal {
  let pos = 0;

  function readExpr(): LispVal {
    if (pos >= tokens.length) return null;
    const tok = tokens[pos];

    if (tok === '(') {
      pos++; // skip (
      const list: LispVal[] = [];
      while (pos < tokens.length && tokens[pos] !== ')') {
        list.push(readExpr());
      }
      pos++; // skip )
      return list;
    }

    pos++;

    // Keywords
    if (tok.startsWith(':')) return tok;
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'nil') return null;

    // Numbers
    const num = Number(tok);
    if (!isNaN(num)) return num;

    // Symbol
    return tok;
  }

  return readExpr();
}

// ── Evaluator ───────────────────────────────────────────────────────────────

function evaluate(expr: LispVal, env: Env): LispVal {
  // Atoms
  if (expr === null) return null;
  if (typeof expr === 'number') return expr;
  if (typeof expr === 'boolean') return expr;
  if (typeof expr === 'string') {
    if (expr.startsWith(':')) return expr; // keyword literal
    const val = env.get(expr);
    if (val === undefined) return 0; // unknown var → 0 (safe default for game)
    return val;
  }

  // Lists (function calls)
  if (!Array.isArray(expr) || expr.length === 0) return null;

  const head = expr[0] as string;

  // Special forms
  if (head === 'if') {
    const cond = evaluate(expr[1], env);
    return isTruthy(cond) ? evaluate(expr[2], env) : evaluate(expr[3] ?? null, env);
  }

  if (head === 'cond') {
    for (let i = 1; i < expr.length; i++) {
      const clause = expr[i] as LispVal[];
      if (Array.isArray(clause) && clause.length >= 2) {
        if (clause[0] === 'else' || isTruthy(evaluate(clause[0], env))) {
          return evaluate(clause[1], env);
        }
      }
    }
    return null;
  }

  if (head === 'let') {
    const bindings = expr[1] as LispVal[][];
    const childEnv = new Map(env);
    if (Array.isArray(bindings)) {
      for (const binding of bindings) {
        if (Array.isArray(binding) && binding.length >= 2) {
          childEnv.set(binding[0] as string, evaluate(binding[1], childEnv));
        }
      }
    }
    return evaluate(expr[2], childEnv);
  }

  if (head === 'do' || head === 'begin') {
    let result: LispVal = null;
    for (let i = 1; i < expr.length; i++) {
      result = evaluate(expr[i], env);
    }
    return result;
  }

  // Evaluate all args
  const args = expr.slice(1).map(a => evaluate(a, env));

  // Built-in functions
  switch (head) {
    // Move action (the primary output)
    case 'move': {
      const dir = args[0] as string;
      const speed = (args[1] as number) ?? 1.0;
      const direction = dir === ':up' ? 'up' : dir === ':down' ? 'down' : 'none';
      return { direction, speed } as LispAction;
    }

    // Arithmetic
    case '+': return args.reduce((a: number, b) => a + (b as number), 0);
    case '-': return args.length === 1 ? -(args[0] as number) : (args[0] as number) - (args[1] as number);
    case '*': return args.reduce((a: number, b) => a * (b as number), 1);
    case '/': return (args[1] as number) !== 0 ? (args[0] as number) / (args[1] as number) : 0;

    // Comparison
    case '>': return (args[0] as number) > (args[1] as number);
    case '<': return (args[0] as number) < (args[1] as number);
    case '>=': return (args[0] as number) >= (args[1] as number);
    case '<=': return (args[0] as number) <= (args[1] as number);
    case '=': return args[0] === args[1];
    case '!=': return args[0] !== args[1];

    // Logic
    case 'and': return isTruthy(args[0]) && isTruthy(args[1]) ? args[1] : false;
    case 'or': return isTruthy(args[0]) ? args[0] : args[1];
    case 'not': return !isTruthy(args[0]);

    // Math
    case 'abs': return Math.abs(args[0] as number);
    case 'min': return Math.min(args[0] as number, args[1] as number);
    case 'max': return Math.max(args[0] as number, args[1] as number);
    case 'clamp': return Math.max(args[0] as number, Math.min(args[1] as number, args[2] as number));

    // Prediction: where will ball be at x?
    case 'predict-y': {
      // (predict-y target-x ball-x ball-y ball-vx ball-vy field-h)
      const [tx, bx, by, bvx, bvy, fh] = args as number[];
      if (bvx === 0) return by;
      const ticks = (tx - bx) / bvx;
      if (ticks < 0) return by; // ball going away
      let py = by + bvy * ticks;
      // Bounce simulation
      while (py < 0 || py >= fh) {
        if (py < 0) py = -py;
        if (py >= fh) py = 2 * (fh - 1) - py;
      }
      return py;
    }

    default:
      return null;
  }
}

function isTruthy(val: LispVal): boolean {
  return val !== null && val !== false && val !== 0;
}

// ── VM ──────────────────────────────────────────────────────────────────────

export class LispyVM {
  private ast: LispVal = null;
  private strategy = '';

  /** Load a lisp strategy string. Parsed once, evaluated every tick. */
  setStrategy(source: string): void {
    this.strategy = source;
    const tokens = tokenize(source);
    this.ast = parse(tokens);
  }

  /** Get the current strategy source. */
  getStrategy(): string {
    return this.strategy;
  }

  /** Evaluate the strategy with current game state. Returns a move action. */
  tick(state: Record<string, number>): LispAction {
    if (this.ast === null) return { direction: 'none', speed: 0 };

    const env: Env = new Map();
    for (const [k, v] of Object.entries(state)) {
      env.set(k, v);
    }

    const result = evaluate(this.ast, env);

    // Coerce result to action
    if (result && typeof result === 'object' && 'direction' in result) {
      return result as LispAction;
    }
    return { direction: 'none', speed: 0 };
  }
}

// ── Preset strategies ───────────────────────────────────────────────────────

export const STRATEGIES = {
  /** Simple tracking — follows the ball directly. */
  tracker: `
    (if (> ball-y paddle-center)
        (move :down 0.7)
        (move :up 0.7))`,

  /** Predictive — calculates where the ball will arrive. */
  predictor: `
    (let ((target (predict-y paddle-x ball-x ball-y ball-vx ball-vy field-h)))
      (if (> (abs (- target paddle-center)) 1.0)
          (if (> target paddle-center)
              (move :down 0.8)
              (move :up 0.8))
          (move :none 0)))`,

  /** Lazy — only moves when ball is heading toward this paddle. */
  lazy: `
    (cond
      ((< ball-vx 0)
       (if (> (abs (- ball-y paddle-center)) 2.0)
           (if (> ball-y paddle-center) (move :down 0.5) (move :up 0.5))
           (move :none 0)))
      (else
       (let ((mid (/ field-h 2)))
         (if (> (abs (- paddle-center mid)) 1.0)
             (if (> paddle-center mid) (move :up 0.3) (move :down 0.3))
             (move :none 0)))))`,

  /** Aggressive — fast tracking with prediction. */
  aggressive: `
    (let ((target (predict-y paddle-x ball-x ball-y ball-vx ball-vy field-h))
          (diff (- target paddle-center)))
      (if (> (abs diff) 0.5)
          (if (> diff 0) (move :down 1.0) (move :up 1.0))
          (move :none 0)))`,
} as const;
