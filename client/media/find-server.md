# Let VS Code find vsrocqtop

VS Code looks for the language server in this order:

1. The `vsrocq.path` setting, if it is set.
2. `vsrocqtop` on the `PATH` VS Code started with.

"Look for it in opam" on the left checks whether a switch already has the server and, if so, offers to set `vsrocq.path` to it.

## VS Code does not see my opam switch

`opam env` changes the `PATH` of your terminal only. VS Code started from the Dock, the Start menu or a desktop launcher does not see it. Either:

- start VS Code from a terminal where the switch is active, with `code .`, or
- set `vsrocq.path` to the full path of `vsrocqtop`. To find it, run this in a terminal where the switch is active:

```
opam var bin
```

and use `<that directory>/vsrocqtop`.

## Several opam switches

If different projects use different switches, set `vsrocq.path` in each project's workspace settings (`.vscode/settings.json`) instead of your user settings:

```json
{ "vsrocq.path": "/home/me/.opam/my-switch/bin/vsrocqtop" }
```
