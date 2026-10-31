import { call, seg } from "../http.js";
import { dataOption, payload, readSource } from "../input.js";
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
            options: { client, name: { alias: "n", value: "<name>", required: true, description: "Zapi, Telegram, EvolutionApi or Kapso." } },
            async run(ctx) {
                await confirm(ctx, `Remove the ${ctx.options.name} integration?`);
                await call(ctx, "DELETE", `${clientPath(ctx)}/integrations/${seg(ctx.options.name)}`);
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

const talk = {
    aliases: ["send"],
    description: "Send a prompt to a public chat session.",
    options: {
        accessKey,
        prompt: { alias: "p", value: "<text>", description: "Message text. Use @file or - to read it. Also accepted as positional text." },
        instructions: { value: "<text>", description: "Extra context for this inference only." },
        noCommit: { description: "Do not save this turn in the session history." },
        data: dataOption()
    },
    args: "[prompt]",
    async run(ctx) {
        const body = await payload(ctx, {
            prompt: ctx.options.prompt ? await readSource(ctx.options.prompt) : ctx.args.join(" ") || undefined,
            instructions: ctx.options.instructions,
            commit: ctx.options.noCommit ? false : undefined
        });

        await call(ctx, "POST", `${publicPath(ctx)}/prompt`, { body });
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
