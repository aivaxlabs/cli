import { UsageError } from "../errors.js";
import { call } from "../http.js";

const catalogs = {
    chat: "/api/v1/information/models.json",
    image: "/api/v1/information/image-models.json",
    speech: "/api/v1/information/speech-models.json",
    transcription: "/api/v1/information/audio-transcription-models.json",
    reranker: "/api/v1/information/rerankers-models.json",
    decisions: "/api/v1/information/decisions-models.json",
    embedding: "/api/v1/information/collection-embedding-model.json"
};

export default {
    description: "Model catalog commands.",
    commands: {
        list: {
            aliases: ["ls"],
            description: "List the OpenAI-compatible models and AI gateways available to the account.",
            options: { filter: { alias: "q", value: "<name>", description: "Exact model name or dated snapshot." } },
            run: ctx => call(ctx, "GET", "/v1/models", { query: { filter: ctx.options.filter } })
        },
        catalog: {
            description: `Show a detailed catalog with pricing: ${Object.keys(catalogs).join(", ")}.`,
            args: "<type>",
            minArgs: 1,
            options: { name: { alias: "q", value: "<name>", description: "Exact model name or dated snapshot. Only for the chat catalog." } },
            run(ctx) {
                const path = catalogs[ctx.args[0]];

                if (!path) {
                    throw new UsageError(`Unknown catalog "${ctx.args[0]}". Use one of: ${Object.keys(catalogs).join(", ")}.`);
                }

                if (ctx.options.name !== undefined && ctx.args[0] !== "chat") {
                    throw new UsageError("--name is only supported by the chat catalog.");
                }

                return call(ctx, "GET", path, { query: { name: ctx.options.name } });
            }
        }
    }
};
