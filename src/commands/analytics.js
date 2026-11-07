import { call } from "../http.js";

export default {
    description: "Account analysis and consumption commands.",
    commands: {
        balance: {
            description: "Show balance, last-24-hour usage, plan, storage and quota status.",
            run: ctx => call(ctx, "GET", "/api/v1/information/balance")
        },
        usage: {
            description: "Show usage details and invoices for a period (defaults to the last 30 days).",
            options: {
                from: { value: "<date>", description: "ISO 8601 start date." },
                to: { value: "<date>", description: "ISO 8601 end date." }
            },
            run: ctx => call(ctx, "GET", "/api/v1/information/usage", { query: { timeStart: ctx.options.from, timeEnd: ctx.options.to } })
        },
        report: {
            description: "Show the monthly report with top-cost models, resources and SKUs.",
            options: {
                month: { alias: "m", value: "<YYYY-MM>", description: "Reporting month. Defaults to the current month." },
                brl: { description: "Include usdBrlRate, the current USD to BRL exchange rate." }
            },
            run: ctx => call(ctx, "GET", "/api/v1/information/usage/monthly-report", {
                query: { month: ctx.options.month ?? new Date().toISOString().slice(0, 7), includeBrl: ctx.options.brl }
            })
        },
        resources: {
            description: "List collections, gateways, chat clients, batch workflows, jobs and models of the account.",
            run: ctx => call(ctx, "GET", "/api/v1/platform/search")
        }
    }
};
