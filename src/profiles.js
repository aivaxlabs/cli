import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Entry } from "@napi-rs/keyring";
import { UsageError } from "./errors.js";

const SERVICE = "aivax-cli";

const configHome = process.platform === "win32"
    ? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
    : process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");

const profilesFile = join(process.env.AIVAX_CLI_HOME ?? join(configHome, "aivax-cli"), "profiles.json");

export const defaultEndpoint = () => process.env.AIVAX_ENDPOINT ?? "https://inference.aivax.net";

export async function loadProfiles() {
    try {
        return JSON.parse(await readFile(profilesFile, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT") return { default: null, profiles: {} };
        throw error;
    }
}

export async function saveProfiles(data) {
    await mkdir(dirname(profilesFile), { recursive: true });
    await writeFile(profilesFile, JSON.stringify(data, null, 4));
}

export const slugify = text => text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export function findProfile(data, name) {
    if (!name || !data.profiles[name]) {
        throw new UsageError(name
            ? `Profile "${name}" not found. Run "aivax auth profiles" to list the saved profiles.`
            : "No account profile found. Run \"aivax auth login\" first.");
    }

    return name;
}

export const storeToken = (name, value) => new Entry(SERVICE, name).setPassword(value);

export const deleteToken = name => new Entry(SERVICE, name).deletePassword();

export async function resolveSession(ctx) {
    if (process.env.AIVAX_API_KEY && !ctx.options.profile) {
        return { token: process.env.AIVAX_API_KEY, endpoint: defaultEndpoint() };
    }

    const data = await loadProfiles();
    const name = findProfile(data, ctx.options.profile ?? data.default);
    const profile = data.profiles[name];
    const token = new Entry(SERVICE, name).getPassword();
    if (!token) {
        throw new UsageError(`The access key of profile "${name}" is missing from the system credential store. Run "aivax auth login" again.`);
    }

    return { name, token, endpoint: process.env.AIVAX_ENDPOINT ?? profile.endpoint };
}
