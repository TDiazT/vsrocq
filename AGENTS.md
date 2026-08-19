# AGENTS.md

Guía para agentes de IA que trabajen en este repositorio (fork de
rocq-prover/vsrocq, mantenido como submódulo de TDiazT/RocqLSP).

Este archivo y todo lo que referencia son **fork-only**: no van a upstream y no
están rastreados en `staging`. Viven en la rama huérfana `fork-config`. Cómo
traerlos a una máquina nueva: `docs/agents/environment.md`, sección 0.

## Empezar acá

**`docs/agents/environment.md`** — cómo construir y correr los tests en una
máquina nueva (Arch y macOS), qué switch de opam hace falta y por qué, el flujo
de git de este fork, y cómo se dispara CI. Si algo no compila o un test falla de
una forma que no tiene sentido, la causa está casi seguro documentada ahí.

## Agent skills

### Issue tracker

GitHub Issues en `TDiazT/RocqLSP` (el repo padre, no este fork). See
`docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (needs-triage, needs-info, ready-for-agent,
ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See
`docs/agents/domain.md`.
