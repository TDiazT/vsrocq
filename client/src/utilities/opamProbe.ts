import { exec } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import which from "which";
import {
    dirOnPath,
    InstalledServer,
    OpamFacts,
    SwitchRef,
} from "./serverInstall";

/**
 * True when opam's installed listing names at least one package.
 *
 * `opam list --installed rocq-core coq-core` exits 0 whether or not anything
 * matched, and prints `# No matches found` when nothing did, so the exit code
 * carries no information and the comment lines have to be skipped.
 */
export function rocqPresentIn(opamListOutput: string): boolean {
    return opamListOutput
        .split("\n")
        .some((line) => line.trim() !== "" && !line.startsWith("#"));
}

const stripSlash = (d: string) => d.replace(/\/+$/, "");

/**
 * How to refer to the switch installed at `prefix`.
 *
 * Global switches live one level under the opam root and are addressed by
 * name; anything else is a local switch, which opam will only discuss by its
 * prefix, and only when it has that prefix registered.
 */
export function switchRefForPrefix(
    prefix: string,
    opamRoot: string,
): SwitchRef {
    const root = stripSlash(opamRoot);
    const p = stripSlash(prefix);
    if (p.startsWith(root + "/")) {
        const name = p.slice(root.length + 1);
        if (name !== "" && !name.includes("/")) {
            return { kind: "global", name };
        }
    }
    // A local switch lives in `<dir>/_opam`, and opam addresses it as `<dir>`.
    // Passing the `_opam` itself to --switch makes opam look for a switch
    // inside it, which it reports as not installed.
    return {
        kind: "local",
        prefix: basename(p) === "_opam" ? dirname(p) : p,
    };
}

/**
 * The switch prefix this window's PATH resolves into, from the environment
 * `opam env` leaves behind.
 *
 * OPAM_SWITCH_PREFIX alone is not enough: it and PATH are written together,
 * but only PATH decides what `which` finds, so a prefix whose bin directory is
 * not on PATH is not the switch this window is using.
 */
export function switchPrefixOnPath(
    pathEnv: string,
    delim: string,
    switchPrefix: string | undefined,
    binDirs: string[],
): string | null {
    if (
        switchPrefix !== undefined &&
        switchPrefix !== "" &&
        dirOnPath(join(switchPrefix, "bin"), pathEnv, delim)
    ) {
        return switchPrefix;
    }
    // No usable prefix in the environment: the first entry on PATH that is an
    // opam switch's bin directory is what `which` would resolve through.
    const first = pathEnv
        .split(delim)
        .find((entry) => entry !== "" && binDirs.includes(stripSlash(entry)));
    return first === undefined ? null : dirname(stripSlash(first));
}

/** The switch names printed by `opam switch list --short`, one per line. */
export function parseSwitchList(output: string): string[] {
    return output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
}

/** The switches opam knows about, or null when it could not be asked. */
export async function listSwitches(cwd?: string): Promise<string[] | null> {
    const opam = await which("opam", { nothrow: true });
    if (!opam) {
        return null;
    }
    const out = await run(`"${opam}" switch list --short`, cwd);
    return out === null ? null : parseSwitchList(out);
}

/**
 * The version in a `--columns=name,version --short` listing, or null when
 * opam printed nothing, which is what it does for a package that is not
 * installed (exiting 0 either way).
 */
export function parseInstalledVersion(output: string): string | null {
    const line = output
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l !== "");
    if (line === undefined) {
        return null;
    }
    const parts = line.split(/\s+/);
    return parts.length >= 2 ? parts[1] : null;
}

/** What opam knows about one switch. */
export type SwitchFacts = {
    /** Where opam installs binaries for this switch. */
    binDir: string | null;
    /** The Rocq in this switch, or null if it has none. */
    rocqVersion: string | null;
    /** The language server in this switch, or null if it has none. */
    serverVersion: string | null;
};

async function installedVersion(
    opam: string,
    switchName: string,
    pkg: string,
    cwd?: string,
): Promise<string | null> {
    const out = await run(
        `"${opam}" list --switch='${switchName}' --installed ${pkg} --short --columns=name,version`,
        cwd,
    );
    return out === null ? null : parseInstalledVersion(out);
}

/**
 * Everything the install modal needs about a switch the user picked. Returns
 * null when opam itself could not be asked, which is different from a switch
 * that simply has nothing installed.
 */
export async function probeSwitch(
    switchName: string,
    cwd?: string,
): Promise<SwitchFacts | null> {
    const opam = await which("opam", { nothrow: true });
    if (!opam) {
        return null;
    }
    const bin = await run(`"${opam}" var --switch='${switchName}' bin`, cwd);
    return {
        binDir: bin === null ? null : bin.trim() || null,
        rocqVersion: await installedVersion(opam, switchName, "rocq-core", cwd),
        serverVersion: await installedVersion(
            opam,
            switchName,
            "vsrocq-language-server",
            cwd,
        ),
    };
}

/** The switch named by `opam switch show`, or null when it named none. */
export function parseSwitchName(opamSwitchShowOutput: string): string | null {
    const name = opamSwitchShowOutput.trim();
    return name === "" ? null : name;
}

function run(command: string, cwd?: string): Promise<string | null> {
    return new Promise((resolve) => {
        exec(command, { cwd }, (error, stdout) =>
            resolve(error ? null : stdout),
        );
    });
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Asks opam what the extension needs to know before offering an install.
 *
 * Impure by design: `advise` stays a pure function of the result, so this is
 * the only part that has to be exercised against a real machine.
 */
export async function probeOpam(cwd?: string): Promise<OpamFacts> {
    const opam = await which("opam", { nothrow: true });
    if (!opam) {
        // VS Code inherits its environment from however it was launched, so a
        // desktop-launched window can miss the PATH the user's shell sets up.
        // An ~/.opam means opam has been used on this machine and it is the
        // environment that is wrong, which is different advice from "install
        // opam". Neither is worth guessing about beyond this.
        const usedBefore = await exists(join(homedir(), ".opam"));
        return {
            available: false,
            reason: usedBefore ? "notOnPath" : "absent",
        };
    }

    const shown = await run(`"${opam}" switch show`, cwd);
    if (shown === null) {
        // The binary exists but cannot answer, which an uninitialised opam
        // root does (`opam init` never run). Offering the install command
        // here would hand the user something that fails immediately.
        return { available: false, reason: "unusable" };
    }
    const switchName = parseSwitchName(shown);

    const listed = await run(
        `"${opam}" list --installed rocq-core coq-core`,
        cwd,
    );

    return {
        available: true,
        switchName,
        rocqPresent: listed === null ? false : rocqPresentIn(listed),
        globalServer:
            switchName === null
                ? null
                : await serverInSwitch(opam, switchName, cwd),
        windowSwitch: await windowSwitch(opam, cwd),
    };
}

/** The server installed in a switch opam can be asked about, with its path. */
async function serverInSwitch(
    opam: string,
    switchName: string,
    cwd?: string,
): Promise<InstalledServer | null> {
    const version = await installedVersion(
        opam,
        switchName,
        "vsrocq-language-server",
        cwd,
    );
    if (version === null) {
        return null;
    }
    const bin = await run(`"${opam}" var --switch='${switchName}' bin`, cwd);
    const binDir = bin === null ? null : bin.trim();
    return binDir ? { version, path: join(binDir, "vsrocqtop") } : null;
}

/**
 * The switch this window resolves binaries through, named the way opam names
 * it. Returns null when PATH goes through no switch at all, which is what a
 * window launched with no opam environment looks like.
 */
async function windowSwitch(
    opam: string,
    cwd?: string,
): Promise<SwitchRef | null> {
    const rootOut = await run(`"${opam}" var root`, cwd);
    const opamRoot = rootOut === null ? null : rootOut.trim();
    if (!opamRoot) {
        return null;
    }
    const prefix = switchPrefixOnPath(
        process.env.PATH ?? "",
        delimiter,
        process.env.OPAM_SWITCH_PREFIX,
        await switchBinDirs(opam, opamRoot, cwd),
    );
    return prefix === null ? null : switchRefForPrefix(prefix, opamRoot);
}

/**
 * The bin directories of the switches opam has registered, used to recognise
 * one on PATH when the environment carries no OPAM_SWITCH_PREFIX. A local
 * switch opam has not registered cannot be recognised this way, and a window
 * whose PATH goes through one is reported as having no switch rather than
 * being described wrongly.
 */
async function switchBinDirs(
    opam: string,
    opamRoot: string,
    cwd?: string,
): Promise<string[]> {
    const listed = await run(`"${opam}" switch list --short`, cwd);
    if (listed === null) {
        return [];
    }
    return parseSwitchList(listed).map((name) =>
        // opam lists a local switch as its directory, whose binaries are one
        // `_opam` further down.
        name.startsWith("/")
            ? join(name, "_opam", "bin")
            : join(opamRoot, name, "bin"),
    );
}
