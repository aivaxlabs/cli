import { UsageError } from "../errors.js";
import { events, print, request } from "../http.js";
import { contentPart, readJson, readSource } from "../input.js";
import { crud } from "./crud.js";

const chat = {
    aliases: ["complete"],
    description: "Send a chat completion to a gateway or integrated model.",
    options: {
        model: { alias: "m", value: "<model>", required: true, description: "AI gateway ID, slug or integrated model name." },
        prompt: { alias: "p", value: "<text>", description: "User message. Use @file or - to read it. Also accepted as positional text." },
        system: { alias: "s", value: "<text>", description: "Optional system message." },
        messages: { value: "<json>", description: "OpenAI-compatible messages array (JSON, @file or -). Replaces --prompt." },
        file: { alias: "f", value: "<file>", list: true, description: "Image, audio, video or document attached to the user message. Repeatable." },
        stream: { description: "Stream the answer as it is generated." },
        json: { description: "Print the full OpenAI-compatible response instead of only the answer text." },
        reasoningEffort: { value: "<level>", description: "Optional reasoning effort." },
        temperature: { value: "<n>", number: true, description: "Optional sampling temperature." },
        maxTokens: { value: "<n>", number: true, description: "Optional maximum completion tokens." },
        user: { value: "<id>", description: "Optional external user identifier." }
    },
    args: "[prompt]",
    async run(ctx) {
        const { options } = ctx;
        let messages = options.messages && await readJson(options.messages, "--messages");

        if (!messages) {
            const text = options.prompt ? await readSource(options.prompt) : ctx.args.join(" ");
            const parts = await Promise.all((options.file ?? []).map(contentPart));

            if (!text && !parts.length) {
                throw new UsageError("Provide a prompt with -p, --messages or positional text.");
            }

            messages = [
                ...(options.system ? [{ role: "system", content: options.system }] : []),
                { role: "user", content: parts.length ? [...(text ? [{ type: "text", text }] : []), ...parts] : text }
            ];
        }

        const body = {
            model: options.model,
            messages,
            stream: Boolean(options.stream),
            reasoning_effort: options.reasoningEffort,
            temperature: options.temperature,
            max_completion_tokens: options.maxTokens,
            user: options.user
        };

        const response = await request(ctx, "POST", "/v1/chat/completions", { body, agentOutput: false });

        if (!options.stream) {
            const result = await response.json();
            print(options.json ? result : result.choices?.[0]?.message?.content ?? "");
            return;
        }

        for await (const data of events(response)) {
            if (data === "[DONE]") break;

            const chunk = JSON.parse(data);
            if (chunk.error) {
                throw new UsageError(chunk.error.message ?? JSON.stringify(chunk.error));
            }

            if (options.json) {
                print(chunk);
                continue;
            }

            process.stdout.write(chunk.choices?.[0]?.delta?.content ?? "");
        }

        if (!options.json) process.stdout.write("\n");
    }
};

export default {
    description: "AI-Gateways-specific commands.",
    commands: {
        ...crud({ base: "/api/v1/ai-gateways", noun: "AI gateway" }),
        chat
    }
};
