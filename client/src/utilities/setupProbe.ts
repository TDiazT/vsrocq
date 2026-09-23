import { exec } from "node:child_process";
import * as path from "node:path";
import which from "which";
import {
    missingConfiguredServerMessage,
    resolveServerBinary,
} from "./serverBinary";
import { satisfies, versionRequirements } from "./serverInstall";

/**
 * Finds and launches vsrocqtop the way the extension will, and says what is
 * wrong when that fails. Must not import `vscode`, so it runs in test:unit.
 */

export interface ProbeInput {
    pathSetting: string;
    envPath: string | undefined;
    args: string[];
    cwd: string | undefined;
    timeoutMs?: number;
}

export type NotFoundReason =
    "settingUnresolved" | "notOnPath" | "onlyVscoqtopOnPath";

export type LaunchResult =
    | {
          status: "ok";
          rocqPath: string;
          versionOutput: string;
          rocqVersion: string;
      }
    // `transcript` holds every command run and its full error output, for
    // the log; the message only quotes the start of it.
    | { status: "failed"; stderr: string; transcript: string }
    | { status: "timedOut"; transcript: string };

type ServerLookup =
    | { found: false; reason: NotFoundReason; path?: string }
    | { found: true; path: string; source: "setting" | "PATH" };

export type SetupStatus =
    | { found: false; reason: NotFoundReason; path?: string }
    | {
          found: true;
          path: string;
          source: "setting" | "PATH";
          launch: LaunchResult;
      };

export type Compatibility = { ok: boolean; message: string };

type RunResult =
    | { kind: "ok"; stdout: string }
    | { kind: "failed"; stderr: string; command: string }
    | { kind: "timedOut"; command: string };

// Long enough for a first launch slowed by Gatekeeper or a virus scanner,
// since this probe also gates the normal server start.
const DEFAULT_TIMEOUT_MS = 30000;
const ROCQ_VERSION = /\b\d\.\d+(\.\d|\+rc\d|\.dev|\+alpha|\+beta)\b/g;

const isVscoqtop = (file: string) => path.basename(file).startsWith("vscoqtop");

async function findServer(input: ProbeInput): Promise<ServerLookup> {
    if (input.pathSetting) {
        const resolved = await resolveServerBinary(
            input.pathSetting,
            input.envPath,
        );
        if (resolved === null) {
            return { found: false, reason: "settingUnresolved" };
        }
        return { found: true, path: resolved, source: "setting" };
    }
    const lookup = { nothrow: true, path: input.envPath } as const;
    const server = await which("vsrocqtop", lookup);
    if (server) {
        return { found: true, path: server, source: "PATH" };
    }
    const old = await which("vscoqtop", lookup);
    if (old) {
        return { found: false, reason: "onlyVscoqtopOnPath", path: old };
    }
    return { found: false, reason: "notOnPath" };
}

// The command line is built the way the server launch builds it:
// `getServerConfiguration` spawns with `shell: true`, which joins the command
// and its arguments unquoted, so a vsrocq.args entry such as "-R theories Foo"
// reaches vsrocqtop as three arguments. Probing any other way would pass
// setups that fail to launch, or fail setups that launch.
function run(
    file: string,
    args: string[],
    input: ProbeInput,
): Promise<RunResult> {
    const command = [file, ...args].join(" ");
    return new Promise((resolve) => {
        exec(
            command,
            {
                cwd: input.cwd,
                timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            },
            (error, stdout, stderr) => {
                if (!error) {
                    resolve({ kind: "ok", stdout });
                } else if (error.killed) {
                    resolve({ kind: "timedOut", command });
                } else {
                    resolve({
                        kind: "failed",
                        stderr: stderr || error.message,
                        command,
                    });
                }
            },
        );
    });
}

function transcriptOf(results: Exclude<RunResult, { kind: "ok" }>[]): string {
    return results
        .map((r) =>
            r.kind === "timedOut"
                ? `$ ${r.command}\n(no answer before the timeout)`
                : `$ ${r.command}\n${r.stderr.trim()}`,
        )
        .join("\n\n");
}

function launchFailure(
    results: Exclude<RunResult, { kind: "ok" }>[],
): LaunchResult {
    const last = results[results.length - 1];
    const transcript = transcriptOf(results);
    return last.kind === "timedOut"
        ? { status: "timedOut", transcript }
        : { status: "failed", stderr: last.stderr, transcript };
}

async function launchServer(
    server: string,
    input: ProbeInput,
): Promise<LaunchResult> {
    let where = await run(
        server,
        ["-without-project-file", "-where", ...input.args],
        input,
    );
    if (where.kind === "failed") {
        // vsrocqtop older than 2.4.0 does not know -without-project-file.
        const first = where;
        where = await run(server, ["-where", ...input.args], input);
        if (where.kind !== "ok") {
            return launchFailure([first, where]);
        }
    }
    if (where.kind !== "ok") {
        return launchFailure([where]);
    }
    const version = await run(server, ["-v", ...input.args], input);
    if (version.kind !== "ok") {
        return launchFailure([version]);
    }
    return {
        status: "ok",
        rocqPath: where.stdout,
        versionOutput: version.stdout,
        rocqVersion: version.stdout.match(ROCQ_VERSION)?.[0] ?? "",
    };
}

export async function probeSetup(input: ProbeInput): Promise<SetupStatus> {
    const server = await findServer(input);
    if (!server.found) {
        return server;
    }
    return { ...server, launch: await launchServer(server.path, input) };
}

// vscoqtop is either the VsCoq server or, in some Rocq Platform releases, this
// extension's server under its old name, so it is tried rather than refused.
const OLD_NAME_HINT =
    " vscoqtop is the old name: some Rocq Platform releases ship this extension's server under it, others ship the VsCoq server, which this extension cannot use. If it is the VsCoq server, install vsrocq-language-server.";

export function describeStatus(
    status: SetupStatus,
    pathSetting: string,
    args: string[],
): { ok: boolean; message: string } {
    const fail = (message: string) => ({ ok: false, message });
    if (!status.found) {
        switch (status.reason) {
            case "settingUnresolved":
                return fail(missingConfiguredServerMessage(pathSetting));
            case "onlyVscoqtopOnPath":
                return fail(
                    `vsrocqtop is not on PATH, but vscoqtop is: ${status.path}. If it came with the Rocq Platform, it may be this extension's server under its old name: set vsrocq.path to it to try it. Otherwise it is the VsCoq server; install vsrocq-language-server.`,
                );
            case "notOnPath":
                return fail(
                    "vsrocqtop is not on the PATH that VS Code sees, and vsrocq.path is not set.",
                );
        }
    }
    const where = `${status.path} (from ${status.source === "setting" ? "vsrocq.path" : "PATH"})`;
    const oldNameHint = isVscoqtop(status.path) ? OLD_NAME_HINT : "";
    switch (status.launch.status) {
        case "ok":
            return {
                ok: true,
                message: `Found vsrocqtop at ${where}, Rocq ${status.launch.rocqVersion}.`,
            };
        case "timedOut":
            return fail(
                `The language server at ${where} did not answer in time.${oldNameHint}`,
            );
        case "failed": {
            const firstLines = status.launch.stderr
                .trim()
                .split("\n")
                .slice(0, 5)
                .join("\n");
            const argsHint =
                args.length > 0
                    ? " vsrocq.args is set; check that its flags are valid."
                    : "";
            return fail(
                `The language server at ${where} failed to start: ${firstLines}${argsHint}${oldNameHint} The log has the full error.`,
            );
        }
    }
}

/**
 * Whether the running server meets this extension's requirement. Undefined
 * when `versionRequirements` has no row for the extension version: ADR-0002
 * forbids inventing a bound, so no claim is made either way.
 */
export function compatibility(
    extensionVersion: string,
    serverName: string,
    serverVersion: string,
): Compatibility | undefined {
    const required: string | undefined = versionRequirements[extensionVersion];
    if (required === undefined) {
        return undefined;
    }
    return satisfies(serverVersion, required)
        ? {
              ok: true,
              message: `${serverName} ${serverVersion} works with VsRocq ${extensionVersion}.`,
          }
        : {
              ok: false,
              message: `VsRocq ${extensionVersion} needs ${serverName} ${required} or newer; found ${serverVersion}.`,
          };
}
