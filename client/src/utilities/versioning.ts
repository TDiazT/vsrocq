import { ExtensionContext } from "vscode";
import Client from "../client";
import { compatibility, Compatibility } from "./setupProbe";

export const getRocqdocUrl = (rocqVersion: string) => {
    return `https://rocq-prover.org/doc/V${rocqVersion}/refman/index.html`;
};

export const checkVersion = (
    client: Client,
    context: ExtensionContext,
): Compatibility | undefined => {
    const extensionVersion = context.extension.packageJSON.version;
    const initializeResult = client.initializeResult;
    if (initializeResult === undefined) {
        Client.writeToVsrocqChannel(
            "Could not run compatibility tests: failed to receive initializeResult",
        );
        return undefined;
    }
    const serverInfo = initializeResult.serverInfo;
    if (serverInfo === undefined || serverInfo.version === undefined) {
        Client.writeToVsrocqChannel(
            "Could not run compatibility tests: failed to get serverInfo",
        );
        return undefined;
    }
    const { name, version } = serverInfo;
    Client.writeToVsrocqChannel(
        "[Versioning] Intialized server " + name + " [" + version + "]",
    );
    const result = compatibility(extensionVersion, name, version);
    if (result === undefined) {
        Client.writeToVsrocqChannel(
            "[Versioning] No known server requirement for client version " +
                extensionVersion +
                ": skipping the compatibility check",
        );
    } else if (!result.ok) {
        // The message is not raised here. extension.ts runs the install flow
        // with this same server version, which can name the command to fix
        // it; two popups for one problem is worse than one that is actionable.
        Client.writeToVsrocqChannel("[Versioning] " + result.message);
    }
    return result;
};
