import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { crc32 as checksum } from "node:zlib";
import { ApiError, UsageError } from "../errors.js";
import { fetchData, print, request } from "../http.js";
import { openFile, readJson } from "../input.js";
import { fetchSources, schemaOption } from "./web.js";

const MIME_TYPES = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".bmp": "image/bmp",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".rtf": "application/rtf",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".odp": "application/vnd.oasis.opendocument.presentation",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    ".csv": "text/csv",
    ".epub": "application/epub+zip",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".html": "text/html",
    ".htm": "text/html"
};

const MB = 1024 * 1024;
const MAX_ATTEMPTS = 5;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 520, 522, 524]);
const FATAL_STATUS = new Set([401, 402, 403]);
const EMPTY_CONTENT_ERROR = /no text could be extracted/i;

const log = message => process.stderr.write(`${message}\n`);

const formatDuration = ms => {
    const seconds = Math.round(ms / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
};

const formatSize = bytes => `${(bytes / MB).toFixed(2)} MB`;

const crc32 = data => checksum(data).toString(16).padStart(8, "0");

const isFatal = error => error instanceof UsageError || (error instanceof ApiError && FATAL_STATUS.has(error.status));

async function post(ctx, path, body) {
    for (let attempt = 1; ; attempt++) {
        try {
            const response = await request(ctx, "POST", path, { body, agentOutput: false });
            const { data } = await response.json();
            const credits = Number.parseFloat(response.headers.get("consumed-credits") ?? "");

            return { data, cost: Number.isFinite(credits) ? credits : null };
        }
        catch (error) {
            const retryable = error instanceof ApiError ? RETRYABLE_STATUS.has(error.status) : !isFatal(error);

            if (!retryable || attempt >= MAX_ATTEMPTS) {
                throw error;
            }

            await sleep(Math.max(2000 * 2 ** (attempt - 1), error.retryAfter ?? 0));
        }
    }
}

const parse = {
    description: "Extract text from images, scanned PDFs and documents. Prints the extracted text.",
    options: {
        file: { alias: "f", value: "<file|url>", list: true, description: "Image, PDF, office document or URL. Repeatable. Also accepted as positional arguments." },
        schema: schemaOption,
        json: { description: "Print the full API result, including processing units." }
    },
    args: "[file...]",
    async run(ctx) {
        const sources = [...(ctx.options.file ?? []), ...ctx.args];

        if (!sources.length) {
            throw new UsageError("Provide at least one file with -f <file>.");
        }

        const { results } = await fetchData(ctx, "POST", "/api/v1/web/fetch", {
            body: {
                contents: await fetchSources(sources),
                responseSchema: ctx.options.schema && await readJson(ctx.options.schema, "--schema")
            }
        });

        if (ctx.options.json) {
            print(results);
            return;
        }

        let failed = false;

        for (const result of results) {
            const source = sources[result.index];

            if (result.error) {
                failed = true;
                process.stderr.write(`error: ${source}: ${result.error}\n`);
                continue;
            }

            if (sources.length > 1) {
                print(`==> ${source} <==`);
            }

            print(result.extractedObject ?? result.extractedText ?? "");
        }

        if (failed) {
            process.exitCode = 1;
        }
    }
};

async function splitDocument(input, mime, source) {
    if (mime !== "application/pdf") {
        return [{ page: null, bytes: input, error: null }];
    }

    const { compressImages, openPdf, splitPages } = await import("../pdf.js");
    let doc;

    try {
        doc = await openPdf(input);
    }
    catch (error) {
        throw new UsageError(`Cannot open PDF: ${error.message}`);
    }

    log(`Compressing ${source} (${formatSize(input.length)}, ${doc.getPageCount()} pages)...`);
    const compressed = await compressImages(doc);
    log(`Recompressed ${compressed.images} images (${formatSize(compressed.saved)} saved).`);

    let lastReport = 0;
    return await splitPages(doc, (done, total) => {
        if (done === total || Date.now() - lastReport > 2000) {
            lastReport = Date.now();
            log(`Splitting pages ${done}/${total}...`);
        }
    });
}

const document = {
    aliases: ["doc"],
    description: "Transcribe a whole document page by page into Markdown or RAG-ready JSONL.",
    options: {
        file: { alias: "f", value: "<file>", description: "Document to transcribe. Also accepted as positional argument." },
        format: { value: "<format>", description: "markdown (default) or jsonl. JSONL lines are segmented and ready for \"aivax rag import\"." },
        output: { alias: "o", value: "<file>", description: "Output file. Defaults to stdout." },
        chunkSize: { value: "<MB>", number: true, description: "Maximum request size in MB. Defaults to 5." },
        concurrency: { value: "<n>", number: true, description: "Requests processed in parallel. Defaults to 4." }
    },
    args: "[file]",
    async run(ctx) {
        const { options } = ctx;
        const inputPath = options.file ?? ctx.args[0];
        const format = options.format === "md" ? "markdown" : options.format ?? "markdown";
        const chunkBytes = (options.chunkSize ?? 5) * MB;
        const concurrency = options.concurrency ?? 4;

        if (!inputPath || ctx.args.length > (options.file ? 0 : 1)) {
            throw new UsageError("Provide exactly one document with -f <file> or as positional argument.");
        }

        if (format !== "markdown" && format !== "jsonl") {
            throw new UsageError(`Invalid --format "${options.format}". Use markdown or jsonl.`);
        }

        if (!(chunkBytes > 0)) {
            throw new UsageError("--chunk-size must be a positive number.");
        }

        if (!Number.isInteger(concurrency) || concurrency < 1) {
            throw new UsageError("--concurrency must be a positive integer.");
        }

        const mime = MIME_TYPES[extname(inputPath).toLowerCase()];
        if (!mime) {
            throw new UsageError(`Unsupported file type "${extname(inputPath)}". Supported: ${Object.keys(MIME_TYPES).join(" ")}`);
        }

        const input = await (await openFile(inputPath)).bytes();
        const source = basename(inputPath);
        const startedAt = Date.now();
        const extractedAt = new Date(startedAt).toISOString();

        const units = (await splitDocument(input, mime, source))
            .map(({ page, bytes, error }) => ({ page, bytes, text: "", segments: [], error }));

        const totalPages = mime === "application/pdf" ? units.length : null;
        const chunks = [];
        let currentSize = 0;

        for (const unit of units.filter(item => item.bytes)) {
            if (!chunks.length || currentSize + unit.bytes.length > chunkBytes) {
                chunks.push([]);
                currentSize = 0;
            }

            chunks.at(-1).push(unit);
            currentSize += unit.bytes.length;
        }

        log(`Split into ${chunks.length} chunks of up to ${chunkBytes / MB} MB. Processing ${Math.min(concurrency, chunks.length)} at a time...`);

        const totals = { units: units.filter(unit => !unit.bytes).length, processingUnits: 0, tokens: 0, segments: 0, cost: 0, empty: 0 };
        let finishedChunks = 0;
        let nextChunk = 0;

        async function processChunk(chunk) {
            const contents = chunk.map(unit => `data:${mime};base64,${Buffer.from(unit.bytes).toString("base64")}`);
            const fetched = await post(ctx, "/api/v1/web/fetch", { contents, returnErrors: true });
            totals.cost += fetched.cost ?? 0;

            for (const result of fetched.data.results) {
                const unit = chunk[result.index];
                totals.processingUnits += result.processingUnits ?? 0;

                if (result.error && EMPTY_CONTENT_ERROR.test(result.error)) {
                    totals.empty++;
                }
                else if (result.error || result.extractedText == null) {
                    unit.error = `OCR failed: ${result.error ?? "no result"}`;
                }
                else {
                    unit.text = result.extractedText.trim();
                }
            }

            for (const [index, unit] of chunk.entries()) {
                if (!unit.error && !fetched.data.results.some(result => result.index === index)) {
                    unit.error = "OCR failed: missing result";
                }
            }

            const toSegment = chunk.filter(unit => !unit.error && unit.text);

            if (format !== "jsonl" || !toSegment.length) {
                return;
            }

            try {
                const { data, cost } = await post(ctx, "/api/v1/generations/segment", { documents: toSegment.map(unit => unit.text), sanitize: false });
                totals.cost += cost ?? data.usage.cost;
                totals.tokens += data.usage.processing_units;

                for (const result of data.result) {
                    const unit = toSegment[result.index];

                    if (result.error) {
                        unit.error = `Segmentation failed: ${result.error}`;
                        continue;
                    }

                    unit.segments = result.segments.filter(segment => segment.trim());
                    totals.segments += unit.segments.length;
                }
            }
            catch (error) {
                if (isFatal(error)) throw error;
                toSegment.forEach(unit => unit.error = `Segmentation failed: ${error.message}`);
            }
        }

        async function worker() {
            while (nextChunk < chunks.length) {
                const number = nextChunk++;
                const chunk = chunks[number];
                const chunkStartedAt = Date.now();

                try {
                    await processChunk(chunk);
                }
                catch (error) {
                    if (isFatal(error)) throw error;
                    chunk.forEach(unit => unit.error ??= `Request failed: ${error.message}`);
                }

                chunk.forEach(unit => unit.bytes = null);
                finishedChunks++;
                totals.units += chunk.length;

                const failed = chunk.filter(unit => unit.error).length;
                const elapsed = Date.now() - startedAt;
                const unitsTotal = totalPages ?? 1;
                const range = totalPages ? `pages ${chunk[0].page}-${chunk.at(-1).page}` : source;
                const eta = finishedChunks < chunks.length ? `, ETA ${formatDuration(elapsed / finishedChunks * (chunks.length - finishedChunks))}` : "";
                const consumption = `${totals.processingUnits} OCR PUs${format === "jsonl" ? `, ${totals.tokens} segment tokens, ${totals.segments} segments` : ""}, $${totals.cost.toFixed(6)}`;

                log(`[chunk ${number + 1}/${chunks.length}] ${range} ${failed ? `${failed} failed` : "ok"} in ${formatDuration(Date.now() - chunkStartedAt)}`
                    + ` | ${totals.units}/${unitsTotal} ${totalPages ? "pages" : "files"} (${Math.round(totals.units / unitsTotal * 100)}%)`
                    + ` | ${consumption}${eta}`);
            }
        }

        await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));

        const pageLabel = unit => totalPages ? `page ${unit.page}/${totalPages}` : source;
        let output;

        if (format === "markdown") {
            output = units
                .map(unit => {
                    if (!totalPages) return unit.error ? `<!-- ${unit.error} -->` : unit.text;
                    const marker = `<!-- ${pageLabel(unit)}${unit.error ? `: ${unit.error}` : ""} -->`;
                    return unit.text ? `${marker}\n\n${unit.text}` : marker;
                })
                .join("\n\n") + "\n";
        }
        else {
            const fileMeta = {
                file_name: source,
                file_hash_sha1: createHash("sha1").update(input).digest("hex"),
                file_hash_crc32: crc32(input)
            };

            output = units
                .flatMap(unit => unit.segments.map((text, index) => {
                    const pageSuffix = unit.page ? `:pg${unit.page}` : "";
                    const pageMeta = unit.page ? { page: unit.page, pages: totalPages, page_chunk: index + 1 } : {};

                    return `${JSON.stringify({
                        docid: `doc_${source}${pageSuffix}${unit.page ? "" : ":"}chk${crc32(text)}`,
                        __ref: `rf_${source}${pageSuffix}`,
                        text,
                        __meta: { ...fileMeta, ...pageMeta, extracted_at: extractedAt }
                    })}\n`;
                }))
                .join("");
        }

        if (options.output) {
            await writeFile(options.output, output);
        }
        else {
            process.stdout.write(output);
        }

        const failures = units.filter(unit => unit.error);
        const errorsPath = `${options.output ?? inputPath}.errors.txt`;

        if (failures.length) {
            await writeFile(errorsPath, failures.map(unit => `${pageLabel(unit)}: ${unit.error}`).join("\n") + "\n");
            process.exitCode = 1;
        }

        log(`Done in ${formatDuration(Date.now() - startedAt)}: ${units.length - failures.length}/${units.length} ${totalPages ? "pages" : "files"} transcribed`
            + `${totals.empty ? `, ${totals.empty} without text` : ""}${failures.length ? `, ${failures.length} failed (see ${errorsPath})` : ""}.`
            + ` Consumption: ${totals.processingUnits} OCR PUs${format === "jsonl" ? `, ${totals.tokens} segment tokens` : ""}, $${totals.cost.toFixed(6)}.`
            + `${options.output ? ` Output: ${options.output}` : ""}`);
    }
};

export default {
    description: "OCR commands.",
    commands: { parse, document }
};
