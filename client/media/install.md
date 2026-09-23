# Install Rocq and the VsRocq language server

The extension does not check proofs itself. It starts `vsrocqtop`, the VsRocq language server, which comes in the opam package `vsrocq-language-server`. It has to be built against the same Rocq you use.

## With opam

"Install the language server" on the left works out which opam switch this window uses and gives you the install command for it, to run in a terminal. To do it by hand:

```
opam install rocq-prover vsrocq-language-server
```

This installs into your shell's current opam switch. Step 2 explains how VS Code finds it.

## With the Rocq Platform

The [Rocq Platform](https://rocq-prover.org/install) installs Rocq, common libraries and the language server together.

Some Platform releases ship the server under its old name, `vscoqtop`. If "Check again" reports only `vscoqtop`, point `vsrocq.path` at it to try it. If it does not start, it is the VsCoq server: install the language server with opam, or use VsCoq Legacy.

## Rocq 8.17 and older

This extension needs Rocq 8.18 or later. For older versions, use VsCoq Legacy. The marketplace may redirect searches for "VsCoq" here; to install it anyway, press Ctrl+P (Cmd+P on macOS) and run:

```
ext install coq-community.vscoq1
```
