import { expect } from "expect";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { SETUP_GUIDE_STEPS } from "../../utilities/setupProbe";

// Compiled tests run from out/test/unit, three levels below client/.
const clientRoot = path.resolve(__dirname, "../../..");
const manifest = JSON.parse(
    readFileSync(path.join(clientRoot, "package.json"), "utf-8"),
);
const contributed: string[] = manifest.contributes.commands.map(
    (c: { command: string }) => c.command,
);
const builtin = [
    "workbench.action.files.openFile",
    "workbench.action.openSettings",
    "workbench.action.reloadWindow",
];
const contextKeys = [
    "vsrocq.setup.serverFound",
    "vsrocq.setup.serverLaunches",
    "vsrocq.setup.serverCompatible",
];
const walkthrough = manifest.contributes.walkthroughs.find(
    (w: { id: string }) => w.id === "rocq.welcome",
);

function commandLinks(text: string): string[] {
    return [...text.matchAll(/\(command:([\w.]+)/g)].map((m) => m[1]);
}

describe("setup walkthrough manifest", () => {
    it("has the steps openSetupGuide can open, in order", () => {
        expect(walkthrough.steps.map((s: { id: string }) => s.id)).toEqual(
            SETUP_GUIDE_STEPS.map((name) => `rocq.welcome.${name}`),
        );
    });

    for (const step of walkthrough.steps) {
        it(`${step.id} refers only to things that exist`, () => {
            const media = step.media.markdown ?? step.media.image;
            expect(existsSync(path.join(clientRoot, media))).toBe(true);

            const links = commandLinks(step.description);
            if (step.media.markdown) {
                links.push(
                    ...commandLinks(
                        readFileSync(
                            path.join(clientRoot, step.media.markdown),
                            "utf-8",
                        ),
                    ),
                );
            }
            for (const command of links) {
                expect([...contributed, ...builtin]).toContain(command);
            }

            for (const event of step.completionEvents ?? []) {
                const [kind, name] = event.split(/:(.*)/s);
                if (kind === "onCommand") {
                    expect(contributed).toContain(name);
                } else if (kind === "onContext") {
                    expect(contextKeys).toContain(name);
                } else {
                    expect(event).toBe("onStepSelected");
                }
            }
        });
    }
});
