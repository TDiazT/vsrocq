# Install the language server by lower bound, not by matching version

When the extension offers to install the language server, it hands opam the
minimum server version from `versionRequirements` and lets opam's solver pick
the version:

```sh
opam install 'vsrocq-language-server>=2.3.3'
```

It does not pin the version to the extension's own. The extension and the
server are released on independent tracks -- `publish-server.yml` derives the
opam version from the release tag, `publish-extension.yml` publishes whatever
is in `client/package.json`, and nothing couples them -- so a pinned command
names a package that may not exist. Of the nine extension releases from 2.3.0
to 2.4.3, three (2.3.2, 2.4.0 and 2.4.2) have no same-numbered package in
`ocaml/opam-repository`, and a pinned command would have failed outright for
each of them.

## Considered options

**Pin the matching version** (`vsrocq-language-server.<extension version>`).
Rejected: fails for 2.3.2, 2.4.0 and 2.4.2 as above. Extension 2.4.0 is the
sharpest case, because its own map entry demands server `>= 2.4.0` while opam
jumps from 2.3.4 to 2.4.1.

**Compute the target ourselves** by querying opam for available versions and
picking the newest that satisfies the bound. Rejected: it reimplements the
solver's job badly. Availability is not the same as installability -- the
newest server can require a newer Rocq than the switch has -- and it forces us
to parse opam-side revision strings such as `2.4.3+1`, which the
`compare-versions` library used in `versioning.ts` does not handle.

**Install unconstrained** (`opam install vsrocq-language-server`). Rejected:
opam would be free to propose upgrading Rocq underneath the user's project in
order to install the newest server.

## Consequences

- `versionRequirements` stops being advisory and becomes an input to a command
  we run. Whoever raises a minimum in that map takes on the obligation to
  confirm `publish-server.yml` actually ran for the corresponding tag.
- The map has no fallback for an unknown key. `versionRequirements[version]`
  returns `undefined` for a version nobody added a row for, and the map is
  edited by hand in the release commit. An explicit unknown-version branch is
  required before the value reaches a shell.
- The `"2.4.3": "2.3.3"` row sits below what 2.4.0 through 2.4.2 require and
  repeats the row above it, which looks like a copy rather than a deliberate
  loosening. It does not affect which version opam installs, since the solver
  takes the newest version satisfying either bound, but it does affect whether
  we warn about an already-installed 2.3.3. Confirm it upstream before relying
  on it for the warning.
- Opam-side revisions (`2.4.3+1`) never need to be parsed by the extension.
