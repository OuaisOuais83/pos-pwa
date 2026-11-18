// Fiches sourcées : conversion mécanique d'un PDF en note « texte intégral »
// et contrôle des citations d'une fiche contre le texte du PDF cité.
//
// Format d'une citation dans une fiche :
//   > [!quote] [[Dossier/CG Produit 2026.pdf#page=12|Art. 5.2, p. 12]]
//   > Texte exact recopié du PDF. Une coupe se note […].
import { promises as fs, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pdfPages } from "./pdf.js";
import { resolveInVault, toRel, walk, VAULT_DIR } from "./vault.js";

export async function empreinte(abs: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(abs)).digest("hex").slice(0, 16);
}

/** Note « texte intégral » d'un PDF : une section par page, texte tel qu'extrait, sans réécriture. */
export async function pdfToMarkdown(abs: string, date: string): Promise<string> {
  const pages = await pdfPages(abs);
  const rel = toRel(abs);
  const vides = pages.map((t, i) => (t ? 0 : i + 1)).filter(Boolean);
  const head = [
    "---",
    "type: texte-integral",
    `source: "[[${rel}]]"`,
    `empreinte: ${await empreinte(abs)}`,
    `pages: ${pages.length}`,
    `pages_sans_texte: [${vides.join(", ")}]`,
    `extrait_le: ${date}`,
    "---",
    `Texte extrait mécaniquement de [[${rel}]]. Ne pas modifier : la référence reste le PDF.`,
    "Les tableaux peuvent sortir désordonnés : toujours les contrôler sur le PDF.",
  ];
  const body = pages.map((t, i) => `## Page ${i + 1}\n[[${rel}#page=${i + 1}|Ouvrir la page ${i + 1}]]\n\n${t || "(page sans texte : scan ou image)"}`);
  return `${head.join("\n")}\n\n${body.join("\n\n")}\n`;
}

/** Neutralise ce qui diffère entre un PDF et une recopie sans changer le sens : espaces, césures, apostrophes, guillemets, tirets, ligatures. */
export function norm(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[­​-‍﻿]/g, "")
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”«»„]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/-\s*\n\s*/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\s*"\s*/g, '"')
    .replace(/\s+([.,;:!?%)])/g, "$1")
    .replace(/([(])\s+/g, "$1")
    .trim()
    .toLowerCase();
}

/** Version sans aucun espace ni trait d'union : rattrape les mots coupés en fin de ligne. */
const squeeze = (s: string) => norm(s).replace(/[\s-]/g, "");

interface Citation {
  ligne: number;
  cible: string;
  page: number | null;
  texte: string;
}

export function parseCitations(md: string): Citation[] {
  const lines = md.split("\n");
  const out: Citation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^>\s*\[!quote\][^\[]*\[\[([^\]|#]+\.pdf)(?:#([^\]|]*))?(?:\|[^\]]*)?\]\]/i);
    if (!m) continue;
    const page = m[2]?.match(/page=(\d+)/);
    const texte: string[] = [];
    let j = i + 1;
    for (; j < lines.length && /^>/.test(lines[j]); j++) texte.push(lines[j].replace(/^>\s?/, ""));
    out.push({ ligne: i + 1, cible: m[1].trim(), page: page ? Number(page[1]) : null, texte: texte.join("\n").trim() });
    i = j - 1;
  }
  return out;
}

/** Retrouve un PDF cité par chemin complet ou par simple nom de fichier, comme le fait Obsidian. */
async function findPdf(cible: string, all: string[]): Promise<string | null> {
  const direct = await resolveInVault(cible);
  if (existsSync(direct)) return direct;
  const want = path.basename(cible).normalize("NFC").toLowerCase();
  const hits = all.filter((p) => path.basename(p).normalize("NFC").toLowerCase() === want);
  return hits.length === 1 ? hits[0] : null;
}

const NOMBRE = /\d+(?:[   ]\d{3})*(?:[.,]\d+)?/g;
const chiffres = (s: string) => (s.match(NOMBRE) ?? []).map((n) => n.replace(/[   ]/g, "").replace(",", "."));

export interface Rapport {
  fiche: string;
  verdict: "conforme" | "non conforme";
  citations: number;
  erreurs: string[];
  avertissements: string[];
  sources: { pdf: string; empreinte: string }[];
}

export async function verifierFiche(abs: string, md: string, declared: Record<string, unknown>): Promise<Rapport> {
  const erreurs: string[] = [];
  const avertissements: string[] = [];
  const sources = new Map<string, string>();
  const all = (await walk(VAULT_DIR)).filter((p) => /\.pdf$/i.test(p));
  const cits = parseCitations(md);
  if (!cits.length) erreurs.push("Aucune citation au format « > [!quote] [[….pdf#page=N|…]] ».");
  let cited = "";
  for (const c of cits) {
    const ou = `ligne ${c.ligne}`;
    cited += ` ${c.texte}`;
    const pdf = await findPdf(c.cible, all);
    if (!pdf) {
      erreurs.push(`${ou} : PDF introuvable ou nom ambigu : ${c.cible}`);
      continue;
    }
    const rel = toRel(pdf);
    if (!sources.has(rel)) sources.set(rel, await empreinte(pdf));
    let pages: string[];
    try {
      pages = await pdfPages(pdf);
    } catch (e) {
      erreurs.push(`${ou} : PDF illisible : ${rel}`);
      continue;
    }
    if (c.page === null) {
      erreurs.push(`${ou} : lien sans numéro de page (#page=N).`);
      continue;
    }
    if (c.page < 1 || c.page > pages.length) {
      erreurs.push(`${ou} : page ${c.page} inexistante (${rel} a ${pages.length} pages).`);
      continue;
    }
    if (!c.texte) {
      erreurs.push(`${ou} : citation vide.`);
      continue;
    }
    // Une citation peut finir sur la page suivante ; les coupes […] donnent des segments à retrouver dans l'ordre.
    const zone = squeeze(`${pages[c.page - 1]} ${pages[c.page] ?? ""}`);
    const segs = c.texte.split(/\[…\]|\[\.\.\.\]/).map(squeeze).filter(Boolean);
    let pos = 0;
    let ok = true;
    let debut = -1;
    for (const s of segs) {
      const at = zone.indexOf(s, pos);
      if (at < 0) {
        ok = false;
        break;
      }
      if (debut < 0) debut = at;
      pos = at + s.length;
    }
    if (ok && debut >= squeeze(pages[c.page - 1]).length) {
      erreurs.push(`${ou} : l'extrait commence page ${c.page + 1}, pas page ${c.page}.`);
    } else if (!ok) {
      const ailleurs = pages.map((t, i) => (segs.every((s) => squeeze(t).includes(s)) ? i + 1 : 0)).filter(Boolean);
      erreurs.push(
        ailleurs.length
          ? `${ou} : extrait absent de la page ${c.page}, présent page ${ailleurs.join(", ")}.`
          : `${ou} : extrait introuvable mot pour mot dans ${rel} : « ${c.texte.slice(0, 80)}… »`,
      );
    }
  }
  // Chiffres affirmés hors citations : chacun doit figurer dans un extrait cité.
  const horsCitations = md
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .split("\n")
    .filter((l) => !/^>/.test(l) && !/^#/.test(l))
    .join("\n")
    .replace(/\[\[[^\]]*\]\]/g, " ");
  const connus = new Set(chiffres(cited));
  const orphelins = [...new Set(chiffres(horsCitations))].filter((n) => !connus.has(n));
  if (orphelins.length) avertissements.push(`Chiffres sans appui dans une citation : ${orphelins.join(", ")}`);
  // Empreintes déclarées dans la fiche : détecte un PDF remplacé depuis la validation.
  const decl = (declared.empreintes ?? {}) as Record<string, unknown>;
  for (const [rel, h] of sources) {
    const d = decl[rel] ?? decl[path.basename(rel)];
    if (d === undefined) avertissements.push(`Empreinte non déclarée pour ${rel} (actuelle : ${h}).`);
    else if (String(d) !== h) erreurs.push(`Le PDF ${rel} a changé depuis la validation (empreinte ${String(d)} → ${h}).`);
  }
  return {
    fiche: toRel(abs),
    verdict: erreurs.length ? "non conforme" : "conforme",
    citations: cits.length,
    erreurs,
    avertissements,
    sources: [...sources].map(([pdf, e]) => ({ pdf, empreinte: e })),
  };
}
