import { commands, workspace } from "vscode";
import Client from "../client";
import { getConfigurationOption } from "../configuration";
import {
    Compatibility,
    describeStatus,
    ProbeInput,
    probeSetup,
    SetupStatus,
} from "./setupProbe";

export function currentProbeInput(): ProbeInput {
    return {
        pathSetting: getConfigurationOption("path") as string,
        envPath: process.env.PATH,
        args: getConfigurationOption("args") as string[],
        cwd: workspace.rootPath,
    };
}

function setContext(key: string, value: boolean) {
    commands.executeCommand("setContext", key, value);
}

/** Runs the setup probe and publishes the context keys the walkthrough ticks on. */
export class SetupCheck {
    private inFlight: { key: string; probe: Promise<SetupStatus> } | undefined;
    // The settings each status was probed with, so it is described with
    // those and not with settings changed since.
    private inputs = new WeakMap<SetupStatus, ProbeInput>();
    private latest = 0;
    private _last: SetupStatus | undefined;
    private _compat: Compatibility | undefined;

    get last(): SetupStatus | undefined {
        return this._last;
    }

    get compat(): Compatibility | undefined {
        return this._compat;
    }

    // A call shares the probe already running only if the settings are the
    // same; otherwise it starts a new one, and only the newest probe
    // publishes its result.
    run(): Promise<SetupStatus> {
        const input = currentProbeInput();
        const key = JSON.stringify(input);
        if (this.inFlight?.key === key) {
            return this.inFlight.probe;
        }
        const id = ++this.latest;
        const probe = probeSetup(input).then((status) => {
            this.inputs.set(status, input);
            if (id === this.latest) {
                this.publish(status);
            }
            return status;
        });
        this.inFlight = { key, probe };
        probe
            .finally(() => {
                if (this.inFlight?.probe === probe) {
                    this.inFlight = undefined;
                }
            })
            .catch(() => undefined);
        return probe;
    }

    private publish(status: SetupStatus) {
        this._last = status;
        setContext("vsrocq.setup.serverFound", status.found);
        setContext(
            "vsrocq.setup.serverLaunches",
            status.found && status.launch.status === "ok",
        );
        Client.writeToVsrocqChannel(
            "[Setup check] " + this.describe(status).message,
        );
        if (status.found && status.launch.status !== "ok") {
            Client.writeToVsrocqChannel(status.launch.transcript);
        }
    }

    describe(status: SetupStatus): { ok: boolean; message: string } {
        const input = this.inputs.get(status) ?? currentProbeInput();
        return describeStatus(status, input.pathSetting, input.args);
    }

    recordCompat(compat: Compatibility) {
        this._compat = compat;
        setContext("vsrocq.setup.serverCompatible", compat.ok);
    }
}
