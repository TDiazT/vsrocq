import which from "which";

/**
 * Resolves the value of `vsrocq.path` to a runnable file, or null.
 *
 * The setting is a free string, so it can be an absolute path or a bare
 * command name; `which` tests the file directly when the value has a path
 * separator and searches PATH otherwise, which covers both. Without this
 * check, a setting that points at nothing reaches `vsrocqtop -where` and is
 * reported as a crash of a binary that does not exist.
 */
export async function resolveServerBinary(
    configured: string,
    pathEnv: string | undefined = process.env.PATH,
): Promise<string | null> {
    return (await which(configured, { nothrow: true, path: pathEnv })) ?? null;
}

/** What to tell the user when `vsrocq.path` resolves to nothing. */
export function missingConfiguredServerMessage(configured: string): string {
    const where = configured.includes("/")
        ? "there is no executable there"
        : "it is not on this window's PATH";
    return (
        `vsrocq.path is set to ${configured}, but ${where}. ` +
        "Fix or clear the setting, or install the language server (requires Rocq 8.18 or higher)."
    );
}
