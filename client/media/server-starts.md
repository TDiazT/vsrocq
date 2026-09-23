# Check that the language server starts

"Check again" runs `vsrocqtop` briefly to ask for its Rocq installation and version. If that fails, the message shows the first lines of its error output. Common causes:

- **The server was built for another Rocq.** This happens when `PATH` or `vsrocq.path` picks a `vsrocqtop` from a different opam switch than the Rocq you installed. Point `vsrocq.path` at the `vsrocqtop` of the switch you use.
- **`vsrocq.args` contains an option vsrocqtop does not know.** Remove it and check again.
- **Windows: `libgmp-10.dll` was not found.** The directory that contains the DLL is not on `PATH`. Start VS Code from the Rocq Platform or opam shell, or add that directory to `PATH`.
- **The server is `vscoqtop`, the old name.** Some Rocq Platform releases ship this extension's server under it, others the VsCoq server, which this extension cannot use. In the second case, see step 1.

"Show log" opens the extension's output, which has each command that was run and its full error output.
