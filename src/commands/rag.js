import { basename, extname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { UsageError } from "../errors.js";
import { call, fetchData, print, seg, VERSION } from "../http.js";
import { resolveSession } from "../profiles.js";
import { dataOption, openFile, payload, readJson, readSource } from "../input.js";
import { confirm } from "../prompt.js";
import { crud, idOption } from "./crud.js";

const MEDIA_CHUNK_SIZE = 50 * 1024 * 1024;
const IMPORT_FRAME_BYTES = 256 * 1024;
const IMPORT_BUFFER_LIMIT = 1024 * 1024;

const collection = { alias: "c", value: "<id>", required: true, description: "Collection identifier." };

const collectionPath = ctx => `/api/v1/collections/${seg(ctx.options.collection)}`;

const queryOptions = {
    filter: { value: "<expr>", list: true, description: "Document filter, e.g. 'tags has \"faq\"'. Repeatable (combined with and)." },
    minScore: { value: "<n>", number: true, description: "Minimum similarity from 0 to 0.99." },
    sort: { value: "<field[:dir]>", description: "Order by score, createdAt, updatedAt, indexedAt or name, e.g. createdAt:desc." },
    limit: { alias: "k", value: "<n>", number: true, description: "Results per page, from 1 to 128." },
    cursor: { value: "<cursor>", description: "page.cursor from a previous response." },
    include: { value: "<fields>", description: "Comma-separated fields: content, metadata, references." }
};

function queryBody(ctx, extra) {
    const { options } = ctx;
    const [by, dir] = options.sort?.split(":") ?? [];

    return payload(ctx, {
        ...extra,
        filter: options.filter,
        minScore: options.minScore,
        sort: by ? { by, dir } : undefined,
        limit: options.limit,
        cursor: options.cursor,
        include: options.include?.split(",").map(field => field.trim())
    });
}

const search = {
    aliases: ["query"],
    description: "Search one or more collections by meaning.",
    options: {
        collection: { ...collection, list: true, description: "Collection identifier. Repeatable." },
        query: { alias: "q", value: "<text>", list: true, required: true, description: "Search text. Repeatable; each document scores by its best match." },
        reranker: { value: "<name>", description: "smart (default), lexical, rrf, none or a full reranker name." },
        candidates: { value: "<n>", number: true, description: "Candidate pool size reranked before paging." },
        ...queryOptions,
        data: dataOption()
    },
    async run(ctx) {
        const body = await queryBody(ctx, {
            collections: ctx.options.collection,
            terms: ctx.options.query,
            reranker: ctx.options.reranker,
            candidates: ctx.options.candidates
        });

        await call(ctx, "POST", "/api/v2/query", { body });
    }
};

const similar = {
    description: "Find documents similar to an indexed document.",
    options: {
        document: { value: "<id>", required: true, description: "Source document identifier." },
        collection: { ...collection, required: false, list: true, description: "Collections to search. Defaults to the source collection." },
        ...queryOptions,
        data: dataOption()
    },
    async run(ctx) {
        const body = await queryBody(ctx, { documentId: ctx.options.document, collections: ctx.options.collection });
        await call(ctx, "POST", "/api/v2/query/similar", { body });
    }
};

const answer = {
    description: "Generate an answer grounded on collection documents.",
    options: {
        collection: { ...collection, list: true, description: "Collection identifier. Repeatable." },
        query: { alias: "q", value: "<text>", list: true, required: true, description: "Question or search text." },
        top: { alias: "k", value: "<n>", number: true, description: "Maximum number of documents used." },
        minScore: { value: "<n>", number: true, description: "Minimum similarity score." },
        reranker: { value: "<name>", description: "Reranker identifier." },
        filter: queryOptions.filter,
        references: { description: "Include referenced document chunks." },
        data: dataOption()
    },
    async run(ctx) {
        const { options } = ctx;
        const body = await payload(ctx, {
            collections: options.collection,
            terms: options.query,
            top: options.top,
            minScore: options.minScore,
            reranker: options.reranker,
            filter: options.filter,
            includeReferences: options.references
        });

        await call(ctx, "POST", "/api/v1/answer", { body });
    }
};

const documentId = { value: "<id>", required: true, description: "Document identifier." };

const documents = {
    aliases: ["docs"],
    description: "Collection document commands.",
    commands: {
        list: {
            aliases: ["ls", "browse"],
            description: "List indexed documents of one or more collections.",
            options: {
                collection: { ...collection, list: true, description: "Collection identifier. Repeatable." },
                ...queryOptions,
                data: dataOption()
            },
            async run(ctx) {
                await call(ctx, "POST", "/api/v2/query/browse", { body: await queryBody(ctx, { collections: ctx.options.collection }) });
            }
        },
        get: {
            description: "Show one document.",
            options: { collection, id: documentId },
            run: ctx => call(ctx, "GET", `${collectionPath(ctx)}/documents/${seg(ctx.options.id)}`)
        },
        upsert: {
            aliases: ["put"],
            description: "Create or update a document matched by name.",
            options: {
                collection,
                name: { alias: "n", value: "<name>", description: "Document name (required by the API)." },
                contents: { value: "<text>", description: "Document contents. Use @file or - to read them." },
                file: { alias: "f", value: "<file>", description: "Text file used as contents. Name defaults to the file name." },
                reference: { value: "<text>", description: "Optional reference." },
                tag: { alias: "t", value: "<tag>", list: true, description: "Document tag. Repeatable." },
                metadata: { value: "<json>", description: "Metadata object (JSON, @file or -)." },
                data: dataOption()
            },
            async run(ctx) {
                const { options } = ctx;
                const body = await payload(ctx, {
                    name: options.name ?? (options.file && basename(options.file)),
                    contents: options.file ? await (await openFile(options.file)).text() : options.contents && await readSource(options.contents),
                    reference: options.reference,
                    tags: options.tag,
                    metadata: options.metadata && await readJson(options.metadata, "--metadata")
                });

                await call(ctx, "PUT", `${collectionPath(ctx)}/documents`, { body });
            }
        },
        delete: {
            aliases: ["rm"],
            description: "Delete a document.",
            options: { collection, id: documentId },
            async run(ctx) {
                await confirm(ctx, `Delete document ${ctx.options.id}?`);
                await call(ctx, "DELETE", `${collectionPath(ctx)}/documents/${seg(ctx.options.id)}`);
            }
        }
    }
};

async function importMedia(ctx, path) {
    const file = await openFile(path);
    const name = basename(path);
    const headers = {
        "X-Import-Media-File-Name": encodeURIComponent(name.normalize("NFC")),
        "X-Import-Media-File-Name-Encoding": "percent",
        "X-Import-Media-Upload-Id": crypto.randomUUID()
    };

    const chunks = Math.max(1, Math.ceil(file.size / MEDIA_CHUNK_SIZE));

    for (let index = 0; index < chunks; index++) {
        process.stderr.write(`Uploading ${name}: chunk ${index + 1}/${chunks}\n`);

        const chunk = file.slice(index * MEDIA_CHUNK_SIZE, (index + 1) * MEDIA_CHUNK_SIZE);
        await fetchData(ctx, "POST", `${collectionPath(ctx)}/documents/media/chunk`, { headers, body: chunk });
    }

    await fetchData(ctx, "POST", `${collectionPath(ctx)}/documents/media/complete`, { headers, body: { context: ctx.options.context ?? "" } });
    process.stderr.write(`Queued ${name} for processing.\n`);
}

async function* jsonlLines(path) {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    let number = 0;

    try {
        for await (const chunk of (await openFile(path)).stream()) {
            buffer += decoder.decode(chunk, { stream: true });

            let newline;
            while ((newline = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, newline).replace(/\r$/, "");
                buffer = buffer.slice(newline + 1);
                number++;

                if (line.trim()) yield { line, number };
            }
        }

        buffer += decoder.decode();
    }
    catch (error) {
        throw error instanceof TypeError ? new UsageError(`${path}: the file is not valid UTF-8.`) : error;
    }

    if (buffer.trim()) yield { line: buffer.replace(/\r$/, ""), number: number + 1 };
}

function lineProblem(line) {
    let record;

    try {
        record = JSON.parse(line);
    }
    catch (error) {
        return `invalid JSON (${error.message})`;
    }

    if (!record || typeof record !== "object" || Array.isArray(record)) {
        return "each line must be a JSON object";
    }

    const docId = record.docId ?? record.docid ?? record.DocId;
    const text = record.text ?? record.Text;

    return typeof docId === "string" && docId.trim() && typeof text === "string" ? null : "each line must contain docId and text";
}

async function importJsonl(ctx, files) {
    const { token, endpoint } = await resolveSession(ctx);
    const url = new URL(`/api/v2/collections/${seg(ctx.options.collection)}/documents/index-jsonl`, endpoint);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    if (ctx.options.sync) url.searchParams.set("insert-mode", "sync");

    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}`, "User-Agent": `aivax-cli/${VERSION}` } });
    let terminal = null;
    let failure = null;
    let sentFrames = 0;

    const closed = new Promise(resolve => socket.addEventListener("close", event => {
        if (!terminal) failure ??= new Error(`The import connection closed before completion (${event.code}${event.reason ? `: ${event.reason}` : ""}).`);
        resolve();
    }));

    socket.addEventListener("message", event => {
        let message;

        try {
            message = JSON.parse(String(event.data));
        }
        catch {
            failure = new Error("The server sent a message that is not JSON.");
            socket.close();
            return;
        }

        if (message.type === "progress") {
            process.stderr.write(`Committed ${message.committed ?? 0} lines (updated ${message.updated ?? 0}, skipped ${message.skipped ?? 0})\n`);
        }

        if (message.type === "completed" || message.type === "error") terminal = message;
    });

    const stopped = () => terminal || failure || socket.readyState !== WebSocket.OPEN;

    try {
        await new Promise((resolve, reject) => {
            socket.addEventListener("open", resolve, { once: true });
            socket.addEventListener("error", () => reject(new Error("The import connection failed. Check the profile, the endpoint and the collection id.")), { once: true });
        });

        let frame = [];
        let bytes = 0;

        const flush = async () => {
            if (!frame.length) return;

            while (socket.readyState === WebSocket.OPEN && socket.bufferedAmount > IMPORT_BUFFER_LIMIT) await sleep(20);
            if (stopped()) return;

            socket.send(`${frame.join("\n")}\n`);
            sentFrames++;
            frame = [];
            bytes = 0;
        };

        for (const path of files) {
            process.stderr.write(`Sending ${basename(path)}...\n`);

            for await (const { line, number } of jsonlLines(path)) {
                if (stopped()) break;

                const problem = lineProblem(line);
                if (problem) {
                    const kept = sentFrames ? " The import was aborted without END: lines already committed were kept and sync deletion did not run." : "";
                    throw new UsageError(`${path}:${number}: ${problem}.${kept}`);
                }

                frame.push(line);
                bytes += Buffer.byteLength(line) + 1;
                if (bytes >= IMPORT_FRAME_BYTES) await flush();
            }
        }

        await flush();
        if (!stopped()) socket.send("END");

        await Promise.race([closed, new Promise(resolve => {
            const timer = setInterval(() => terminal && (clearInterval(timer), resolve()), 15);
        })]);
    }
    finally {
        if (socket.readyState <= WebSocket.OPEN) socket.close();
    }

    if (terminal?.type === "completed") {
        const { received = 0, updated = 0, skipped = 0, removed = 0 } = terminal;
        print({ received, updated, skipped, removed });
        return;
    }

    if (terminal?.type === "error") {
        const where = terminal.line == null ? "" : ` at line ${terminal.line}`;
        const kept = terminal.committed == null ? "" : ` ${terminal.committed} lines were already committed.`;
        throw new Error(`${terminal.message ?? "Import failed"}${where}.${kept}`);
    }

    throw failure ?? new Error("The import ended without a completion message.");
}

const importCommand = {
    description: "Import documents from JSONL files, or media files (PDF, DOCX, images, etc.) processed into documents.",
    options: {
        collection,
        file: { alias: "f", value: "<file>", list: true, required: true, description: "JSONL or media file. Repeatable. All JSONL files are sent as one import." },
        sync: { description: "JSONL only: delete documents whose names are not present in the uploaded JSONL files." },
        context: { value: "<text>", description: "Media only: context used while processing the file." }
    },
    async run(ctx) {
        const isJsonl = path => [".jsonl", ".ndjson"].includes(extname(path).toLowerCase());
        const jsonl = ctx.options.file.filter(isJsonl);

        if (jsonl.length) {
            if (ctx.options.sync) {
                await confirm(ctx, `Sync mode deletes collection documents missing from ${jsonl.map(path => basename(path)).join(", ")}. Continue?`);
            }

            await importJsonl(ctx, jsonl);
        }

        for (const path of ctx.options.file.filter(path => !isJsonl(path))) {
            await importMedia(ctx, path);
        }
    }
};

const id = { id: idOption("Collection") };

const destructive = (description, method, suffix, message) => ({
    description,
    options: id,
    async run(ctx) {
        await confirm(ctx, message(ctx.options.id));
        await call(ctx, method, `/api/v1/collections/${seg(ctx.options.id)}${suffix}`);
    }
});

const collectionFields = {
    name: { alias: "n", key: "collectionName", value: "<name>", description: "Collection name." },
    context: { value: "<text>", source: true, description: "Collection context. Use @file or - to read it." },
    tags: { value: "<tags>", description: "Contextual tags." }
};

const transactions = {
    description: "List RAG transactions of a collection.",
    options: {
        ...id,
        view: { value: "<view>", description: "recent, low-quality or high-quality." },
        transaction: { value: "<id>", description: "Show one transaction instead of the list." },
        export: { description: "Export the transactions as JSONL." },
        output: { alias: "o", value: "<file>", description: "Write the export to a file." }
    },
    run(ctx) {
        const base = `/api/v1/collections/${seg(ctx.options.id)}/transactions`;
        const path = ctx.options.transaction ? `${base}/${seg(ctx.options.transaction)}` : ctx.options.export ? `${base}/export/jsonl` : base;

        return call(ctx, "GET", path, { query: { view: ctx.options.view } });
    }
};

const dedup = {
    aliases: ["deduplicate"],
    description: "Estimate or start the removal of duplicate documents.",
    options: {
        ...id,
        delta: { value: "<level>", description: "Sensitivity: low, medium (default) or high." },
        start: { description: "Start the de-duplication. Without it, only the cost estimate is shown." }
    },
    async run(ctx) {
        const base = `/api/v1/collections/${seg(ctx.options.id)}/deduplication`;
        const query = { delta: ctx.options.delta };

        if (!ctx.options.start) {
            await call(ctx, "GET", `${base}/estimate`, { query });
            return;
        }

        await confirm(ctx, `Remove duplicate documents from collection ${ctx.options.id}?`);
        await call(ctx, "POST", base, { query });
    }
};

const { list, get, create, patch, delete: remove } = crud({ base: "/api/v1/collections", noun: "collection", updateMethod: "PUT", fields: collectionFields });

export default {
    description: "RAG-specific commands.",
    commands: {
        search,
        similar,
        answer,
        collections: {
            description: "Collection management commands.",
            commands: {
                list: { ...list, options: {} },
                get,
                create,
                patch,
                delete: remove,
                export: {
                    description: "Export all documents as JSONL.",
                    options: { ...id, output: { alias: "o", value: "<file>", description: "Write the export to a file." } },
                    run: ctx => call(ctx, "GET", `/api/v1/collections/${seg(ctx.options.id)}/export.jsonl`, { agentOutput: false })
                },
                reset: destructive("Delete every document of a collection.", "DELETE", "/reset-only", id => `Delete every document of collection ${id}?`),
                reindex: destructive("Rebuild the vectors of a collection.", "DELETE", "/vectors-only", id => `Rebuild all vectors of collection ${id}? This is billed again.`),
                transactions,
                dedup
            }
        },
        documents,
        import: importCommand
    }
};
