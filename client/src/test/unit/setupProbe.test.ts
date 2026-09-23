import { expect } from "expect";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
    compatibility,
    describeStatus,
    failingStep,
    ProbeInput,
    probeSetup,
} from "../../utilities/setupProbe";

const OK_SERVER = `#!/bin/sh
for a in "$@"; do
  case "$a" in
    -where) echo /fake/lib/rocq; exit 0 ;;
    -v) echo "The Rocq Prover, version 9.1.0"; exit 0 ;;
  esac
done
exit 2
`;

// vsrocqtop older than 2.4.0 rejects -without-project-file.
const PRE_240_SERVER = OK_SERVER.replace(
    "#!/bin/sh\n",
    `#!/bin/sh
if [ "$1" = "-without-project-file" ]; then echo "unknown option" >&2; exit 1; fi
`,
);

const CRASHING_SERVER = `#!/bin/sh
echo "error while loading shared libraries: libgmp.so.10" >&2
exit 1
`;

const HANGING_SERVER = `#!/bin/sh
exec sleep 30
`;

// Answers -where with its argument count, to show how vsrocq.args is split.
const ARGC_SERVER = `#!/bin/sh
for a in "$@"; do
  case "$a" in
    -where) echo "argc=$#"; exit 0 ;;
    -v) echo "The Rocq Prover, version 9.1.0"; exit 0 ;;
  esac
done
exit 2
`;

// The fakes are shell scripts.
(process.platform === "win32" ? describe.skip : describe)("probeSetup", () => {
    let root: string;

    async function fake(
        dir: string,
        name: string,
        body: string,
    ): Promise<string> {
        const folder = path.join(root, dir);
        await mkdir(folder, { recursive: true });
        const file = path.join(folder, name);
        await writeFile(file, body, { mode: 0o755 });
        return file;
    }

    function input(overrides: Partial<ProbeInput>): ProbeInput {
        return {
            pathSetting: "",
            envPath: path.join(root, "empty"),
            args: [],
            cwd: undefined,
            ...overrides,
        };
    }

    before(async () => {
        root = await mkdtemp(path.join(os.tmpdir(), "vsrocq-probe-"));
        await mkdir(path.join(root, "empty"));
    });

    it("finds and launches the server from vsrocq.path", async () => {
        const server = await fake("ok", "vsrocqtop", OK_SERVER);
        const status = await probeSetup(input({ pathSetting: server }));
        expect(status).toEqual({
            found: true,
            path: server,
            source: "setting",
            launch: {
                status: "ok",
                rocqPath: "/fake/lib/rocq\n",
                versionOutput: "The Rocq Prover, version 9.1.0\n",
                rocqVersion: "9.1.0",
            },
        });
        const { ok, message } = describeStatus(status, server, []);
        expect(ok).toBe(true);
        expect(message).toContain("(from vsrocq.path)");
    });

    it("finds the server on PATH", async () => {
        const server = await fake("onpath", "vsrocqtop", OK_SERVER);
        const status = await probeSetup(
            input({ envPath: path.dirname(server) }),
        );
        expect(status).toMatchObject({
            found: true,
            path: server,
            source: "PATH",
        });
        expect(describeStatus(status, "", []).message).toContain("(from PATH)");
    });

    it("resolves a bare command name in vsrocq.path through PATH", async () => {
        const server = await fake("bare", "vsrocqtop", OK_SERVER);
        const status = await probeSetup(
            input({
                pathSetting: "vsrocqtop",
                envPath: path.dirname(server),
            }),
        );
        expect(status).toMatchObject({
            found: true,
            path: server,
            source: "setting",
        });
    });

    it("falls back for servers older than 2.4.0", async () => {
        const server = await fake("pre240", "vsrocqtop", PRE_240_SERVER);
        const status = await probeSetup(input({ pathSetting: server }));
        expect(status).toMatchObject({ launch: { status: "ok" } });
    });

    it("reports a server that fails to start", async () => {
        const server = await fake("crash", "vsrocqtop", CRASHING_SERVER);
        const status = await probeSetup(input({ pathSetting: server }));
        expect(status).toMatchObject({ launch: { status: "failed" } });
        const { ok, message } = describeStatus(status, server, []);
        expect(ok).toBe(false);
        expect(message).toContain("libgmp.so.10");
        expect(message).not.toContain("vsrocq.args");
        expect(message).not.toContain("vscoqtop");
    });

    it("keeps every command and its full error for the log", async () => {
        const server = await fake("crash", "vsrocqtop", CRASHING_SERVER);
        const status = await probeSetup(input({ pathSetting: server }));
        // Both the current command and the pre-2.4.0 fallback ran.
        expect(status).toMatchObject({
            launch: {
                transcript: expect.stringContaining(
                    `$ ${server} -without-project-file -where`,
                ),
            },
        });
        expect(status).toMatchObject({
            launch: {
                transcript: expect.stringContaining(`$ ${server} -where`),
            },
        });
    });

    it("splits vsrocq.args the way the server launch does", async () => {
        const server = await fake("argc", "vsrocqtop", ARGC_SERVER);
        const status = await probeSetup(
            input({ pathSetting: server, args: ["-R theories Foo"] }),
        );
        // -without-project-file, -where, -R, theories, Foo.
        expect(status).toMatchObject({
            launch: { status: "ok", rocqPath: "argc=5\n" },
        });
    });

    it("mentions vsrocq.args when a failing server was given args", async () => {
        const server = await fake("crash", "vsrocqtop", CRASHING_SERVER);
        const status = await probeSetup(
            input({ pathSetting: server, args: ["-bt"] }),
        );
        expect(describeStatus(status, server, ["-bt"]).message).toContain(
            "vsrocq.args",
        );
    });

    it("gives up on a server that does not answer", async () => {
        const server = await fake("hang", "vsrocqtop", HANGING_SERVER);
        const status = await probeSetup(
            input({ pathSetting: server, timeoutMs: 500 }),
        );
        expect(status).toMatchObject({ launch: { status: "timedOut" } });
        expect(describeStatus(status, server, []).message).toContain(
            "did not answer",
        );
        expect(status).toMatchObject({
            launch: {
                transcript: expect.stringContaining(
                    "no answer before the timeout",
                ),
            },
        });
    });

    it("reports a vsrocq.path that resolves to nothing", async () => {
        const missing = path.join(root, "nowhere", "vsrocqtop");
        const status = await probeSetup(input({ pathSetting: missing }));
        expect(status).toEqual({
            found: false,
            reason: "settingUnresolved",
        });
        expect(describeStatus(status, missing, []).message).toContain(
            `vsrocq.path is set to ${missing}`,
        );
    });

    it("tries a vsrocq.path that points to vscoqtop", async () => {
        // Some Rocq Platform releases ship this extension's server
        // under its old name.
        const server = await fake("old", "vscoqtop", OK_SERVER);
        const status = await probeSetup(input({ pathSetting: server }));
        expect(status).toMatchObject({
            found: true,
            path: server,
            launch: { status: "ok" },
        });
    });

    it("explains the old name when vscoqtop fails to start", async () => {
        const server = await fake("oldcrash", "vscoqtop", CRASHING_SERVER);
        const status = await probeSetup(input({ pathSetting: server }));
        expect(describeStatus(status, server, []).message).toContain(
            "vscoqtop is the old name",
        );
    });

    it("reports a missing server", async () => {
        const status = await probeSetup(input({}));
        expect(status).toEqual({ found: false, reason: "notOnPath" });
    });

    it("reports vscoqtop on PATH without vsrocqtop", async () => {
        const old = await fake("oldonpath", "vscoqtop", OK_SERVER);
        const status = await probeSetup(input({ envPath: path.dirname(old) }));
        expect(status).toEqual({
            found: false,
            reason: "onlyVscoqtopOnPath",
            path: old,
        });
        const { message } = describeStatus(status, "", []);
        expect(message).toContain("set vsrocq.path to it");
        expect(message).toContain("vsrocq-language-server");
    });
});

describe("compatibility", () => {
    it("accepts a server that meets the listed requirement", () => {
        expect(compatibility("2.4.1", "vsrocqtop", "2.4.0")).toMatchObject({
            ok: true,
        });
    });

    it("rejects an older server and names the requirement", () => {
        const result = compatibility("2.4.1", "vsrocqtop", "2.3.3");
        expect(result?.ok).toBe(false);
        expect(result?.message).toContain("2.4.0");
    });

    it("makes no claim for an extension version without a row", () => {
        // ADR-0002: no bound may be invented for an unlisted version.
        expect(compatibility("9.9.9", "vsrocqtop", "2.5.0")).toBeUndefined();
    });
});

describe("failingStep", () => {
    it("sends a vsrocq.path that resolves to nothing to the find step", () => {
        expect(failingStep({ found: false, reason: "settingUnresolved" })).toBe(
            "findServer",
        );
    });

    it("sends a missing server to the install step", () => {
        expect(failingStep({ found: false, reason: "notOnPath" })).toBe(
            "install",
        );
        expect(
            failingStep({
                found: false,
                reason: "onlyVscoqtopOnPath",
                path: "/bin/vscoqtop",
            }),
        ).toBe("install");
    });

    it("sends a server that does not start to the start step", () => {
        expect(
            failingStep({
                found: true,
                path: "/bin/vsrocqtop",
                source: "PATH",
                launch: { status: "timedOut", transcript: "" },
            }),
        ).toBe("serverStarts");
    });

    it("has no step for a server that starts", () => {
        expect(
            failingStep({
                found: true,
                path: "/bin/vsrocqtop",
                source: "PATH",
                launch: {
                    status: "ok",
                    rocqPath: "",
                    versionOutput: "",
                    rocqVersion: "9.1",
                },
            }),
        ).toBeUndefined();
    });
});
