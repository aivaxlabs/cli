import { UsageError } from "../errors.js";
import { call, seg } from "../http.js";
import { confirm } from "../prompt.js";

const base = "/api/v1/async-generations";

const id = { value: "<id>", required: true, description: "Async generation identifier." };

const item = ctx => `${base}/${seg(ctx.options.id)}`;

export default {
    aliases: ["async"],
    description: "Generations queued with \"async\": true in the request body: list, inspect, fetch the response, cancel and delete.",
    commands: {
        list: {
            aliases: ["ls"],
            description: "List async generations in reverse creation order, without request and response bodies.",
            options: {
                status: { alias: "s", value: "<status>", description: "pending, retrying, processing, done or cancelled." },
                tags: { alias: "t", value: "<tags>", description: "Comma-separated tags. Only generations with every tag are returned." },
                limit: { alias: "n", value: "<n>", number: true, description: "Maximum generations, from 1 to 100 (default 50)." },
                offset: { value: "<n>", number: true, description: "Generations to skip (default 0)." }
            },
            run: ctx => call(ctx, "GET", base, {
                query: {
                    status: ctx.options.status,
                    tags: ctx.options.tags,
                    limit: ctx.options.limit,
                    offset: ctx.options.offset
                }
            })
        },
        get: {
            aliases: ["view"],
            description: "Show one generation with its webhooks, timeout, original request and stored response (JSON, or base64 for other content types).",
            options: { id },
            run: ctx => call(ctx, "GET", item(ctx))
        },
        response: {
            aliases: ["result"],
            description: "Print the stored response exactly as the original endpoint returned it. Binary responses, such as audio, require -o. Stored error responses are reported as errors with their original HTTP status.",
            options: { id, output: { alias: "o", value: "<file>", description: "Write the response to a file." } },
            run: ctx => call(ctx, "GET", `${item(ctx)}/response`, { agentOutput: false })
        },
        cancel: {
            description: "Cancel one pending, retrying or failed generation with --id, or every generation of a --scope. Cancelled generations are deleted after one hour.",
            options: {
                id: { ...id, required: false },
                scope: { value: "<scope>", description: "Bulk cancellation: pending, failed or all." }
            },
            async run(ctx) {
                const { id, scope } = ctx.options;

                if (!id && !scope) {
                    throw new UsageError("Provide --id <generation> or --scope <pending|failed|all>.");
                }

                await confirm(ctx, id ? `Cancel async generation ${id}?` : `Cancel ${scope} async generations?`);
                await call(ctx, "PUT", id ? `${item(ctx)}/cancel` : `${base}/cancel`, { query: id ? undefined : { scope } });
            }
        },
        delete: {
            aliases: ["rm"],
            description: "Delete a generation and its stored response. Generations being executed cannot be deleted.",
            options: { id },
            async run(ctx) {
                await confirm(ctx, `Delete async generation ${ctx.options.id}?`);
                await call(ctx, "DELETE", item(ctx));
            }
        }
    }
};
