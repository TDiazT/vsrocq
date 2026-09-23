# Check that the extension and server versions match

The extension updates itself; the language server only changes when you upgrade it with opam. Each version of the extension needs a minimum version of the server. When the server is too old, the extension starts but features stop working or the proof view stays empty.

This step is checked once the language server is running. If it is not ticked, open a `.v` file and click "Check again": the message says whether the running server is new enough for this extension. For an extension version with no known requirement, it says so and checks nothing.

"Upgrade the language server" on the left gives you the opam command with the minimum version this extension needs, for the switch this window uses. To upgrade by hand instead:

```
opam update
opam upgrade vsrocq-language-server
```

The running server keeps its old version until you reload the window.
