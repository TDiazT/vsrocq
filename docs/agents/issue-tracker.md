# Issue tracker: GitHub Issues

Issues for this fork live in **GitHub Issues on `TDiazT/RocqLSP`** — the parent
unification repository, not this fork. This repository is a submodule of it, and
keeping one tracker for both avoids splitting the work in two places.

```sh
gh issue list -R TDiazT/RocqLSP
gh issue view <N> -R TDiazT/RocqLSP
gh issue create -R TDiazT/RocqLSP --title ... --label bug --label needs-triage
```

## Conventions

- Triage state is a label; see `triage-labels.md` for the vocabulary.
- An issue about a defect that CI catches names **the commit the fix belongs
  in**, because this fork amends fixes into the commit that introduced the
  problem rather than stacking them on top. Re-resolve that hash before using
  it: `staging` is rebased often and hashes move.
- **Never write `#NNN` in a commit message in this fork.** GitHub resolves the
  reference against `rocq-prover/vsrocq`, the upstream this fork was made from,
  and cross-links a public issue there permanently. Refer to issues by title.

## When a skill says "publish to the issue tracker"

`gh issue create -R TDiazT/RocqLSP`.

## When a skill says "fetch the relevant ticket"

`gh issue view <N> -R TDiazT/RocqLSP`. The user normally passes the number.
