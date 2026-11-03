import { writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { UsageError } from "../errors.js";
import { call, fetchData, print } from "../http.js";
import { base64, dataOption, documentParts, fileOption, payload, readJson, readSource, textDocuments, textOption } from "../input.js";

const documentsOptions = {
    file: fileOption("Document file or URL (text, image, PDF...). Repeatable."),
    text: textOption
};

const image = {
    description: "Generate images. Prints the image URLs and the cost or error of each image.",
    options: {
        model: { alias: "m", value: "<model>", required: true, description: "Image model. See \"aivax models catalog image\"." },
        prompt: { alias: "p", value: "<text>", list: true, description: "Prompt. Repeatable. Also accepted as positional text." },
        count: { alias: "n", value: "<n>", number: true, description: "Images per prompt, from 1 to 4." },
        reference: { value: "<url>", list: true, description: "HTTP(S) reference image URL. Repeatable." },
        size: { value: "<WxH>", description: "Output size, such as 1024x1024. Each side from 64 to 4096 pixels." },
        format: { value: "<format>", description: "Output format: png, jpeg or webp. Defaults to the model output." },
        quality: { value: "<n>", number: true, description: "Encoding quality from 1 to 100 for jpeg and webp." }
    },
    args: "[prompt]",
    async run(ctx) {
        const input = ctx.options.prompt ?? (ctx.args.length ? [ctx.args.join(" ")] : []);

        if (!input.length) {
            throw new UsageError("Provide a prompt with -p or positional text.");
        }

        const body = {
            model: ctx.options.model,
            input,
            count: ctx.options.count,
            referenceImages: ctx.options.reference,
            size: ctx.options.size,
            format: ctx.options.format,
            quality: ctx.options.quality
        };
        await call(ctx, "POST", "/api/v1/generations/images", { body });
    }
};

const speech = {
    aliases: ["tts"],
    description: "Synthesize speech into an audio file.",
    options: {
        model: { alias: "m", value: "<model>", required: true, description: "Speech model. See \"aivax models catalog speech\"." },
        text: { alias: "t", value: "<text>", description: "Text to speak. Use @file or - to read it. Also accepted as positional text." },
        voice: { value: "<voice>", description: "Voice name." },
        format: { value: "<format>", description: "mp3, wav or ogg. Defaults to the output file extension or mp3." },
        output: { alias: "o", value: "<file>", required: true, description: "Audio output file." }
    },
    args: "[text]",
    async run(ctx) {
        const input = ctx.options.text ? await readSource(ctx.options.text) : ctx.args.join(" ");

        if (!input) {
            throw new UsageError("Provide the text with -t or positional text.");
        }

        const format = ctx.options.format ?? (extname(ctx.options.output).slice(1).toLowerCase() || "mp3");
        const result = await fetchData(ctx, "POST", "/api/v1/generations/speech", {
            body: { model: ctx.options.model, input, voice: ctx.options.voice, format, raw: false }
        });

        const audio = Buffer.from(result.data, "base64");
        await writeFile(ctx.options.output, audio);
        process.stderr.write(`Saved ${audio.length.toLocaleString("en-US")} bytes to ${ctx.options.output}\n`);
    }
};

const transcribe = {
    aliases: ["stt"],
    description: "Transcribe an audio file. Prints the text.",
    options: {
        file: { alias: "f", value: "<file>", required: true, description: "Audio file: wav, mp3, m4a, flac, ogg, webm or aac." },
        model: { alias: "m", value: "<model>", description: "Speech-to-text model." },
        language: { alias: "l", value: "<code>", description: "Language hint." },
        json: { description: "Print the full API result." }
    },
    async run(ctx) {
        const result = await fetchData(ctx, "POST", "/api/v1/generations/audio/transcriptions", {
            body: {
                model: ctx.options.model,
                language: ctx.options.language,
                input_audio: { data: await base64(ctx.options.file), format: extname(ctx.options.file).slice(1).toLowerCase() }
            }
        });

        print(ctx.options.json ? result : result.text);
    }
};

const describe = {
    description: "Describe media (images, audio, video, documents) as text.",
    options: {
        ...documentsOptions,
        preset: { value: "<preset>", description: "auto (default) or high." },
        guidance: { alias: "g", value: "<text>", description: "Extraction guidance." }
    },
    async run(ctx) {
        const body = { input: await documentParts(ctx), preset: ctx.options.preset, extractionGuidance: ctx.options.guidance };
        await call(ctx, "POST", "/api/v1/generations/descriptions", { body });
    }
};

const summarize = {
    description: "Summarize documents.",
    options: { ...documentsOptions, instructions: { alias: "i", value: "<text>", description: "Format, language, focus or length guidance." } },
    async run(ctx) {
        await call(ctx, "POST", "/api/v1/generations/summarize", { body: { documents: await documentParts(ctx), instructions: ctx.options.instructions } });
    }
};

const translate = {
    description: "Translate documents.",
    options: {
        ...documentsOptions,
        to: { value: "<language>", required: true, description: "Target language, e.g. pt-BR." },
        from: { value: "<language>", description: "Source language. Detected when omitted." }
    },
    async run(ctx) {
        const body = { documents: await documentParts(ctx), toLanguage: ctx.options.to, fromLanguage: ctx.options.from };
        await call(ctx, "POST", "/api/v1/generations/translate", { body });
    }
};

const extract = {
    description: "Extract structured data from documents with a JSON schema.",
    options: {
        ...documentsOptions,
        schema: { alias: "s", value: "<json>", required: true, description: "Object JSON schema (JSON, @file or -)." },
        instructions: { alias: "i", value: "<text>", description: "Extraction guidance." }
    },
    async run(ctx) {
        const body = {
            documents: await documentParts(ctx),
            responseSchema: await readJson(ctx.options.schema, "--schema"),
            instructions: ctx.options.instructions
        };

        await call(ctx, "POST", "/api/v1/generations/extract", { body });
    }
};

const textDocumentOptions = {
    file: fileOption("Text file. Each file is one document. Repeatable."),
    document: { alias: "t", value: "<text>", list: true, description: "Inline document. Repeatable." }
};

const classify = {
    description: "Score documents against labels.",
    options: { ...textDocumentOptions, label: { alias: "l", value: "<label>", list: true, required: true, description: "Label. Repeatable." } },
    run: async ctx => call(ctx, "POST", "/api/v1/generations/classify", { body: { documents: await textDocuments(ctx), labels: ctx.options.label } })
};

const segment = {
    description: "Split documents into RAG-ready segments.",
    options: { ...textDocumentOptions, sanitize: { description: "Skip segments that are better left out of the RAG (slower)." } },
    run: async ctx => call(ctx, "POST", "/api/v1/generations/segment", { body: { documents: await textDocuments(ctx), sanitize: ctx.options.sanitize } })
};

const rerank = {
    description: "Rank documents by relevance to a query.",
    options: {
        ...textDocumentOptions,
        query: { alias: "q", value: "<text>", required: true, description: "Query." },
        model: { alias: "m", value: "<model>", description: "Reranker. See \"aivax models catalog reranker\"." },
        top: { alias: "k", value: "<n>", number: true, description: "Maximum ranked documents." },
        minScore: { value: "<n>", number: true, description: "Minimum relevance score." }
    },
    async run(ctx) {
        const body = {
            documents: await textDocuments(ctx),
            query: ctx.options.query,
            model: ctx.options.model,
            top_n: ctx.options.top,
            min_score: ctx.options.minScore
        };

        await call(ctx, "POST", "/api/v1/generations/rerank", { body });
    }
};

const decide = {
    description: "Evaluate semantic decisions (noul, choice, score) over a state.",
    options: {
        model: { alias: "m", value: "<model>", description: "Semantic decision model." },
        state: { value: "<json>", description: "JSON state (JSON, @file or -)." },
        questions: { value: "<json>", description: "Questions object (JSON, @file or -)." },
        data: dataOption()
    },
    async run(ctx) {
        const body = await payload(ctx, {
            model: ctx.options.model,
            state: ctx.options.state && await readJson(ctx.options.state, "--state"),
            questions: ctx.options.questions && await readJson(ctx.options.questions, "--questions")
        });

        await call(ctx, "POST", "/api/v1/generations/decisions", { body });
    }
};

export default {
    description: "Media and text generation commands.",
    commands: { image, speech, transcribe, describe, summarize, translate, extract, classify, segment, rerank, decide }
};
