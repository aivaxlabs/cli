#!/usr/bin/env node
import { kebab, parseArgs } from "./args.js";
import { ApiError, UsageError } from "./errors.js";
import { VERSION } from "./http.js";
import account from "./commands/account.js";
import analytics from "./commands/analytics.js";
import api from "./commands/api.js";
import auth from "./commands/auth.js";
import batch from "./commands/batch.js";
import chatClients from "./commands/chat-clients.js";
import conversations from "./commands/conversations.js";
import docs from "./commands/docs.js";
import gateways from "./commands/gateways.js";
import generate from "./commands/generate.js";
import logs from "./commands/logs.js";
import models from "./commands/models.js";
import ocr from "./commands/ocr.js";
import rag from "./commands/rag.js";
import shell from "./commands/shell.js";
import skills from "./commands/skills.js";
import tests from "./commands/tests.js";
import web from "./commands/web.js";

const root = {
    commands: {
        auth,
        docs,
        gateways,
        rag,
        "chat-clients": chatClients,
        models,
        batch,
        tests,
        web,
        ocr,
        analytics,
        conversations,
        skills,
        logs,
        account,
        generate,
        shell,
        api
    }
};

const globalOptions = {
    profile: { value: "<profile>", description: "Choose which profile to use for the operation." },
    verbose: { description: "Return the complete JSON response instead of the agent-optimized output." },
    raw: { hidden: true },
    json: { hidden: true },
    yes: { alias: "y", description: "Skip confirmation prompts of destructive commands." },
    help: { alias: "h", description: "Show help." }
};

const HEADER = `AIVAX CLI v${VERSION}\n(c) Project Principium. MIT License.\n`;

const column = (label, text) => label.length < 20 ? `${label.padEnd(20)}${text}` : `${label}\n${" ".repeat(20)}${text}`;

const flagLabel = (key, spec) => [spec.alias && `-${spec.alias},`, `--${kebab(key)}`, spec.value]
    .filter(Boolean)
    .join(" ");

function help(node, path) {
    const name = ["AIVAX", ...path].join(" ");
    const lines = [HEADER];

    if (node.commands) {
        const isRoot = path.length === 0;
        lines.push(`Usage: ${name} ${isRoot ? "<verb>" : "<command>"} [...args]`, "", isRoot ? "Available verbs:" : "Available commands:");
        lines.push(...Object.entries(node.commands).map(([command, child]) => column(command, child.description)));
    }
    else {
        lines.push(`Usage: ${name}${node.options ? " [options]" : ""}${node.args ? ` ${node.args}` : ""}`, "", node.description);

        if (node.options) {
            lines.push("", "Options:");
            lines.push(...Object.entries(node.options)
                .map(([key, spec]) => column(flagLabel(key, spec), `${spec.description}${spec.required ? " (required)" : ""}`)));
        }
    }

    lines.push("", "Global flags:", ...Object.entries(globalOptions)
        .filter(([, spec]) => !spec.hidden)
        .map(([key, spec]) => column(flagLabel(key, spec), spec.description)));

    process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(argv) {
    const { node, path, options, args } = parseArgs(argv, root, globalOptions);

    if (["raw", "json"].some(key => options[key] && !node.options?.[key])) {
        options.verbose = true;
    }

    if (options.help || !node.run) {
        help(node, path);
        return;
    }

    const missing = Object.entries(node.options ?? {})
        .filter(([key, spec]) => spec.required && options[key] === undefined)
        .map(([key]) => `--${kebab(key)}`);

    if (missing.length) {
        throw new UsageError(`Missing required option${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Run "aivax ${path.join(" ")} --help".`);
    }

    if (args.length < (node.minArgs ?? 0)) {
        throw new UsageError(`Usage: aivax ${path.join(" ")} ${node.args}`);
    }

    await node.run({ options, args, path });
}

try {
    await main(process.argv.slice(2));
}
catch (error) {
    const prefix = error instanceof ApiError ? `error (HTTP ${error.status})` : "error";
    process.stderr.write(`${prefix}: ${error.message}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
}
