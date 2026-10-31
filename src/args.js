import { UsageError } from "./errors.js";

export const kebab = key => key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`);

function findChild(node, token) {
    return Object.entries(node.commands)
        .find(([name, child]) => name === token || child.aliases?.includes(token));
}

function findOption(flag, specs) {
    return Object.entries(specs)
        .find(([key, spec]) => flag === `--${kebab(key)}` || (spec.alias && flag === `-${spec.alias}`));
}

function convert(flag, spec, raw) {
    if (!spec.number) {
        return raw;
    }

    const value = Number(raw);
    if (Number.isNaN(value)) {
        throw new UsageError(`Option ${flag} expects a number.`);
    }

    return value;
}

export function parseArgs(argv, root, globalOptions) {
    let node = root;
    const path = [];
    const options = {};
    const args = [];

    for (let index = 0; index < argv.length; index++) {
        const token = argv[index];

        if (token === "--") {
            args.push(...argv.slice(index + 1));
            break;
        }

        if (!token.startsWith("-") || token === "-") {
            if (!node.commands) {
                args.push(token);
                continue;
            }

            const child = findChild(node, token);
            if (!child) {
                const scope = path.length ? `aivax ${path.join(" ")}` : "aivax";
                throw new UsageError(`Unknown command "${token}". Run "${scope} --help" to list the available commands.`);
            }

            path.push(child[0]);
            node = child[1];
            continue;
        }

        const separator = token.indexOf("=");
        const flag = separator > 0 ? token.slice(0, separator) : token;
        const found = findOption(flag, { ...globalOptions, ...node.options });

        if (!found) {
            throw new UsageError(`Unknown option ${flag}.`);
        }

        const [key, spec] = found;

        if (!spec.value) {
            options[key] = true;
            continue;
        }

        const raw = separator > 0 ? token.slice(separator + 1) : argv[++index];
        if (raw === undefined) {
            throw new UsageError(`Option ${flag} expects a value.`);
        }

        const value = convert(flag, spec, raw);
        options[key] = spec.list ? [...(options[key] ?? []), value] : value;
    }

    return { node, path, options, args };
}
