// Accès au coffre Obsidian via Obsidian Headless (client Sync officiel).
// Le coffre est copié dans /tmp à la première requête d'une instance, puis
// chaque appel d'outil fait une synchro incrémentale (quelques secondes).
import { execFile } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const BASE = process.env.VAULT_TMP_DIR || "/tmp/obsidian-connecteur";
export const VAULT_DIR = path.join(BASE, "vault");
const CONFIG_HOME = path.join(BASE, "config");

let initialised = false;
let queue: Promise<unknown> = Promise.resolve();

/** Exécute les opérations sur le coffre l'une après l'autre (pas de synchro concurrente). */
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

function syncConfig(): Record<string, unknown> {
  const raw = process.env.OB_SYNC_CONFIG;
  if (!raw) throw new Error("Variable OB_SYNC_CONFIG absente : le connecteur n'est pas configuré.");
  return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
}

async function writeConfig(mode: "pull-only" | "bidirectional") {
  const cfg = syncConfig();
  // Même emplacement que le CLI : $XDG_CONFIG_HOME/obsidian-headless sous Linux, ~/.obsidian-headless ailleurs.
  const root = process.platform === "linux" ? path.join(CONFIG_HOME, "obsidian-headless") : path.join(BASE, ".obsidian-headless");
  const dir = path.join(root, "sync", String(cfg.vaultId));
  await fs.mkdir(dir, { recursive: true });
  const full = {
    ...cfg,
    vaultPath: VAULT_DIR,
    deviceName: "Claude connecteur",
    syncMode: mode,
    conflictStrategy: "merge",
    allowTypes: ["pdf"], // .md, .base, .canvas et PDF : pas d'images, d'audio ni de vidéo
  };
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify(full, null, 2));
}

function runSync(timeout = 120_000): Promise<string> {
  if (!process.env.OBSIDIAN_AUTH_TOKEN) {
    throw new Error("Variable OBSIDIAN_AUTH_TOKEN absente : le connecteur n'est pas configuré.");
  }
  const cli = require.resolve("obsidian-headless/cli.js");
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cli, "sync", "--path", VAULT_DIR],
      {
        env: { ...process.env, XDG_CONFIG_HOME: CONFIG_HOME, HOME: BASE },
        timeout,
        maxBuffer: 20 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const out = `${stdout}\n${stderr}`;
        if (err || !/Fully synced/.test(out)) {
          const tail = out.trim().split("\n").slice(-8).join("\n");
          reject(new Error(`Échec de la synchro Obsidian : ${err?.message ?? ""}\n${tail}`));
        } else resolve(out);
      },
    );
  });
}

/** Ramène le coffre à jour (et envoie les changements locaux en attente). */
export async function sync(): Promise<void> {
  if (!initialised) {
    await fs.mkdir(VAULT_DIR, { recursive: true });
    // Première synchro d'une instance neuve en lecture seule : impossible
    // qu'un dossier vide soit pris pour des suppressions.
    await writeConfig("pull-only");
    // Le premier chargement télécharge aussi tous les PDF : délai plus long.
    await runSync(240_000);
    await writeConfig("bidirectional");
    initialised = true;
  }
  await runSync();
}

/**
 * Résout un chemin relatif au coffre, en refusant toute sortie du coffre.
 * Les accents peuvent être encodés différemment (NFC/NFD) entre la demande et
 * le disque : chaque segment existant est retrouvé par comparaison normalisée.
 */
export async function resolveInVault(rel: string): Promise<string> {
  const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  const abs = path.resolve(VAULT_DIR, clean);
  if (abs !== VAULT_DIR && !abs.startsWith(VAULT_DIR + path.sep)) {
    throw new Error(`Chemin hors du coffre : ${rel}`);
  }
  const parts = path.relative(VAULT_DIR, abs).split(path.sep).filter(Boolean);
  if (parts.some((p) => p.startsWith("."))) {
    throw new Error(`Dossier système interdit : ${rel}`);
  }
  let cur = VAULT_DIR;
  for (const part of parts) {
    let next = path.join(cur, part);
    if (!existsSync(next) && existsSync(cur)) {
      const want = part.normalize("NFC").toLowerCase();
      const match = (await fs.readdir(cur)).find((n) => n.normalize("NFC").toLowerCase() === want);
      if (match) next = path.join(cur, match);
    }
    cur = next;
  }
  return cur;
}

export function toRel(abs: string): string {
  return path.relative(VAULT_DIR, abs).split(path.sep).join("/");
}

export async function walk(dirAbs: string): Promise<string[]> {
  if (!existsSync(dirAbs)) return [];
  const out: string[] = [];
  for (const e of await fs.readdir(dirAbs, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dirAbs, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

export async function readText(abs: string): Promise<string> {
  return fs.readFile(abs, "utf8");
}

export async function writeText(abs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content.normalize("NFC"), "utf8");
}
