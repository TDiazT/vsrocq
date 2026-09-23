import { workspace } from "vscode";
import { Disposable } from "vscode-languageclient";
import { ServerOptions } from "vscode-languageclient/node";
import Client from "../client";
import { getConfigurationOption } from "../configuration";
import { SetupCheck } from "./setupCheck";
import { failingStep, SetupGuideStep } from "./setupProbe";

export enum ToolChainErrorCode {
    notFound = 1,
    launchError = 2,
}

export interface ToolchainError {
    status: ToolChainErrorCode;
    message: string;
    step: SetupGuideStep | undefined;
}

export default class VsRocqToolchainManager implements Disposable {
    private _vsrocqtopPath: string = "";
    private _rocqVersion: string = "";
    private _versionFullOutput: string = "";
    private _rocqPath: string = "";

    constructor(private readonly setupCheck: SetupCheck) {}

    public dispose(): void {}

    public async intialize(): Promise<void> {
        Client.writeToVsrocqChannel("[Toolchain] Searching for vsrocqtop");
        const status = await this.setupCheck.run();
        const { message } = this.setupCheck.describe(status);
        Client.writeToVsrocqChannel("[Toolchain] " + message);
        if (!status.found) {
            const error: ToolchainError = {
                status: ToolChainErrorCode.notFound,
                message,
                step: failingStep(status),
            };
            throw error;
        }
        this._vsrocqtopPath = status.path;
        const launch = status.launch;
        if (launch.status !== "ok") {
            const error: ToolchainError = {
                status: ToolChainErrorCode.launchError,
                message,
                step: failingStep(status),
            };
            throw error;
        }
        this._rocqPath = launch.rocqPath;
        this._versionFullOutput = launch.versionOutput;
        this._rocqVersion = launch.rocqVersion;
    }

    public getServerConfiguration(): ServerOptions {
        const args = getConfigurationOption("args") as string[];
        const serverOptions: ServerOptions = {
            command: this._vsrocqtopPath,
            args,
            options: {
                cwd: workspace.rootPath,
                shell: true,
            },
        };
        return serverOptions;
    }

    public getVsRocqTopPath(): string {
        return this._vsrocqtopPath;
    }

    public getRocqPath(): string {
        return this._rocqPath;
    }

    public getRocqVersion(): string {
        return this._rocqVersion;
    }

    public getversionFullOutput(): string {
        return this._versionFullOutput;
    }
}
