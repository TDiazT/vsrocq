import { compareVersions } from "compare-versions";
import { ExtensionContext } from "vscode";
import Client from "../client";
import { versionRequirements } from "./serverInstall";

export const getRocqdocUrl = (rocqVersion: string) => {
    return `https://rocq-prover.org/doc/V${rocqVersion}/refman/index.html`;
};

export const checkVersion = (client: Client, context: ExtensionContext) => {
    const extensionVersion = context.extension.packageJSON.version;
    const initializeResult = client.initializeResult;
    if (initializeResult !== undefined) {
        const serverInfo = client.initializeResult?.serverInfo;
        if (serverInfo !== undefined) {
            const { name, version } = serverInfo;
            Client.writeToVsrocqChannel(
                "[Versioning] Intialized server " + name + " [" + version + "]",
            );
            if (!checkCompat(extensionVersion, version)) {
                // The message is no longer raised here. extension.ts runs the
                // install flow with this same server version, which can name
                // the command to fix it; two popups for one problem is worse
                // than one that is actionable.
                Client.writeToVsrocqChannel(
                    "[Versioning] Server " +
                        version +
                        " is older than the " +
                        versionRequirements[extensionVersion] +
                        " required by extension " +
                        extensionVersion,
                );
            }
        } else {
            Client.writeToVsrocqChannel(
                "Could not run compatibility tests: failed to get serverInfo",
            );
        }
    } else {
        Client.writeToVsrocqChannel(
            "Could not run compatibility tests: failed to receive initializeResult",
        );
    }
};

//We will add version ranges as we start releasing
const checkCompat = (
    clientVersion: string,
    serverVersion: string | undefined,
) => {
    const required: string | undefined = versionRequirements[clientVersion];
    if (required === undefined) {
        // No row for this extension version. The map is maintained by hand in
        // the release commit, so a build can exist without one. There is no
        // bound to compare against, and passing undefined to compareVersions
        // throws `Invalid argument expected string`, which would take down the
        // rest of the client.start() callback with it. Report nothing rather
        // than reporting something untrue.
        Client.writeToVsrocqChannel(
            "[Versioning] No known server requirement for client version " +
                clientVersion +
                ": skipping the compatibility check",
        );
        return true;
    }
    if (serverVersion !== undefined) {
        return compareVersions(serverVersion, required) >= 0;
    }
    return false;
};
