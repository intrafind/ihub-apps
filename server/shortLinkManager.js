import fs from "fs/promises";
import path from "path";
import { getRootDir } from "./pathUtils.js";
import config from "./config.js";

const contentsDir = config.CONTENTS_DIR;
const dataFile = path.join(
  getRootDir(),
  contentsDir,
  "data",
  "shortlinks.json",
);
const SAVE_INTERVAL_MS = 10000;

let links = null;
let dirty = false;
let saveTimer = null;

const now = () => new Date().toISOString();

export function isLinkExpired(link) {
  if (!link || !link.expiresAt) return false;
  return new Date(link.expiresAt) <= new Date();
}

function createDefault() {
  return { links: [], lastUpdated: now() };
}

async function loadLinks() {
  if (links) return links;
  try {
    const data = await fs.readFile(dataFile, "utf8");
    links = JSON.parse(data);
    links.lastUpdated = links.lastUpdated || now();
  } catch {
    links = createDefault();
  }
  return links;
}

async function saveLinks() {
  if (!links || !dirty) return;
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  links.lastUpdated = now();
  await fs.writeFile(dataFile, JSON.stringify(links, null, 2));
  dirty = false;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await saveLinks();
    } catch (e) {
      console.error("Failed to save short link data", e);
    }
  }, SAVE_INTERVAL_MS);
}

function generateCode(length = 6) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export async function createLink({
  code,
  appId,
  userId,
  path = null,
  params = null,
  url = null,
  includeParams = false,
  expiresAt = null,
}) {
  await loadLinks();
  let finalCode = code;
  if (finalCode) {
    if (links.links.some((l) => l.code === finalCode)) {
      throw new Error("Code already exists");
    }
  } else {
    do {
      finalCode = generateCode();
    } while (links.links.some((l) => l.code === finalCode));
  }

  let finalUrl = url;
  if (!finalUrl) {
    const basePath = path || (appId ? `/apps/${appId}` : "/");
    const dummy = new URL("http://localhost");
    dummy.pathname = basePath;
    if (includeParams && params && typeof params === "object") {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") {
          dummy.searchParams.set(k, String(v));
        }
      }
    }
    finalUrl =
      dummy.pathname +
      (dummy.search ? `?${dummy.searchParams.toString()}` : "");
  }

  const link = {
    code: finalCode,
    appId,
    userId,
    path,
    params,
    url: finalUrl,
    includeParams,
    createdAt: now(),
    usage: 0,
    expiresAt,
  };
  links.links.push(link);
  dirty = true;
  scheduleSave();
  return link;
}

export async function getLink(code) {
  await loadLinks();
  return links.links.find((l) => l.code === code);
}

export async function isCodeAvailable(code) {
  await loadLinks();
  return !links.links.some((l) => l.code === code);
}

export async function recordUsage(code) {
  await loadLinks();
  const link = links.links.find((l) => l.code === code);
  if (link) {
    link.usage = (link.usage || 0) + 1;
    link.lastUsed = now();
    dirty = true;
    scheduleSave();
  }
  return link;
}

export async function deleteLink(code) {
  await loadLinks();
  const idx = links.links.findIndex((l) => l.code === code);
  if (idx !== -1) {
    links.links.splice(idx, 1);
    dirty = true;
    scheduleSave();
    return true;
  }
  return false;
}

export async function updateLink(code, data) {
  await loadLinks();
  const link = links.links.find((l) => l.code === code);
  if (!link) return null;
  Object.assign(link, data, { code });
  dirty = true;
  scheduleSave();
  return link;
}

export async function searchLinks({ appId, userId } = {}) {
  await loadLinks();
  return links.links.filter(
    (l) => (!appId || l.appId === appId) && (!userId || l.userId === userId),
  );
}

loadLinks();
setInterval(() => {
  if (dirty)
    saveLinks().catch((e) => console.error("Short link save error:", e));
}, SAVE_INTERVAL_MS);
