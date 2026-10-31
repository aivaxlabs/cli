import { basename } from "node:path";
import { UsageError } from "../errors.js";
import { call, seg } from "../http.js";
import { dataOption, openFile, payload, readSource } from "../input.js";
import { confirm } from "../prompt.js";
import { crud, filterOption } from "./crud.js";

const workflow = { alias: "w", value: "<id>", required: true, description: "Batch workflow identifier." };

const job = { alias: "j", value: "<id>", required: true, description: "Batch job identifier." };

const jobsPath = ctx => `/api/v1/batch/workflows/${seg(ctx.options.workflow)}/jobs`;

const jobPath = ctx => `${jobsPath(ctx)}/${seg(ctx.options.job)}`;

const setState = state => ({
    description: `Set the job state to ${state}.`,
    options: { workflow, job },
    run: ctx => call(ctx, "PATCH", jobPath(ctx), { body: { state } })
});

const jobs = {
    description: "Batch job commands.",
    commands: {
        list: {
            aliases: ["ls"],
            description: "List jobs of a workflow, or recent jobs of the account when --workflow is omitted.",
            options: { workflow: { ...workflow, required: false }, filter: filterOption },
            run: ctx => ctx.options.workflow
                ? call(ctx, "GET", jobsPath(ctx), { query: { filter: ctx.options.filter } })
                : call(ctx, "GET", "/api/v1/batch/jobs")
        },
        get: {
            aliases: ["view"],
            description: "Show a job with its processing summary.",
            options: { workflow, job },
            run: ctx => call(ctx, "GET", jobPath(ctx))
        },
        create: {
            description: "Create a paused job. Import items, then run \"batch jobs start\".",
            options: { workflow, title: { alias: "t", value: "<title>", description: "Optional job title." } },
            run: ctx => call(ctx, "POST", jobsPath(ctx), { body: ctx.options.title ? { title: ctx.options.title } : {} })
        },
        patch: {
            aliases: ["update", "edit"],
            description: "Change a job title or state.",
            options: {
                workflow,
                job,
                title: { alias: "t", value: "<title>", description: "New title." },
                state: { value: "<state>", description: "Active, Paused or Finished." },
                data: dataOption()
            },
            run: async ctx => call(ctx, "PATCH", jobPath(ctx), { body: await payload(ctx, { title: ctx.options.title, state: ctx.options.state }) })
        },
        start: setState("Active"),
        pause: setState("Paused"),
        finish: setState("Finished"),
        delete: {
            aliases: ["rm"],
            description: "Delete a job and all its items.",
            options: { workflow, job },
            async run(ctx) {
                await confirm(ctx, `Delete job ${ctx.options.job} and all its items?`);
                await call(ctx, "DELETE", jobPath(ctx));
            }
        },
        export: {
            description: "Export job results as JSONL.",
            options: {
                workflow,
                job,
                state: { value: "<state>", description: "all, finished, failed, errors, success or an item state." },
                confidence: { value: "<level>", description: "high or low." },
                output: { alias: "o", value: "<file>", description: "Write the export to a file." }
            },
            run: ctx => call(ctx, "GET", `${jobPath(ctx)}/export.jsonl`, {
                query: { state: ctx.options.state, confidence: ctx.options.confidence },
                agentOutput: false
            })
        }
    }
};

const itemId = { value: "<id>", required: true, description: "Item identifier." };

const items = {
    description: "Batch item commands.",
    commands: {
        import: {
            description: "Import items from files or text. Lines mode imports each non-empty line as one item.",
            options: {
                workflow,
                job,
                file: { alias: "f", value: "<file>", list: true, description: "Input file. Repeatable." },
                text: { value: "<text>", description: "Manual item input (text mode). Use @file or - to read it." },
                mode: { alias: "m", value: "<mode>", description: "lines (default), files, zip or text." }
            },
            async run(ctx) {
                const { options } = ctx;
                const form = new FormData();

                if (!options.file && options.text === undefined) {
                    throw new UsageError("Provide items with -f <file> or --text <text>.");
                }

                form.append("mode", options.mode ?? (options.file ? "lines" : "text"));

                for (const path of options.file ?? []) {
                    form.append("items", await openFile(path), basename(path));
                }

                if (options.text !== undefined) {
                    form.append("text", await readSource(options.text));
                }

                await call(ctx, "POST", `${jobPath(ctx)}/items`, { body: form });
            }
        },
        list: {
            aliases: ["ls"],
            description: "List job items.",
            options: {
                workflow,
                job,
                state: { value: "<state>", description: "Pending, Finished, ExecutionError, ValidationError..." },
                confidence: { value: "<level>", description: "high or low." },
                filter: filterOption,
                sort: { value: "<order>", description: "inserted-desc, inserted-asc, processed-desc or processed-asc." },
                limit: { value: "<n>", number: true, description: "Maximum number of items." }
            },
            run: ctx => call(ctx, "GET", `${jobPath(ctx)}/items`, {
                query: {
                    state: ctx.options.state,
                    confidence: ctx.options.confidence,
                    filter: ctx.options.filter,
                    sort: ctx.options.sort,
                    limit: ctx.options.limit
                }
            })
        },
        get: {
            description: "Show one item.",
            options: { workflow, job, id: itemId },
            run: ctx => call(ctx, "GET", `${jobPath(ctx)}/items/${seg(ctx.options.id)}`)
        },
        patch: {
            aliases: ["update", "edit"],
            description: "Edit one item.",
            options: { workflow, job, id: itemId, data: dataOption(true) },
            run: async ctx => call(ctx, "PATCH", `${jobPath(ctx)}/items/${seg(ctx.options.id)}`, { body: await payload(ctx) })
        },
        delete: {
            aliases: ["rm"],
            description: "Delete one item, or many items with --mode.",
            options: {
                workflow,
                job,
                id: { ...itemId, required: false },
                mode: { value: "<mode>", description: "Bulk removal: pending, finished, errors or all." }
            },
            async run(ctx) {
                const { id, mode } = ctx.options;

                if (!id && !mode) {
                    throw new UsageError("Provide --id <item> or --mode <pending|finished|errors|all>.");
                }

                await confirm(ctx, id ? `Delete item ${id}?` : `Delete ${mode} items of job ${ctx.options.job}?`);
                await call(ctx, "DELETE", id ? `${jobPath(ctx)}/items/${seg(id)}` : `${jobPath(ctx)}/items`, { query: { mode } });
            }
        },
        retry: {
            description: "Retry failed or low-confidence items.",
            options: { workflow, job, mode: { value: "<mode>", description: "errors, execution-error, validation-error or low-confidence." } },
            run: ctx => call(ctx, "POST", `${jobPath(ctx)}/items/retry`, { query: { mode: ctx.options.mode } })
        }
    }
};

export default {
    description: "Batch job commands.",
    commands: {
        workflows: {
            description: "Batch workflow commands.",
            commands: crud({ base: "/api/v1/batch/workflows", noun: "batch workflow" })
        },
        jobs,
        items
    }
};
