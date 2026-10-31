import { setTimeout as sleep } from "node:timers/promises";
import { ApiError, UsageError } from "../errors.js";
import { call, events, fetchData, print, request, seg } from "../http.js";
import { dataOption, isUrl, payload, readJson, readSource } from "../input.js";
import { confirm } from "../prompt.js";
import { crud, idOption } from "./crud.js";

const test = { id: idOption("Agentic test") };

const runId = { value: "<id>", required: true, description: "Run identifier." };

const testPath = ctx => `/api/v1/agentic-tests/${seg(ctx.options.id)}`;

const runPath = ctx => `${testPath(ctx)}/runs/${seg(ctx.options.run)}`;

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);

const POLL_INTERVAL_MS = 5000;

const ROLE_COLORS = { user: "36", assistant: "35", judge: "33", tool: "34" };

const STATE_COLORS = { success: "32", loss: "31", interrupted: "31", at_risk: "33", incomplete: "33" };

const color = (code, text) => process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text;

const dim = text => color("2", text);

const header = (role, kind = "›") => `${color(`1;${ROLE_COLORS[role] ?? "37"}`, role)} ${dim(kind)} `;

const fixed = value => Number(value).toFixed(2);

const truncate = (text, max = 300) => text.length > max ? `${text.slice(0, max)}...` : text;

const textOf = content => typeof content === "string"
    ? content
    : Array.isArray(content)
        ? content.map(part => part.text ?? `[${part.type}]`).join("\n")
        : JSON.stringify(content ?? "");

const parseEvent = data => {
    try {
        return JSON.parse(data);
    }
    catch {
        return null;
    }
};

const toolCallLine = (name, args) => `  ${color("34", "→")} ${name}(${truncate(args ?? "")})`;

const toolResultLine = (name, content) => `  ${color("34", "←")} ${name ?? "tool"}: ${truncate(textOf(content).replace(/\s+/g, " "))}`;

function writer() {
    let segment = null;
    let atLineStart = true;

    const write = text => {
        if (!text) return;
        process.stdout.write(text);
        atLineStart = text.endsWith("\n");
    };

    const end = () => {
        if (!atLineStart) write("\n");
        segment = null;
    };

    return {
        end,
        stream(key, prefix, text) {
            if (segment !== key) {
                end();
                write(prefix);
                segment = key;
            }

            write(text);
        },
        line(text) {
            end();
            write(`${text}\n`);
        }
    };
}

function addUsage(totals, role, usage) {
    if (!usage || !(usage.prompt_tokens || usage.completion_tokens)) return;

    const total = totals[role] ??= { prompt: 0, cached: 0, completion: 0 };
    total.prompt += usage.prompt_tokens ?? 0;
    total.cached += usage.cached_prompt_tokens ?? 0;
    total.completion += usage.completion_tokens ?? 0;
}

function printJudge(out, result) {
    const streak = result.required_loss_streak === undefined
        ? result.loss_streak
        : `${result.loss_streak}/${result.required_loss_streak}`;

    const stats = [
        `turn ${result.turn_number}`,
        `score ${fixed(result.score)}`,
        `delta ${fixed(result.conversation_delta)}`,
        color(STATE_COLORS[result.state] ?? "37", result.state),
        `loss streak ${streak}`
    ];

    out.line(`${header("judge")}${stats.join(" · ")}`);

    if (result.reasoning) {
        out.line(dim(`  ${result.reasoning.trim().replaceAll("\n", "\n  ")}`));
    }
}

function printSummary(out, result = {}, totals, details = []) {
    const outcome = result.outcome ?? "none";

    const stats = [
        result.turn_number != null && `turn ${result.turn_number}`,
        result.score != null && `score ${fixed(result.score)}`,
        result.conversation_delta != null && `delta ${fixed(result.conversation_delta)}`,
        result.loss_streak != null && `loss streak ${result.loss_streak}`,
        ...details
    ].filter(Boolean);

    const usage = Object.entries(totals).map(([role, total]) => [
        `${role} ${total.prompt.toLocaleString("en-US")} in`,
        total.cached ? ` (${total.cached.toLocaleString("en-US")} cached)` : "",
        ` / ${total.completion.toLocaleString("en-US")} out`
    ].join(""));

    out.line("");
    out.line(`${color("1", "Result")} ${color(`1;${STATE_COLORS[outcome] ?? "37"}`, outcome.toUpperCase())}${result.reason ? dim(` · ${result.reason}`) : ""}`);

    if (stats.length) out.line(stats.join(" · "));
    if (result.error) out.line(color("31", result.error));
    if (usage.length) out.line(dim(`usage: ${usage.join(" · ")}`));
}

const runs = {
    description: "Agentic test run commands.",
    commands: {
        list: {
            aliases: ["ls"],
            description: "List the runs of a test.",
            options: {
                ...test,
                state: { value: "<state>", description: "pending, running, succeeded, failed or cancelled." },
                limit: { value: "<n>", number: true, description: "Maximum runs (default 50, max 100)." },
                offset: { value: "<n>", number: true, description: "Runs to skip." }
            },
            run: ctx => call(ctx, "GET", `${testPath(ctx)}/runs`, {
                query: { state: ctx.options.state, limit: ctx.options.limit, offset: ctx.options.offset }
            })
        },
        get: {
            description: "Show one run with its result and conversation.",
            options: {
                ...test,
                run: runId,
                stream: { description: "Follow the run until it finishes, printing the conversation as it progresses." }
            },
            async run(ctx) {
                if (!ctx.options.stream) {
                    await call(ctx, "GET", runPath(ctx));
                    return;
                }

                const connection = new AbortController();
                const response = await request(ctx, "GET", `${testPath(ctx)}/sse`, { agentOutput: false, signal: connection.signal });
                const out = writer();
                const totals = {};
                let printed = 0;
                let state;

                const refresh = async () => {
                    const run = await fetchData(ctx, "GET", runPath(ctx));
                    const items = run.conversation ?? [];
                    const finished = TERMINAL_STATES.has(run.state);

                    for (const item of items.slice(printed)) {
                        if (ctx.options.verbose) {
                            print(JSON.stringify(item));
                            continue;
                        }

                        addUsage(totals, item.role, item.usage);

                        if (item.role === "judge") {
                            printJudge(out, item.content);
                            continue;
                        }

                        if (item.role === "tool") {
                            out.line(toolResultLine(item.name, item.content));
                            continue;
                        }

                        const text = textOf(item.content);
                        if (text) out.line(`${header(item.role)}${text}`);

                        for (const toolCall of item.tool_calls ?? []) {
                            out.line(toolCallLine(toolCall.function?.name, toolCall.function?.arguments));
                        }
                    }

                    printed = items.length;

                    if (run.state !== state && !finished && !ctx.options.verbose) {
                        out.line(dim(`run ${run.state}`));
                    }

                    state = run.state;

                    if (!finished) {
                        return false;
                    }

                    if (ctx.options.verbose) {
                        print(JSON.stringify({ ...run, conversation: undefined }));
                    }
                    else {
                        printSummary(out, { ...run.result, error: run.result?.error ?? run.error }, totals, [
                            `state ${run.state}`,
                            run.cost != null && `cost $${run.cost.toFixed(4)}`
                        ]);
                    }

                    if (run.state === "failed") {
                        process.exitCode = 1;
                    }

                    return true;
                };

                let finished = await refresh();

                if (!finished) {
                    try {
                        for await (const data of events(response)) {
                            if (parseEvent(data)?.data?.run_id?.toLowerCase() !== ctx.options.run.toLowerCase()) {
                                continue;
                            }

                            if (finished = await refresh()) {
                                break;
                            }
                        }
                    }
                    catch (error) {
                        if (error instanceof ApiError) throw error;
                    }
                }

                connection.abort();

                while (!finished) {
                    await sleep(POLL_INTERVAL_MS);
                    finished = await refresh();
                }
            }
        },
        cancel: {
            description: "Cancel a pending or running run.",
            options: { ...test, run: runId },
            async run(ctx) {
                await confirm(ctx, `Cancel run ${ctx.options.run}?`);
                await call(ctx, "POST", `${runPath(ctx)}/cancel`);
            }
        }
    }
};

const evaluate = {
    description: "Run an ephemeral evaluation without saving a test. Streams the simulated conversation, judge verdicts and result.",
    options: {
        model: { alias: "m", value: "<model>", description: "AI gateway ID, slug or integrated model name." },
        goal: { alias: "g", value: "<text>", description: "Goal pursued by the simulated user. Accepts @file or - for stdin." },
        criteria: { alias: "c", value: "<text>", description: "Validation criteria visible only to the judge. Accepts @file or - for stdin." },
        start: { value: "<json>", description: "Initial OpenAI-compatible messages array (JSON, @file or -)." },
        resource: { alias: "r", value: "<text|url>", list: true, description: "Context resource for the simulator and judge: URL, @file or inline text. Repeatable." },
        maxTurns: { value: "<n>", number: true, description: "Maximum simulated user turns, 2 to 64 (default 10)." },
        minTurns: { value: "<n>", number: true, description: "First turn on which the simulated user may end the conversation (default 1)." },
        judgeStart: { value: "<n>", number: true, description: "First turn evaluated by the judge (default 1)." },
        noUserExit: { description: "Do not let the simulated user end the conversation early." },
        lossThreshold: { value: "<n>", number: true, description: "Score below which judge verdicts count toward a loss (default 0.2)." },
        baseThreshold: { value: "<n>", number: true, description: "Score at or above which the goal is reached (default 0.9)." },
        quality: { alias: "q", value: "<level>", description: "Simulator and judge profile: low, medium or high (default medium)." },
        metadata: { value: "<json>", description: "String metadata forwarded to the gateway (JSON, @file or -)." },
        user: { alias: "u", value: "<id>", description: "External user ID forwarded to the gateway." },
        data: dataOption()
    },
    async run(ctx) {
        const { options } = ctx;

        const body = await payload(ctx, {
            model: options.model,
            goal: options.goal && await readSource(options.goal),
            validation_criteria: options.criteria && await readSource(options.criteria),
            start: options.start && await readJson(options.start, "--start"),
            resources: options.resource && await Promise.all(options.resource.map(async value => isUrl(value)
                ? { type: "RemoteResource", data: value }
                : { type: "Text", data: await readSource(value) })),
            max_turns: options.maxTurns,
            minimum_turns: options.minTurns,
            judge_start_turn: options.judgeStart,
            allow_user_exit: options.noUserExit ? false : undefined,
            loss_threshold: options.lossThreshold,
            base_threshold: options.baseThreshold,
            profile: options.quality,
            metadata: options.metadata && await readJson(options.metadata, "--metadata"),
            external_user_id: options.user
        });

        if (!body.model || !body.goal) {
            throw new UsageError("Provide the tested model with -m <model> and the simulated user goal with -g <text>, or both in -d.");
        }

        const response = await request(ctx, "POST", "/api/v1/generations/agentic-tests", { body, agentOutput: false });
        const out = writer();
        const totals = {};
        const pending = {};
        let result;

        for await (const data of events(response)) {
            if (options.verbose) {
                print(data);
                continue;
            }

            const message = parseEvent(data);
            if (!message?.event) continue;

            const { type, data: event = {} } = message.event;
            const role = type.split(".")[1]?.replace("_message", "");

            switch (type) {
                case "chat.start": {
                    out.line(dim(`── Turn ${event.turn_number}/${event.turn_number + event.max_remaining_turns - 1}`));
                    break;
                }
                case "chat.user_message.reasoning":
                case "chat.assistant_message.reasoning": {
                    out.stream(`${role}.reasoning`, header(role, "thinking ›"), dim(event.reasoning_content ?? ""));
                    break;
                }
                case "chat.user_message.content":
                case "chat.assistant_message.content": {
                    out.stream(role, header(role), event.content ?? "");
                    break;
                }
                case "chat.assistant_message.refusal": {
                    out.stream(`${role}.refusal`, header(role, "refusal ›"), color("31", event.refusal ?? ""));
                    break;
                }
                case "chat.assistant_message.tool_call": {
                    out.line(toolCallLine(event.name, event.arguments));
                    break;
                }
                case "chat.assistant_message.tool_result": {
                    out.line(toolResultLine(event.name, event.content));
                    break;
                }
                case "usage_updated": {
                    pending[event.role] = event.usage;
                    break;
                }
                case "chat.user_message.end_generation":
                case "chat.assistant_message.end_generation":
                case "chat.judge.turn_analysis_end": {
                    addUsage(totals, role, pending[role]);
                    delete pending[role];
                    out.end();
                    break;
                }
                case "chat.user_message.end_conversation": {
                    out.line(dim("  the simulated user ended the conversation"));
                    break;
                }
                case "chat.judge.turn_analysis_result_ready": {
                    printJudge(out, event.result);
                    break;
                }
                case "unhandled_error": {
                    const retry = event.will_retry ? " (retrying)" : "";
                    out.line(color(event.will_retry ? "33" : "31", `! ${event.scope}: ${event.error}${retry}`));
                    break;
                }
                case "chat.validation.end": {
                    result = event;
                    break;
                }
            }
        }

        if (options.verbose) return;

        if (!result) {
            out.end();
            throw new Error("The evaluation stream ended without a result.");
        }

        printSummary(out, result, totals);
    }
};

const { list, ...rest } = crud({ base: "/api/v1/agentic-tests", noun: "agentic test" });

export default {
    description: "Agentic test commands.",
    commands: {
        list: {
            ...list,
            options: {
                search: { alias: "q", value: "<text>", description: "Test name search." },
                gateway: { value: "<id>", description: "Exact gateway ID, slug or model name." }
            },
            run: ctx => call(ctx, "GET", "/api/v1/agentic-tests", { query: { search: ctx.options.search, gateway: ctx.options.gateway } })
        },
        ...rest,
        run: {
            description: "Queue a run from the current test definition.",
            options: test,
            run: ctx => call(ctx, "POST", `${testPath(ctx)}/runs`)
        },
        runs,
        evaluate
    }
};
