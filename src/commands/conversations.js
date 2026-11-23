import { call, output, request, seg } from "../http.js";
import { confirm } from "../prompt.js";

const id = { value: "<id>", required: true, description: "Conversation identifier." };

const exportOptions = {
    media: { value: "<mode>", description: "text (default) or include." },
    thinking: { value: "<mode>", description: "visible (default), all or none." },
    truncate: { value: "<tokens>", number: true, description: "Maximum tokens per conversation. 0 disables truncation." },
    output: { alias: "o", value: "<file>", description: "Write the export to a file." }
};

const exportQuery = ctx => ({
    period: ctx.options.period,
    media: ctx.options.media,
    thinking: ctx.options.thinking,
    truncate: ctx.options.truncate
});

const filters = {
    id: "--id",
    token: "--token",
    requestId: "--rid",
    model: "--model",
    user: "--user",
    apiKey: "--api-key",
    gateway: "--gateway",
    chatClient: "--chat-client",
    chatSession: "--chat-session"
};

export default {
    description: "Conversation and observability commands.",
    commands: {
        list: {
            aliases: ["ls"],
            description: "List the most recent conversations of a period, up to 300 without filters or 1,000 with them. Filters apply to the whole period before the limit.",
            options: {
                minutes: { value: "<n>", number: true, description: "Lookback window in minutes (default 120)." },
                from: { value: "<date>", description: "ISO 8601 start date." },
                to: { value: "<date>", description: "ISO 8601 end date." },
                search: { alias: "s", value: "<text>", description: "Free text matched against messages, model, provider, user, conversation ID, token and request ID." },
                id: { alias: "i", value: "<id>", description: "Filter by conversation ID (partial match)." },
                token: { alias: "t", value: "<token>", description: "Filter by conversation token (partial match)." },
                requestId: { alias: "r", value: "<id>", description: "Filter by request ID (partial match)." },
                model: { alias: "m", value: "<model>", description: "Filter by model." },
                user: { alias: "u", value: "<id>", description: "Filter by external user." },
                apiKey: { value: "<id>", description: "Filter by API key." },
                gateway: { alias: "g", value: "<id>", description: "Filter by AI gateway." },
                chatClient: { value: "<id>", description: "Filter by chat client." },
                chatSession: { value: "<id>", description: "Filter by chat session." },
                filter: { value: "<expr>", description: "Raw filter expression, e.g. \"--gateway <id> -u joe refund\"." }
            },
            async run(ctx) {
                const expression = [
                    ...Object.entries(filters)
                        .filter(([key]) => ctx.options[key])
                        .map(([key, flag]) => `${flag} ${JSON.stringify(ctx.options[key])}`),
                    ctx.options.filter,
                    ctx.options.search && JSON.stringify(ctx.options.search)
                ].filter(Boolean).join(" ");

                const response = await request(ctx, "GET", "/api/v1/conversations", {
                    query: {
                        offsetminutes: ctx.options.minutes,
                        timeStart: ctx.options.from,
                        timeEnd: ctx.options.to,
                        filter: expression
                    }
                });
                const limit = response.headers.get("x-results-truncated");

                await output(ctx, response);

                if (limit) {
                    process.stderr.write(`Showing the ${limit} most recent conversations. Narrow --from/--to or add filters to see older ones.\n`);
                }
            }
        },
        get: {
            aliases: ["view"],
            description: "Show one conversation.",
            options: { id },
            run: ctx => call(ctx, "GET", `/api/v1/conversations/${seg(ctx.options.id)}`)
        },
        export: {
            description: "Export one conversation as JSON, or every conversation of a period as JSONL when --id is omitted.",
            options: {
                id: { ...id, required: false },
                period: { value: "<period>", description: "2h, 1d, 7d (default) or 30d." },
                ...exportOptions
            },
            run: ctx => call(ctx, "GET", ctx.options.id
                ? `/api/v1/conversations/${seg(ctx.options.id)}/export.json`
                : "/api/v1/conversations/management/export.jsonl", { query: exportQuery(ctx), agentOutput: false })
        },
        delete: {
            aliases: ["rm"],
            description: "Delete a conversation.",
            options: { id },
            async run(ctx) {
                await confirm(ctx, `Delete conversation ${ctx.options.id}?`);
                await call(ctx, "DELETE", `/api/v1/conversations/${seg(ctx.options.id)}`);
            }
        }
    }
};
