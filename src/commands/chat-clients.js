import { UsageError } from "../errors.js";
import { call, events, print, request, seg } from "../http.js";
import { dataOption, payload, readContent, readJson, readSource } from "../input.js";
import { confirm } from "../prompt.js";
import { crud, filterOption } from "./crud.js";

const client = { alias: "c", value: "<id>", required: true, description: "Chat client identifier." };

const clientPath = ctx => `/api/v1/web-chat-client/${seg(ctx.options.client)}`;

const schedulesPath = ctx => `/api/v1/web-chat-clients/${seg(ctx.options.client)}/hook-schedules`;

const accessKey = { alias: "k", value: "<key>", required: true, description: "Session access key." };

const publicPath = ctx => `/api/v1/public/chat-clients/${seg(ctx.options.accessKey)}`;

const sessions = {
    description: "Chat client session commands.",
    commands: {
        list: {
            aliases: ["ls"],
            description: "List the sessions of a chat client.",
            options: { client, filter: filterOption },
            run: ctx => call(ctx, "GET", `${clientPath(ctx)}/sessions`, { query: { filter: ctx.options.filter } })
        },
        create: {
            description: "Create a session and return its access key.",
            options: {
                client,
                context: { value: "<text>", description: "Extra context for the session. Use @file or - to read it." },
                tag: { value: "<tag>", description: "Optional session tag (external user id)." },
                expires: { value: "<seconds>", number: true, description: "Session lifetime in seconds." },
                data: dataOption()
            },
            async run(ctx) {
                const body = await payload(ctx, {
                    extraContext: ctx.options.context && await readSource(ctx.options.context),
                    tag: ctx.options.tag,
                    expires: ctx.options.expires
                });

                await call(ctx, "POST", `${clientPath(ctx)}/sessions`, { body });
            }
        },
        insert: {
            description: "Append messages to a session history without running inference. Fails with 409 while an inference is in progress.",
            options: {
                client,
                session: { alias: "s", value: "<id>", description: "Session identifier. Use this or --tag." },
                tag: { alias: "t", value: "<tag>", description: "Session tag (external user id). Use this or --session." },
                messages: {
                    alias: "m",
                    value: "<json|text>",
                    description: "Plain text (inserted as a user message), an OpenAI-compatible message or an ordered array of user, assistant or tool messages. Use @file or - to read it."
                },
                data: dataOption()
            },
            async run(ctx) {
                const body = await payload(ctx, {
                    sessionId: ctx.options.session,
                    tag: ctx.options.tag,
                    messages: ctx.options.messages && await readContent(ctx.options.messages, "--messages")
                });

                if ((body.sessionId === undefined) === (body.tag === undefined)) {
                    throw new UsageError("Provide exactly one of --session or --tag.");
                }

                if (body.messages === undefined) {
                    throw new UsageError("Provide the messages to insert with --messages.");
                }

                await call(ctx, "POST", `${clientPath(ctx)}/sessions/insert-message`, { body });
            }
        },
        delete: {
            aliases: ["rm"],
            description: "Delete a session.",
            options: { client, id: { value: "<id>", required: true, description: "Session identifier." } },
            async run(ctx) {
                await confirm(ctx, `Delete session ${ctx.options.id}?`);
                await call(ctx, "DELETE", `${clientPath(ctx)}/sessions/${seg(ctx.options.id)}`);
            }
        }
    }
};

const integrationName = { alias: "n", value: "<name>", required: true, description: "Zapi, Telegram, EvolutionApi or Kapso." };

const integrations = {
    description: "Messaging integration commands (Zapi, Telegram, EvolutionApi, Kapso).",
    commands: {
        set: {
            description: "Create or replace an integration.",
            options: { client, data: dataOption(true) },
            run: async ctx => call(ctx, "PUT", `${clientPath(ctx)}/integrations`, { body: await payload(ctx) })
        },
        delete: {
            aliases: ["rm"],
            description: "Remove an integration.",
            options: { client, name: integrationName },
            async run(ctx) {
                await confirm(ctx, `Remove the ${ctx.options.name} integration?`);
                await call(ctx, "DELETE", `${clientPath(ctx)}/integrations/${seg(ctx.options.name)}`);
            }
        },
        "rotate-key": {
            description: "Generate a new webhook hook key. The current webhook URL stops working immediately: update the URL in the provider and, for Telegram, update the bot hooks.",
            options: { client, name: integrationName },
            async run(ctx) {
                await confirm(ctx, `Rotate the ${ctx.options.name} hook key? The current webhook URL stops working immediately.`);
                await call(ctx, "POST", `${clientPath(ctx)}/integrations/${seg(ctx.options.name)}/hook-key`);
            }
        }
    }
};

const scheduleKind = { alias: "t", value: "<type>", required: true, description: "schedule (one-time) or recurring." };

const scheduleItem = ctx => `${schedulesPath(ctx)}/${ctx.options.type === "recurring" ? "recurring" : "schedules"}/${seg(ctx.options.id)}`;

const scheduleId = { value: "<id>", required: true, description: "Schedule or recurring task identifier." };

const schedules = {
    description: "Scheduled hook activation commands.",
    commands: {
        list: {
            aliases: ["ls"],
            description: "List one-time schedules and recurring tasks.",
            options: { client, user: { alias: "u", value: "<id>", description: "Restrict to one external user id." } },
            run: ctx => call(ctx, "GET", schedulesPath(ctx), { query: { "external-user-id": ctx.options.user } })
        },
        get: {
            description: "Show one schedule or recurring task.",
            options: { client, type: scheduleKind, id: scheduleId },
            run: ctx => call(ctx, "GET", scheduleItem(ctx))
        },
        cancel: {
            description: "Cancel a schedule or recurring task.",
            options: { client, type: scheduleKind, id: scheduleId },
            async run(ctx) {
                await confirm(ctx, `Cancel ${ctx.options.type} ${ctx.options.id}?`);
                await call(ctx, "DELETE", scheduleItem(ctx));
            }
        }
    }
};

const renderingModes = ["default", "textual_blocks"];

const talk = {
    aliases: ["send"],
    description: "Send a prompt to a public chat session.",
    options: {
        accessKey,
        prompt: { alias: "p", value: "<text>", description: "Message text. Use @file or - to read it. Also accepted as positional text." },
        instructions: { value: "<text>", description: "Extra system instructions for this inference only." },
        context: {
            value: "<json|text>",
            description: "Disposable information for this inference only, prepended to the last user message and never saved in the history, not even with commit. Plain text, an OpenAI-compatible content part or an array of them (@file or -). Unlike --instructions, it does not change the system instructions and is meant for information, not instructions."
        },
        noCommit: { description: "Do not save this turn in the session history." },
        stream: { description: "Stream the reply: text is printed as it is generated and tool activity goes to stderr. --verbose prints every event." },
        tools: { value: "<json>", description: "OpenAI-compatible function tools for this inference only (JSON array, @file or -). Their calls are returned for your application to execute." },
        reasoningEffort: { value: "<level>", description: "Reasoning effort for this inference, such as none, low, medium or high." },
        renderingMode: { value: "<mode>", description: `${renderingModes.join(" or ")}. textual_blocks places reasoning and tool activity as text blocks in the reply.` },
        toolExplanations: { description: "Ask the model to explain why it calls each server-side tool." },
        data: dataOption()
    },
    args: "[prompt]",
    async run(ctx) {
        const { options } = ctx;

        if (options.renderingMode !== undefined && !renderingModes.includes(options.renderingMode)) {
            throw new UsageError(`--rendering-mode must be one of: ${renderingModes.join(", ")}.`);
        }

        const tools = options.tools && await readJson(options.tools, "--tools");

        if (tools !== undefined && !(Array.isArray(tools) && tools.every(tool => typeof tool?.function?.name === "string"))) {
            throw new UsageError("--tools must be a JSON array of OpenAI-compatible function tools, each with function.name.");
        }

        const body = await payload(ctx, {
            prompt: options.prompt ? await readSource(options.prompt) : ctx.args.join(" ") || undefined,
            instructions: options.instructions,
            context: options.context && await readContent(options.context, "--context"),
            commit: options.noCommit ? false : undefined,
            stream: options.stream || undefined,
            tools
        });

        const inferenceOptions = Object.entries({
            reasoningEffort: options.reasoningEffort,
            renderingMode: options.renderingMode,
            toolInvocationExplanations: options.toolExplanations
        }).filter(([, value]) => value !== undefined);

        if (inferenceOptions.length) {
            body.inferenceOptions = { ...body.inferenceOptions, ...Object.fromEntries(inferenceOptions) };
        }

        if (body.stream !== true) {
            await call(ctx, "POST", `${publicPath(ctx)}/prompt`, { body });
            return;
        }

        const response = await request(ctx, "POST", `${publicPath(ctx)}/prompt`, { body, agentOutput: false });
        let result;
        let written = false;

        for await (const data of events(response)) {
            const { type, data: event = {} } = JSON.parse(data);

            if (options.verbose) {
                print(data);
            }

            if (type === "error") {
                if (written) process.stdout.write("\n");
                throw new Error(event.message ?? "The prompt stream failed.");
            }

            if (type === "result") {
                result = event;
            }

            if (options.verbose) continue;

            if (type === "text" && event.content) {
                process.stdout.write(`${event.replace && written ? "\n" : ""}${event.content}`);
                written = true;
            }

            if (type === "tool") {
                process.stderr.write(`› ${event.toolName} (${event.update})\n`);
            }
        }

        if (!result) {
            throw new Error("The prompt stream ended without a result.");
        }

        if (options.verbose) return;

        if (written) process.stdout.write("\n");

        if (result.toolCalls?.length) {
            print({ toolCalls: result.toolCalls });
        }
    }
};

const session = {
    description: "Show a public session, its transcript, or retry its last message.",
    options: {
        accessKey,
        transcript: { description: "Download the session transcript." },
        retry: { description: "Retry the last message of the session." },
        output: { alias: "o", value: "<file>", description: "Write the transcript to a file." }
    },
    run(ctx) {
        if (ctx.options.retry) return call(ctx, "POST", `${publicPath(ctx)}/retry`);
        if (ctx.options.transcript) return call(ctx, "GET", `${publicPath(ctx)}/transcript.json`, { agentOutput: false });
        return call(ctx, "GET", publicPath(ctx));
    }
};

const { list, ...rest } = crud({ base: "/api/v1/web-chat-client", noun: "chat client", updateMethod: "PUT" });

export default {
    description: "Commands for Chat Clients.",
    commands: {
        list: { ...list, options: {} },
        ...rest,
        sessions,
        integrations,
        schedules,
        talk,
        session
    }
};
