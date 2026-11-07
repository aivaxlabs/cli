import { call, seg } from "../http.js";
import { dataOption, payload } from "../input.js";
import { confirm } from "../prompt.js";

const code = { value: "<code>", description: "Six-digit authenticator code." };

const keys = {
    aliases: ["api-keys"],
    description: "API key commands.",
    commands: {
        list: {
            aliases: ["ls"],
            description: "List masked API keys and the account salt.",
            run: ctx => call(ctx, "GET", "/api/v1/accounts/api-key")
        },
        applications: {
            description: "List third-party applications authorized through OAuth. Revoke one with \"keys delete --id <id>\".",
            run: ctx => call(ctx, "GET", "/api/v1/accounts/applications")
        },
        create: {
            description: "Create an API key. The key is shown only once.",
            options: {
                label: { alias: "l", value: "<label>", required: true, description: "Key label." },
                days: { value: "<n>", number: true, description: "Validity in days. Omit for a key that never expires." },
                type: { value: "<type>", description: "private (default) or public." }
            },
            run: ctx => call(ctx, "POST", "/api/v1/accounts/api-key", {
                body: { label: ctx.options.label, duration: ctx.options.days ?? -1, type: ctx.options.type ?? "private" }
            })
        },
        delete: {
            aliases: ["rm", "revoke"],
            description: "Revoke an API key.",
            options: { id: { value: "<id>", required: true, description: "API key identifier." } },
            async run(ctx) {
                await confirm(ctx, `Revoke API key ${ctx.options.id}?`);
                await call(ctx, "DELETE", `/api/v1/accounts/api-key/${seg(ctx.options.id)}`);
            }
        }
    }
};

const security = {
    description: "Two-factor authentication commands.",
    commands: {
        status: {
            description: "Show whether 2FA is enabled and the confirmed authenticators.",
            run: ctx => call(ctx, "GET", "/api/v1/accounts/security")
        },
        "totp-setup": {
            description: "Start an authenticator setup. Returns the secret and otpauth URI once.",
            options: { name: { alias: "n", value: "<name>", description: "Authenticator name." } },
            run: ctx => call(ctx, "POST", "/api/v1/accounts/security/totp", { body: { name: ctx.options.name } })
        },
        "totp-confirm": {
            description: "Confirm the pending authenticator.",
            options: {
                code: { ...code, required: true },
                name: { alias: "n", value: "<name>", description: "Authenticator name." },
                currentCode: { ...code, description: "Code from an existing authenticator, when one is already enabled." }
            },
            run: ctx => call(ctx, "POST", "/api/v1/accounts/security/totp/confirm", {
                body: { code: ctx.options.code, name: ctx.options.name, currentCode: ctx.options.currentCode }
            })
        },
        "totp-remove": {
            description: "Remove an authenticator. Removing the last one disables 2FA.",
            options: { id: { value: "<id>", required: true, description: "Authenticator identifier." }, code: { ...code, required: true } },
            async run(ctx) {
                await confirm(ctx, `Remove authenticator ${ctx.options.id}?`);
                await call(ctx, "POST", `/api/v1/accounts/security/totp/${seg(ctx.options.id)}/remove`, { body: { code: ctx.options.code } });
            }
        }
    }
};

const subscription = {
    description: "Subscription and billing commands.",
    commands: {
        status: { description: "Show the current subscription.", run: ctx => call(ctx, "GET", "/api/v1/subscriptions") },
        "payment-methods": { description: "List saved payment methods.", run: ctx => call(ctx, "GET", "/api/v1/subscriptions/payment-methods") },
        portal: { description: "Open a payment-methods portal session.", run: ctx => call(ctx, "POST", "/api/v1/subscriptions/payment-methods/portal") },
        plan: {
            description: "Change the account plan.",
            options: { plan: { alias: "p", value: "<plan>", required: true, description: "Free, Pro or Max." } },
            async run(ctx) {
                await confirm(ctx, `Change the plan to ${ctx.options.plan}?`);
                await call(ctx, "POST", "/api/v1/subscriptions/plan", { body: { plan: ctx.options.plan } });
            }
        },
        cancel: {
            description: "Cancel the subscription.",
            async run(ctx) {
                await confirm(ctx, "Cancel the subscription?");
                await call(ctx, "POST", "/api/v1/subscriptions/cancel");
            }
        },
        resubscribe: { description: "Resume a cancelled subscription.", run: ctx => call(ctx, "POST", "/api/v1/subscriptions/resubscribe") }
    }
};

export default {
    description: "Account, API key, security and subscription commands.",
    commands: {
        update: {
            description: "Replace the account name and parameters (full replacement).",
            options: { data: dataOption(true) },
            async run(ctx) {
                await confirm(ctx, "Replace the account name and every account parameter?");
                await call(ctx, "PUT", "/api/v1/accounts", { body: await payload(ctx) });
            }
        },
        keys,
        security,
        subscription,
        "roll-salt": {
            description: "Generate a new account salt. Invalidates integrations that depend on the current salt.",
            async run(ctx) {
                await confirm(ctx, "Roll the account salt? Webhooks and integrations using the current salt stop working.");
                await call(ctx, "POST", "/api/v1/accounts/roll-salt");
            }
        },
        "reset-login-key": {
            description: "Create a new login key, e-mail it, and sign out every console session.",
            async run(ctx) {
                await confirm(ctx, "Reset the login key? Every console and CLI session will be signed out.");
                await call(ctx, "POST", "/api/v1/accounts/login-key/reset");
            }
        },
        notifications: {
            description: "List account notifications, or the unread count with --unread.",
            options: { unread: { description: "Show only the unread count." } },
            run: ctx => call(ctx, "GET", ctx.options.unread ? "/api/v1/notifications/unread/count" : "/api/v1/notifications")
        }
    }
};
