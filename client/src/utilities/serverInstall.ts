import { compareVersions } from "compare-versions";

/**
 * Decides what to tell the user about the language server, and what command to
 * offer, from facts the caller has already gathered. Pure and synchronous: it
 * must not import `vscode` or run anything, so it can be tested without VS
 * Code, without opam and without a Rocq installation.
 *
 * See docs/adr/0002-install-the-language-server-by-lower-bound.md for why the
 * command carries a lower bound rather than a pinned version.
 */

/**
 * How to name the opam switch a directory belongs to. Local switches have no
 * name of their own -- opam addresses them by their prefix, and will not answer
 * questions about one it has not registered -- so they carry the path instead.
 */
export type SwitchRef =
    { kind: "global"; name: string } | { kind: "local"; prefix: string };

/** A language server found in some switch, and where its binary lives. */
export type InstalledServer = { version: string; path: string };

/** What the caller learned about opam, or why it could not learn it. */
export type OpamFacts =
    | { available: false; reason: "absent" | "notOnPath" | "unusable" }
    | {
          available: true;
          /** null when opam reported no switch selected. */
          switchName: string | null;
          rocqPresent: boolean;
          /**
           * The server installed in the switch `opam switch show` names. The
           * window can be unable to reach it while opam is perfectly aware of
           * it, which is the difference between advising a reload and advising
           * an install.
           */
          globalServer: InstalledServer | null;
          /**
           * The switch this window's PATH resolves into, which is not
           * necessarily the one opam has selected: `opam env` writes PATH, and
           * a later `opam switch set` does not revisit a shell that already
           * ran it. null when PATH resolves into no switch at all.
           */
          windowSwitch: SwitchRef | null;
      };

/** Everything the decision depends on. */
export type Facts = {
    extensionVersion: string;
    /** The version the running server reported, or null if none was found. */
    serverVersion: string | null;
    /** The `vsrocq.path` setting, or null when it is unset. */
    configuredPath: string | null;
    opam: OpamFacts;
};

export type InstallAdvice =
    /** A server is installed and already satisfies the bound. */
    | { kind: "serverOk" }
    /**
     * No row in `versionRequirements` for this extension version. The map is
     * maintained by hand in each release commit, so a release can ship without
     * one; there is no bound to install against and none may be invented.
     */
    | { kind: "unknownExtensionVersion"; extension: string }
    /**
     * `vsrocq.path` names a binary explicitly, and `toolchain.ts` prefers it
     * over anything on PATH. Installing into opam would leave that setting
     * winning, so offer the setting rather than the command.
     */
    | { kind: "pathOverride"; configured: string; required: string }
    /**
     * opam cannot run the command. `absent` means it is not installed;
     * `notOnPath` means it exists but the environment VS Code inherited cannot
     * see it, which is a different problem with different advice.
     */
    | {
          kind: "noOpam";
          reason: "absent" | "notOnPath" | "unusable";
          required: string;
      }
    /**
     * A server good enough for this extension is installed in opam's selected
     * switch, and this window resolves binaries somewhere else. Installing
     * again would change nothing; the window has to be pointed at it.
     */
    | {
          kind: "serverUnreachable";
          required: string;
          /** The switch holding it, which is opam's selected switch. */
          switchName: string;
          server: InstalledServer;
          /** Carried so the modal can fall through to the install flow. */
          rocqPresent: boolean;
          /** Where this window looks instead, or null when it has no switch. */
          windowSwitch: SwitchRef | null;
      }
    | {
          kind: "offerInstall";
          /** Minimum server version this extension version requires. */
          required: string;
          command: string;
          switchName: string | null;
          rocqPresent: boolean;
          windowSwitch: SwitchRef | null;
      };

type VersionReq = {
    [index: string]: string;
};

/*  Version requirements for the client. Syntax is client version : minimum server version */
export const versionRequirements: VersionReq = {
    "2.0.0": "2.0.0",
    "2.0.1": "2.0.0",
    "2.0.2": "2.0.0",
    "2.0.3": "2.0.3",
    "2.1.0": "2.0.3",
    "2.1.1": "2.1.1",
    "2.1.2": "2.1.2",
    "2.1.3": "2.1.3",
    "2.1.5": "2.1.5",
    "2.1.6": "2.1.5",
    "2.1.7": "2.1.7",
    "2.2.0": "2.1.7",
    "2.2.1": "2.2.1",
    "2.2.2": "2.2.2",
    "2.2.3": "2.2.2",
    "2.2.4": "2.2.4",
    "2.2.5": "2.2.5",
    "2.2.6": "2.2.6",
    "2.3.0": "2.3.0",
    "2.3.1": "2.3.0",
    "2.3.2": "2.3.0",
    "2.3.3": "2.3.3",
    "2.3.4": "2.3.3",
    "2.4.0": "2.4.0",
    "2.4.1": "2.4.0",
    "2.4.2": "2.4.0",
    "2.4.3": "2.3.3",
};

/**
 * The opam command that installs a server satisfying `required`.
 *
 * With no switch the command uses whatever the terminal's shell resolves,
 * which need not be the switch this window detected. Passing one pins it, so
 * choosing a switch actually removes the ambiguity instead of describing it.
 */
/**
 * Whether `dir` is one of the entries in a PATH string.
 *
 * `toolchain.ts` finds the server with `which("vsrocqtop")`, which searches
 * PATH and nothing else, so this is what decides whether a server installed
 * into some switch is reachable from this window at all.
 */
export function dirOnPath(
    dir: string,
    pathEnv: string,
    delimiter: string,
): boolean {
    const strip = (d: string) => d.replace(/\/+$/, "");
    const target = strip(dir);
    return pathEnv
        .split(delimiter)
        .some((entry) => entry !== "" && strip(entry) === target);
}

/** Whether an installed server version meets a required lower bound. */
export function satisfies(serverVersion: string, required: string): boolean {
    // opam publishes revisions such as 2.4.3+1. compare-versions treats the
    // suffix as semver build metadata, so it compares equal to 2.4.3 rather
    // than throwing or sorting oddly.
    return compareVersions(serverVersion, required) >= 0;
}

export function installCommand(
    required: string,
    switchName: string | null,
): string {
    const pin = switchName === null ? "" : `--switch='${switchName}' `;
    return `opam install ${pin}'vsrocq-language-server>=${required}'`;
}

export function advise(facts: Facts): InstallAdvice {
    const required: string | undefined =
        versionRequirements[facts.extensionVersion];
    if (required === undefined) {
        return {
            kind: "unknownExtensionVersion",
            extension: facts.extensionVersion,
        };
    }

    if (
        facts.serverVersion !== null &&
        satisfies(facts.serverVersion, required)
    ) {
        return { kind: "serverOk" };
    }

    if (facts.configuredPath !== null) {
        return {
            kind: "pathOverride",
            configured: facts.configuredPath,
            required,
        };
    }

    const opam = facts.opam;
    if (!opam.available) {
        return { kind: "noOpam", reason: opam.reason, required };
    }

    // Nothing on PATH, yet opam's selected switch already holds a server good
    // enough. Offering an install here is what sent a user round the loop of
    // installing a server they already had.
    if (
        opam.switchName !== null &&
        opam.globalServer !== null &&
        satisfies(opam.globalServer.version, required)
    ) {
        return {
            kind: "serverUnreachable",
            required,
            switchName: opam.switchName,
            server: opam.globalServer,
            rocqPresent: opam.rocqPresent,
            windowSwitch: opam.windowSwitch,
        };
    }

    return {
        kind: "offerInstall",
        required,
        command: installCommand(required, null),
        switchName: opam.switchName,
        rocqPresent: opam.rocqPresent,
        windowSwitch: opam.windowSwitch,
    };
}

/** How to name a switch in a sentence. */
export function describeSwitch(ref: SwitchRef): string {
    return ref.kind === "global"
        ? `switch ${ref.name}`
        : `the local switch at ${ref.prefix}`;
}

/**
 * Where this window looks, as a sentence that also says why it looks there.
 * The bare fact invites the question; answering it is what makes restarting
 * VS Code read as a fix rather than as a ritual. It explains the window's
 * switch, so it belongs wherever that switch is named, however the switch
 * holding the server came to be chosen.
 */
function windowLooksIn(windowSwitch: SwitchRef | null): string {
    return windowSwitch === null
        ? "This window has no opam switch active."
        : `This window looks for it in ${describeSwitch(windowSwitch)}, which it inherited when VS Code started.`;
}

/**
 * The switch an install could target so that this window would then find the
 * result, in the form `--switch` takes. A window resolving through no switch
 * at all has none: the install would land somewhere it cannot see either.
 */
export function installTargetFor(
    windowSwitch: SwitchRef | null,
): string | null {
    if (windowSwitch === null) {
        return null;
    }
    return windowSwitch.kind === "global"
        ? windowSwitch.name
        : windowSwitch.prefix;
}

/**
 * How to refer to a switch known only by the string `--switch` takes. opam
 * names a local switch by a path, so a leading slash is what separates the
 * two; a global switch name cannot contain one.
 */
export function switchRefForName(name: string): SwitchRef {
    return name.startsWith("/")
        ? { kind: "local", prefix: name }
        : { kind: "global", name };
}

const capitalise = (t: string) => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;

/** "a, or b." / "a, b, or c." with the first letter raised. */
function asSentence(options: string[]): string {
    const last = options[options.length - 1];
    const joined =
        options.length === 1
            ? last
            : `${options.slice(0, -1).join(", ")}, or ${last}`;
    return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}

/**
 * The paragraphs for a server this window cannot reach.
 *
 * `isGlobal` is not a matter of phrasing: `opam switch set` on a switch that
 * is already the selected one does nothing, so offering it there would be the
 * same empty advice this modal exists to replace. It decides both what the
 * switch is called and which fix is on offer.
 *
 * `installTarget` names a switch to install into, when installing is a fix
 * rather than a detour. It is: a server in the switch this window resolves
 * through needs neither a setting nor a restart to be found.
 */
export function serverElsewhereLines(opts: {
    switchName: string;
    server: InstalledServer;
    windowSwitch: SwitchRef | null;
    isGlobal: boolean;
    installTarget: string | null;
}): string[] {
    const { switchName, server, windowSwitch, isGlobal, installTarget } = opts;
    const held = isGlobal
        ? `Your global switch ${switchName}`
        : `Switch ${switchName}`;

    const fixes = isGlobal
        ? [
              `quit VS Code and start it again to pick up ${switchName}`,
              `set vsrocq.path to ${server.path}`,
          ]
        : [
              `set vsrocq.path to ${server.path} to use it in this window`,
              `make ${switchName} your global switch with \`opam switch set ${switchName}\` and restart VS Code to use it everywhere`,
          ];
    if (installTarget !== null) {
        fixes.push(
            `install a server into ${describeSwitch(switchRefForName(installTarget))}`,
        );
    }

    return [
        `${held} has language server ${server.version} installed. ${windowLooksIn(windowSwitch)}`,
        asSentence(fixes),
    ];
}

/**
 * The paragraphs of the install modal.
 *
 * Every switch is labelled by whose it is. "Your global switch" is opam's
 * selection, "this window looks for the server in" is what PATH resolves, and
 * a bare "switch X" is one the user named in the picker. The three are
 * routinely different, and a modal that says only "switch" leaves the reader
 * to guess which one it meant.
 */
export function installLines(opts: {
    advice: Extract<InstallAdvice, { kind: "offerInstall" }>;
    pinned: string | null;
    rocqPresent: boolean;
    /** Where the pinned switch keeps binaries, when opam could say. */
    pinnedBinDir: string | null;
}): string[] {
    const { advice, pinned, rocqPresent, pinnedBinDir } = opts;
    const lines = [
        `This extension needs language server ${advice.required} or newer.`,
        pinned === null
            ? "The following command installs it with opam:"
            : `The following command installs it into ${describeSwitch(switchRefForName(pinned))}:`,
        installCommand(advice.required, pinned),
    ];

    if (pinned === null) {
        const looksIn =
            advice.windowSwitch === null
                ? "This window has no opam switch active."
                : `This window looks for the server in ${describeSwitch(advice.windowSwitch)}.`;
        lines.push(
            `${looksIn} Running the command in the terminal installs it into your shell's switch, so choose a switch to pin it to one instead.`,
        );
    }

    if (!rocqPresent) {
        if (pinned !== null) {
            lines.push(
                `${capitalise(describeSwitch(switchRefForName(pinned)))} has no Rocq installed, so Rocq is built first, which can take a long time.`,
            );
        } else if (advice.switchName !== null) {
            // Unpinned, so the shell picks the switch and it need not be this
            // one. Naming it without the condition would promise a build that
            // may not happen.
            lines.push(
                `Your global switch ${advice.switchName} has no Rocq installed. If your shell selects that switch, Rocq is built first, which can take a long time.`,
            );
        }
    }

    // What the install leaves behind. Installing into a switch this window
    // does not resolve through fixes nothing on its own, and finding that out
    // after a Rocq build is the worst time to find it out.
    if (pinned !== null) {
        if (pinned === installTargetFor(advice.windowSwitch)) {
            lines.push(
                `This window looks for the server in ${describeSwitch(advice.windowSwitch!)}, so nothing else is needed once the install finishes.`,
            );
        } else {
            const where =
                advice.windowSwitch === null
                    ? "This window has no opam switch active."
                    : `This window looks for the server in ${describeSwitch(advice.windowSwitch)}.`;
            const setting =
                pinnedBinDir === null
                    ? "set vsrocq.path to the vsrocqtop it installs"
                    : `set vsrocq.path to ${pinnedBinDir}/vsrocqtop`;
            lines.push(
                `${where} To use the server once it is installed, quit VS Code and start it again with ${pinned} active, or ${setting}.`,
            );
        }
    }

    return lines;
}

/**
 * The command that opens settings where `vsrocq.path` was just written.
 *
 * `workbench.action.openSettings` always lands on the User tab, so a setting
 * written at workspace scope is off-screen behind another tab and reads as
 * having not been written at all.
 */
export function settingsCommandFor(workspaceScope: boolean): string {
    return workspaceScope
        ? "workbench.action.openWorkspaceSettings"
        : "workbench.action.openSettings";
}
