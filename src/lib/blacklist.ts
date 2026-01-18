import fs from "node:fs";
import { dataPath } from "./data_dir";
import { logger } from "../logger";

const BLACKLIST_FILE = "blacklist.json";

export type Blacklist = Record<string, number>; // address -> expiry_ms

function getPath(): string {
    return dataPath(BLACKLIST_FILE);
}

export function loadBlacklist(): Blacklist {
    try {
        const p = getPath();
        if (!fs.existsSync(p)) return {};
        return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch (e) {
        logger.error({ err: e }, "Failed to load blacklist");
        return {};
    }
}

export function saveBlacklist(bl: Blacklist) {
    try {
        fs.writeFileSync(getPath(), JSON.stringify(bl, null, 2));
    } catch (e) {
        logger.error({ err: e }, "Failed to save blacklist");
    }
}

export function isBlacklisted(bl: Blacklist, addr: string): boolean {
    const expiry = bl[addr.toLowerCase()];
    if (!expiry) return false;
    if (Date.now() > expiry) return false; // Expired
    return true;
}

export function addToBlacklist(addr: string, durationMs: number = 3600000) { // Default 1 hour
    const bl = loadBlacklist();
    // Cleanup expired
    const now = Date.now();
    for (const k in bl) {
        if (bl[k] < now) delete bl[k];
    }

    bl[addr.toLowerCase()] = now + durationMs;
    saveBlacklist(bl);
    logger.info({ addr, durationMs }, "🚫 Blacklisted user due to execution failure");
}
