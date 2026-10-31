import { call, fetchData, print } from "../http.js";

export default {
    description: "Account and gateway log commands.",
    commands: {
        account: {
            description: "Show the latest account log entries (errors, warnings and notices).",
            options: { level: { alias: "l", value: "<level>", description: "Only show Information, Warning or Error entries." } },
            async run(ctx) {
                const level = ctx.options.level?.toLowerCase();
                const entries = (await fetchData(ctx, "GET", "/api/v1/information/logs.json"))
                    .filter(entry => !level || String(entry.level).toLowerCase().startsWith(level));

                print(ctx.options.verbose
                    ? entries
                    : entries.map(entry => `${entry.createdAt}\t${entry.level}\t${entry.message}`).join("\n") || "No log entries.");
            }
        },
        gateway: {
            description: "Show the conversation logs of an AI gateway.",
            options: {
                gateway: { alias: "g", value: "<id>", required: true, description: "AI gateway identifier." },
                minutes: { value: "<n>", number: true, description: "Lookback window in minutes (default 120)." },
                from: { value: "<date>", description: "ISO 8601 start date." },
                to: { value: "<date>", description: "ISO 8601 end date." }
            },
            run: ctx => call(ctx, "GET", "/api/v1/conversations", {
                query: {
                    offsetminutes: ctx.options.minutes,
                    timeStart: ctx.options.from,
                    timeEnd: ctx.options.to,
                    filter: `--gateway ${ctx.options.gateway}`
                }
            })
        },
        batch: {
            description: "Show batch and media-processing job logs.",
            run: ctx => call(ctx, "GET", "/api/v1/compound/logs.json")
        }
    }
};
