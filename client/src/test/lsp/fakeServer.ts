/**
 * A stand-in for `vsrocqtop` that misbehaves on purpose, so that
 * `harness.test.ts` can exercise what the harness does about a server that
 * dies or stops answering. The real server only does either of those by
 * accident, roughly one run in eight (see `stackOverflow.test.ts`), which is
 * not something to build a test on.
 *
 * It speaks just enough LSP to get `LspHarness.start` through the handshake:
 * `Content-Length` framing and a reply to `initialize`. Everything after that
 * depends on `--mode`:
 *
 *   wedge   answer nothing ever again, and stay alive
 *   die     kill itself with SIGBUS as soon as the handshake is done
 *
 * Run as `node fakeServer.js --mode=<mode>`, which is what the harness spawns
 * when `VSROCQPATH` points at the node binary; the harness appends arguments
 * of its own, and they are ignored here.
 */

const mode = process.argv.find((a) => a.startsWith("--mode="))?.slice(7);

function send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), "utf-8");
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    process.stdout.write(body);
}

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    for (;;) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
            return;
        }
        const header = buffer.subarray(0, headerEnd).toString("ascii");
        const length = Number(/Content-Length: *(\d+)/i.exec(header)?.[1]);
        const bodyStart = headerEnd + 4;
        if (!Number.isFinite(length) || buffer.length < bodyStart + length) {
            return;
        }
        const message = JSON.parse(
            buffer.subarray(bodyStart, bodyStart + length).toString("utf-8"),
        );
        buffer = buffer.subarray(bodyStart + length);

        if (message.method === "initialize") {
            send({
                jsonrpc: "2.0",
                id: message.id,
                result: { capabilities: {} },
            });
            continue;
        }
        if (message.method === "initialized" && mode === "die") {
            // On the last message of the handshake rather than during it, so
            // that the harness is fully started and the test is about a death
            // mid-work. SIGBUS because that is the signal a prover-thread
            // stack overflow arrives as on macOS, and telling that apart from
            // a hang is the point.
            process.kill(process.pid, "SIGBUS");
            continue;
        }
        // Anything else is neither answered nor acted on: both modes are
        // about what the harness does when nothing comes back.
    }
});

// Nothing else keeps this alive once stdin is drained in `wedge` mode, and a
// server that exits on its own is not what that mode is for.
setInterval(() => {}, 1000);
