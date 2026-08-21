# ADR-0002: The macOS CI fast path is deliberately asymmetric between the nix and opam routes

**Status:** accepted
**Date:** 2026-08-21

## Context

`ci.yml` schedules 16 macOS jobs per run: 8 Rocq versions × 2 independent build
routes (`nix-dev-build` and `install-opam`). GitHub caps concurrent macOS
runners at 5 on Free/Pro/Team plans, so those 16 jobs execute in 4 waves of
~6 minutes. That queueing, not compilation, is what sets the wall clock.

Measured on run 32170095477 (the last fully green one at the time): 26 minutes
end to end, of which roughly half was queue time. The worst cell,
`nix-dev-build (macos, 9-1)`, waited 19 minutes to run for 6. Every ubuntu job
in the same run started with a queue of 0 to 3 minutes: the ubuntu cap is 20
and is
never reached.

The two routes do not cover the same ground:

- **nix** builds Rocq from nixpkgs and is the only place where tests actually
  execute on Darwin (the Electron suite and the LSP suite over stdio).
- **opam** builds `rocq-core` from source with the system toolchain. On macOS it
  runs *no* tests at all: every test step in `install-opam` is gated on
  `runner.os == 'Linux'`. Its entire value on Darwin is as a build check of the
  opam packaging route.

The opam route carries a known, version-scoped defect. The `coq-core` opam
package sets `build-env: OCAMLPARAM = "_,w=-46,warn-error=-a,keywords=5.2"`.
Compiler-libs binaries parse `OCAMLPARAM` at startup, and on OCaml 4.14.2 /
macOS / arm64 that string drives `Warnings.letter` into an unreachable
`assert false` (`utils/warnings.ml:491`): `keywords=5.2` means nothing to a
compiler older than 5.2. The failure is layout-sensitive: deterministic for a
fixed argv, env, cwd and input file, but it flips with any of them, so across a
build it behaves as a probabilistic failure (tracker issue #13, observed on the
`8.19.0` cell). opam's `build-env` overrides the ambient value, so there is no
CI-side workaround.

The affected range is `coq-core` 8.17.0 through 8.19.1. **8.19.2 and later are
immune by construction**: the variable is not in the Rocq source tarball, it is
added in opam packaging. `8.18.0` is inside the range and passes only by luck.
The nix route never sees this: it does not go through the opam package, so it
has no `build-env`.

## Decision

On `pull_request`, macOS runs 4 cells instead of 16, one wave instead of four:

| Route | Versions on the PR fast path |
|---|---|
| nix | `8-18`, `9-2` |
| opam | `8.20.0`, `9.2.0` |

ubuntu keeps the full 8-version sweep on both routes; it costs nothing in wall
clock. The complete 16-cell macOS matrix runs on push to the default branch, and
on demand on a PR via the `ci-full` label.

The version lists differ between the two routes **on purpose**:

- The oldest-supported end is represented by `nix 8-18`, not by `opam 8.18.0`,
  because only the opam route is exposed to the `OCAMLPARAM` fault. Putting
  `8.18.0` on the fast path would place a cell with a known probabilistic
  failure on the blocking path of every PR, and with only two opam-macOS cells
  that is half the signal. A red run there is not attributable to the PR that
  triggered it.
- `opam 8.20.0` is the oldest 8.x that is immune by construction, so the fast
  path still checks an 8.x opam build on Darwin without inheriting the fault.
- `9.2.0` / `9-2` is on both routes because the golden LSP tests are
  content-frozen against Rocq 9.2 (`client/src/test/lsp/README.md`).
- The macOS `master`, `9-3`, `dev` and `9.3.dev` cells are off the fast path.
  When they break, they break because upstream moved rather than because of the
  PR under review. They keep running on ubuntu, where they cost no wall clock,
  so the signal is delayed on Darwin only.

`8.18.0` and `8.19.0` on the opam route are not dropped: they move to the full
sweep, where a failure informs instead of blocking.

The cells are emitted as JSON by `.github/scripts/ci-matrix.py`, run in a
`matrix-plan` job, and consumed as `matrix: ${{ fromJSON(...) }}`. A cross
product `os × coq` cannot express different version lists per OS, and
duplicating the step lists per OS would double an already-drifting set of steps.
Running the script with `FULL=true` reproduces today's matrix cell for cell,
which is what makes the reduced set the only thing this change alters.

The `ci-full` label requires `on: pull_request: types: [opened, synchronize,
reopened, labeled]`. Declaring `types` overrides the defaults, so all four must
be listed. Without `labeled`, applying the label fires no run at all, and
"Re-run all jobs" replays the original payload, which does not carry the label.

## Alternatives considered

**Keep `opam 8.18.0` and mitigate the flake** (retry the step, or
`continue-on-error` on that cell). Rejected: it contradicts the rule that a PR
does not pass while it leaves CI red, and a retry does not fix a
layout-sensitive fault: perturbing the build moves the failure rather than
removing it.

**Drop the opam route from macOS entirely** and rely on nix there. Rejected:
nix cannot see opam-packaging failures on Darwin at all. Issue #13 is exactly
the class of bug that only this route reports.

**Trim by version for all events rather than adding a fast path.** Rejected:
it would also reduce coverage on the default branch and on releases, which is
where the full sweep is worth its cost.

**A nightly `cron` for the full sweep.** Correct upstream, unusable in the fork:
`schedule` only fires from the workflow file on the default branch, and this
fork keeps `main` byte-identical to upstream so rebases stay clean. The
`ci-full` label works from a PR branch and needs no divergence.

## Consequences

- A PR that breaks the opam build on macOS specifically for Rocq 8.18.0 or
  8.19.0 is not caught until the full sweep runs. Given that the only known
  failure mode in that range is upstream packaging rather than this codebase,
  this is an accepted loss.
- The asymmetry between the two version lists looks like an oversight. Anyone
  "restoring symmetry" by adding `8.18.0` back to the opam fast path
  reintroduces the blocking flake; this ADR is the reason it is not there.
- If the `install-opam` matrix is ever bumped from `8.19.0` to `8.19.2` (the
  cheapest remedy for #13, verified but left undecided pending team
  discussion), the argument for excluding `8.18.0` still holds: no 8.18.x is
  outside the affected range.
- ubuntu still runs the `master` and `dev` cells on every pull request, so a
  merge can still be blocked by upstream having moved. Cutting those from the
  fast path as well is a separate decision, not taken here: on ubuntu they cost
  no wall clock, and they are the earliest warning that upstream broke us.
- The label path is code that nothing exercises unless someone uses it. It has
  to be verified deliberately, by applying `ci-full` to a PR once and
  confirming the 16 macOS cells come back. Otherwise it will be discovered
  broken at the moment it is first needed.
