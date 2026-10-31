import { UsageError } from "./errors.js";

export function ask(question, { hidden = false } = {}) {
    if (!process.stdin.isTTY) {
        throw new UsageError(`"${question.trim()}" requires an interactive terminal. Provide the value through its flag.`);
    }

    process.stderr.write(question);

    return new Promise(resolve => {
        const stdin = process.stdin;
        let value = "";

        const finish = () => {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.off("data", onData);
            process.stderr.write("\n");
        };

        const onData = chunk => {
            for (const char of chunk) {
                if (char === "\r" || char === "\n") {
                    finish();
                    resolve(value.trim());
                    return;
                }

                if (char === "\u0003") {
                    finish();
                    process.exit(130);
                }

                if (char === "\u007f" || char === "\b") {
                    if (value) {
                        value = value.slice(0, -1);
                        if (!hidden) process.stderr.write("\b \b");
                    }
                    continue;
                }

                value += char;
                if (!hidden) process.stderr.write(char);
            }
        };

        stdin.setRawMode(true);
        stdin.setEncoding("utf8");
        stdin.on("data", onData);
        stdin.resume();
    });
}

export async function confirm(ctx, message) {
    if (ctx.options.yes) {
        return;
    }

    if (!process.stdin.isTTY) {
        throw new UsageError(`${message} Pass --yes to confirm in non-interactive sessions.`);
    }

    const answer = await ask(`${message} [y/N] `);
    if (!/^y(es)?$/i.test(answer)) {
        throw new UsageError("Operation cancelled.");
    }
}
