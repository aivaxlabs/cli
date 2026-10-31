import { UsageError } from "../errors.js";
import { fetchData, print } from "../http.js";
import { defaultEndpoint, deleteToken, findProfile, loadProfiles, resolveSession, saveProfiles, slugify, storeToken } from "../profiles.js";
import { ask } from "../prompt.js";

async function loginWithApiKey(ctx, endpoint, apiKey) {
    const account = await fetchData(ctx, "GET", "/api/v1/accounts", {
        auth: false,
        endpoint,
        headers: { Authorization: `Bearer ${apiKey}` }
    });

    return { accessToken: apiKey, account };
}

async function loginWithLoginKey(ctx, endpoint) {
    const loginKey = ctx.options.loginKey ?? await ask("Login key: ", { hidden: true });

    if (!loginKey) {
        throw new UsageError("A login key is required.");
    }

    const send = totpCode => fetchData(ctx, "POST", "/api/v1/auth/login", {
        auth: false,
        endpoint,
        body: { loginKey, totpCode }
    });

    let result = await send(ctx.options["2fa"]);

    if (result.requiresTwoFactor && !result.accessToken) {
        result = await send(await ask("Two-factor code: "));
    }

    if (!result.accessToken) {
        throw new UsageError("The server did not return an access token.");
    }

    return result;
}

const login = {
    description: "Log in to an AIVAX account and save the account profile.",
    options: {
        loginKey: { value: "<key>", description: "Account login key. Prompted when neither --login-key nor --api-key is given." },
        apiKey: { value: "<key>", description: "Account API key. Links the profile without the login key or authenticator code." },
        "2fa": { value: "<code>", description: "Six-digit authenticator code. Prompted when the account requires it." },
        profileName: { value: "<name>", description: "Profile name. Defaults to the sanitized account name." },
        endpoint: { value: "<url>", description: "API endpoint. Defaults to https://inference.aivax.net." }
    },
    async run(ctx) {
        const endpoint = ctx.options.endpoint ?? defaultEndpoint();
        const { accessToken, account } = ctx.options.apiKey
            ? await loginWithApiKey(ctx, endpoint, ctx.options.apiKey)
            : await loginWithLoginKey(ctx, endpoint);

        const name = ctx.options.profileName?.trim() || slugify(account.name) || "default";
        const data = await loadProfiles();

        await storeToken(name, accessToken);

        data.profiles[name] = {
            accountId: account.id,
            accountName: account.name,
            email: account.email,
            endpoint,
            createdAt: new Date().toISOString()
        };
        data.default ??= name;
        await saveProfiles(data);

        const suffix = data.default === name ? " as the default profile" : `. Run "aivax auth use ${name}" to make it the default`;
        process.stderr.write(`Logged in as ${account.name}. Profile "${name}" saved${suffix}.\n`);
    }
};

const logout = {
    description: "Remove the linked account profile.",
    options: {
        profileName: { value: "<name>", description: "Profile to remove. Defaults to --profile or the default profile." }
    },
    async run(ctx) {
        const data = await loadProfiles();
        const name = findProfile(data, ctx.options.profileName ?? ctx.options.profile ?? data.default);

        await deleteToken(name);
        delete data.profiles[name];

        if (data.default === name) {
            data.default = Object.keys(data.profiles)[0] ?? null;
        }

        await saveProfiles(data);
        process.stderr.write(`Profile "${name}" removed from this device.\n`);
    }
};

const profiles = {
    aliases: ["list"],
    description: "List the saved account profiles.",
    async run() {
        const data = await loadProfiles();
        const rows = Object.entries(data.profiles)
            .map(([name, profile]) => `${name === data.default ? "*" : " "} ${name}\t${profile.accountName} <${profile.email}>\t${profile.endpoint}`);

        print(rows.length ? rows.join("\n") : "No profiles saved. Run \"aivax auth login\".");
    }
};

const use = {
    description: "Set the default account profile.",
    args: "<profile>",
    minArgs: 1,
    async run(ctx) {
        const data = await loadProfiles();
        data.default = findProfile(data, ctx.args[0]);

        await saveProfiles(data);
        process.stderr.write(`Default profile set to "${data.default}".\n`);
    }
};

const whoami = {
    description: "Show the profile used by the current operation.",
    async run(ctx) {
        const session = await resolveSession(ctx);

        if (!session.name) {
            print(`Using the AIVAX_API_KEY environment variable against ${session.endpoint}.`);
            return;
        }

        const { profiles } = await loadProfiles();
        const profile = profiles[session.name];
        print(`${session.name}\n${profile.accountName} <${profile.email}>\nAccount ID: ${profile.accountId}\nEndpoint: ${session.endpoint}`);
    }
};

export default {
    description: "Authentication-specific commands.",
    commands: { login, logout, profiles, use, whoami }
};
