import { UsageError } from "../errors.js";
import { call } from "../http.js";
import { dataUrl, isUrl, payload, readJson } from "../input.js";

export const schemaOption = { value: "<json>", description: "JSON Schema used to convert each result into JSON (JSON, @file or -)." };

export const fetchSources = async sources => Promise.all(sources.map(source => isUrl(source) || source.startsWith("data:") ? source : dataUrl(source)));

const search = {
    description: "Search the web.",
    options: {
        query: { alias: "q", value: "<text>", description: "Search query. Also accepted as positional text." },
        top: { alias: "k", value: "<n>", number: true, description: "Result count from 1 to 25." },
        country: { value: "<code>", description: "Two-letter ISO 3166-1 country code." },
        language: { value: "<code>", description: "Language code." },
        domain: { value: "<domain>", list: true, description: "Restrict results to a domain. Repeatable." }
    },
    args: "[query]",
    async run(ctx) {
        const query = ctx.options.query ?? ctx.args.join(" ");

        if (!query) {
            throw new UsageError("Provide a search query with -q or positional text.");
        }

        const body = await payload(ctx, {
            query,
            topn: ctx.options.top,
            country: ctx.options.country,
            language: ctx.options.language,
            includeDomains: ctx.options.domain
        });

        await call(ctx, "POST", "/api/v1/web/search", { body });
    }
};

const fetchCommand = {
    aliases: ["read"],
    description: "Extract readable text from URLs or local files.",
    options: {
        url: { alias: "u", value: "<url>", list: true, description: "URL to read. Repeatable. Also accepted as positional arguments." },
        file: { alias: "f", value: "<file>", list: true, description: "Local file sent inline. Repeatable." },
        schema: schemaOption,
        noErrors: { description: "Omit failed items from the response." }
    },
    args: "[url...]",
    async run(ctx) {
        const sources = [...ctx.args, ...(ctx.options.url ?? []), ...(ctx.options.file ?? [])];

        if (!sources.length) {
            throw new UsageError("Provide at least one URL or file.");
        }

        const body = {
            contents: await fetchSources(sources),
            returnErrors: ctx.options.noErrors ? false : undefined,
            responseSchema: ctx.options.schema && await readJson(ctx.options.schema, "--schema")
        };

        await call(ctx, "POST", "/api/v1/web/fetch", { body });
    }
};

export default {
    description: "Web search and access commands.",
    commands: { search, fetch: fetchCommand }
};
