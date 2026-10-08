# Own experiments

Measurements from our own runs. Small samples: read them as signals, not conclusions.

## Squad prototype (2026-09-30 to 2026-10-01)

**Question.** Does a team of agents (PM, developer, QA) deliver a better prototype than a single agent, starting from the same client call? Does it justify the extra cost?

**Setup.** Two simulated client discovery calls, each with a hidden answer key: Fluent House (a language school tracking make-up classes, 18 scope requirements) and Brava (expense reimbursement, 23 requirements). Every arm got the same input and had to produce the same outputs: a scope document and a self-contained HTML prototype. No human checkpoints during runs. The squad arm ran in [Maestri](https://www.themaestri.app) with Claude as PM and QA and Codex as developer. Scopes were graded against the answer keys.

### Fluent House (scope of 18)

| Arm | Who | Time | Cost (API equivalent) | Defects found by QA | Scope | What it missed |
|---|---|---|---|---|---|---|
| Solo | 1 Claude, prototyping skill, no testing | 12 min | US$1.73 | no QA | 17 | Did not treat an expired make-up class as "expired", only warned about ones close to expiring |
| Solo with self-test | 1 Claude, tests its own work | 6 min | US$1.83 | 1 (visual) | 18 | nothing |
| Squad (Maestri) | Claude PM + Codex dev + Claude QA | 26 min | US$3.02 for QA only (Maestro and Codex not measured) | 2 | 18 | nothing |

### Brava reimbursement (scope of 23)

| Arm | Who | Time | Cost (API equivalent) | Defects found by QA | Scope | What it missed |
|---|---|---|---|---|---|---|
| Single AI | 1 Claude, objective only | 6 min | US$1.59 | no QA | 23 | nothing |
| Skills in sequence | 1 Claude with PM, Dev and QA skills | 4 min | US$1.11 | 0 | 22 | Finance only saw its own queue, without a view of what is stuck with whom |
| Subagent team | coordinator + Claude PM, Dev and QA subagents | 14 min | US$3.46 | 0 | 23 | nothing |
| Squad (Maestri) | Claude PM + Codex dev + Claude QA | 23 min | US$3.50 for QA only (Maestro and Codex not measured) | 2 (broken "add expense" button; daily limit bypassable across two requests) | 22 | Same gap as the skills arm |

No arm fell into a trap (corrected value, invented rule for an open question, out-of-scope item).

### Preliminary reading

1. **Scope does not separate the approaches.** Every arm scored 22 or 23 of 23, and 17 or 18 of 18. Any difference lives in the prototype, so human grading of the prototypes is the decisive step (not done yet).
2. **The only requirements that tripped anyone were implicit:** a pain the client mentioned but never asked to solve. That is the kind of requirement that separates a good PM, human or agent.
3. **Cross-vendor QA found defects; same-vendor QA did not.** Claude QA approved Claude's code first time (0 defects in both arms) and found 2 real defects in Codex's code in both calls. Two explanations remain open: Claude writes code with fewer errors, or QA is lenient with code from its own model. Human grading of the prototypes is what tells them apart.
4. **Cost.** The subagent team cost about 3× the skills arm and took 3.5× longer, with the same scope result and the same number of defects found (zero).

### Caveats

- One run per arm.
- The squad's cost is incomplete (orchestrator and Codex not measured).
- Scopes were graded by a Claude, not a human.
- Prototype quality has not been graded yet.

Source: `~/Projects/squad-prototipo/avaliacao/resultados.md` (local experiment repository).
