// Définition du serveur MCP « Coffre Obsidian » : les outils que Claude voit.
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { exclusive, sync, resolveInVault, toRel, walk, readText, writeText, VAULT_DIR } from "./vault.js";
import { parseProps, setProps, appendToSection, renameLinks, stripAccents } from "./markdown.js";
import { isPdf, pdfPages, readPdf } from "./pdf.js";
import { pdfToMarkdown, verifierFiche } from "./fiches.js";
import { etatCrm, todayParis, CRM_ROOT } from "./crm.js";

const INSTRUCTIONS = `Connecteur du coffre Obsidian « Vie » de Stive (synchronisé par Obsidian Sync : ce que tu écris arrive sur son iPhone, son iPad et son Mac).
Deux espaces : « CRM GPM » (CRM commercial prévoyance GPM) et « Garde-robe ».
- Avant d'écrire dans le CRM, appelle \`regles\` (domaine crm) et applique « Règles de traitement » à la lettre : Échange + mise à jour de la fiche Contact + ligne d'Historique + tâches \`- [ ] Action [[Nom]] [due:: AAAA-MM-JJ]\` + Échéances.
- Stive dicte en vrac : tu ranges sans lui reposer de questions, sauf nom ou date ambigus.
- Groupe toutes les modifications d'une dictée dans UN seul appel à \`modifier\`.
- Pour le brief du matin ou une revue : \`etat_crm\`, puis écris la note dans « CRM GPM/Briefs » au format des briefs existants.
- Les documents PDF du coffre se lisent avec \`lire\` (texte extrait, paramètre \`pages\` pour les longs documents) et sont couverts par \`chercher\`. Ils sont en lecture seule.
- Fiches sourcées : chaque affirmation s'appuie sur une citation \`> [!quote] [[….pdf#page=N|Art. X, p. N]]\` suivie du texte exact ; après écriture, lancer \`verifier\` et corriger jusqu'à « conforme ».
- Jamais de données de santé d'un contact dans le coffre.
- Dates au format AAAA-MM-JJ, fuseau Europe/Paris.`;

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 1));
const fail = (e: unknown) => ({ ...text(`Erreur : ${e instanceof Error ? e.message : String(e)}`), isError: true });

/** Extrait d'environ 300 caractères centré sur le terme trouvé (les lignes d'un PDF peuvent être très longues). */
function excerpt(line: string, q: string): string {
  const l = line.trim();
  if (l.length <= 300) return l;
  const i = Math.max(0, stripAccents(l).indexOf(q));
  const start = Math.max(0, i - 120);
  return (start ? "…" : "") + l.slice(start, start + 300) + (start + 300 < l.length ? "…" : "");
}

/** Lance une opération sur un coffre à jour ; option : resynchroniser après écriture. */
function withVault<T>(fn: () => Promise<T>, pushAfter = false) {
  return exclusive(async () => {
    await sync();
    const r = await fn();
    if (pushAfter) await sync();
    return r;
  });
}

const Operation = z.object({
  op: z
    .enum(["ecrire", "creer", "remplacer", "proprietes", "ajouter_ligne", "renommer", "supprimer", "convertir_pdf"])
    .describe(
      "ecrire = créer ou écraser la note avec `contenu` ; creer = comme ecrire mais échoue si la note existe ; " +
        "remplacer = remplacer le texte exact `ancien` par `nouveau` (doit apparaître une seule fois) ; " +
        "proprietes = fusionner `proprietes` dans le frontmatter (null supprime une propriété) ; " +
        "ajouter_ligne = ajouter `ligne` à la fin de la section `section` (ex : « Historique », « Actions ») ; " +
        "renommer = déplacer/renommer vers `nouveau_chemin` et mettre à jour tous les liens [[...]] du coffre ; " +
        "supprimer = supprimer la note (récupérable dans l'historique Obsidian Sync) ; " +
        "convertir_pdf = créer la note « texte intégral » du PDF `chemin` (texte extrait mécaniquement, une section par page, sans passer par Claude), " +
        "à côté du PDF ou vers `nouveau_chemin`.",
    ),
  chemin: z.string().describe("Chemin depuis la racine du coffre, extension comprise. Ex : « CRM GPM/Contacts/Jean-Marc SOUTY.md »."),
  contenu: z.string().optional(),
  ancien: z.string().optional(),
  nouveau: z.string().optional(),
  proprietes: z.record(z.any()).optional(),
  section: z.string().optional(),
  ligne: z.string().optional(),
  nouveau_chemin: z.string().optional(),
});
type Op = z.infer<typeof Operation>;

async function applyOp(o: Op): Promise<string> {
  const abs = await resolveInVault(o.chemin);
  const rel = toRel(abs);
  if (o.op === "convertir_pdf") {
    if (!isPdf(abs) || !existsSync(abs)) throw new Error(`PDF introuvable : ${o.chemin}`);
    const dest = await resolveInVault(o.nouveau_chemin ?? `${rel.replace(/\.pdf$/i, "")} (texte intégral).md`);
    if (!dest.endsWith(".md")) throw new Error(`La destination doit être une note .md : ${o.nouveau_chemin}`);
    const md = await pdfToMarkdown(abs, todayParis());
    await writeText(dest, md);
    return `converti : ${rel} → ${toRel(dest)} (${(md.match(/^## Page /gm) ?? []).length} pages)`;
  }
  if (isPdf(abs) && o.op !== "renommer" && o.op !== "supprimer") {
    throw new Error(`${o.op} impossible sur un PDF : ${rel} (seuls renommer, supprimer et convertir_pdf sont permis)`);
  }
  const need = <K extends keyof Op>(k: K): NonNullable<Op[K]> => {
    if (o[k] === undefined || o[k] === null) throw new Error(`${o.op} sur « ${o.chemin} » : champ « ${String(k)} » manquant`);
    return o[k] as NonNullable<Op[K]>;
  };
  const mustExist = () => {
    if (!existsSync(abs)) throw new Error(`Note introuvable : ${o.chemin}`);
  };
  switch (o.op) {
    case "ecrire":
      await writeText(abs, need("contenu"));
      return `écrit : ${rel}`;
    case "creer":
      if (existsSync(abs)) throw new Error(`Existe déjà : ${rel}`);
      await writeText(abs, need("contenu"));
      return `créé : ${rel}`;
    case "remplacer": {
      mustExist();
      const t = await readText(abs);
      const ancien = need("ancien");
      const n = t.split(ancien).length - 1;
      if (n !== 1) throw new Error(`« ancien » apparaît ${n} fois dans ${rel} (il faut exactement 1)`);
      await writeText(abs, t.replace(ancien, () => need("nouveau")));
      return `modifié : ${rel}`;
    }
    case "proprietes":
      if (existsSync(abs)) await writeText(abs, setProps(await readText(abs), need("proprietes")));
      else await writeText(abs, setProps("", need("proprietes")));
      return `propriétés mises à jour : ${rel}`;
    case "ajouter_ligne":
      mustExist();
      await writeText(abs, appendToSection(await readText(abs), need("section"), need("ligne")));
      return `ligne ajoutée (${o.section}) : ${rel}`;
    case "renommer": {
      mustExist();
      const dest = await resolveInVault(need("nouveau_chemin"));
      if (existsSync(dest)) throw new Error(`Destination déjà existante : ${toRel(dest)}`);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(abs, dest);
      // Une note se lie par son nom sans extension, un PDF par son nom complet.
      const oldName = path.basename(abs, ".md");
      const newName = path.basename(dest, ".md");
      let touched = 0;
      if (oldName !== newName) {
        for (const p of await walk(VAULT_DIR)) {
          if (!p.endsWith(".md") && !p.endsWith(".base") && !p.endsWith(".canvas")) continue;
          const t = await readText(p);
          const u = renameLinks(t, oldName, newName);
          if (u !== t.normalize("NFC")) {
            await writeText(p, u);
            touched++;
          }
        }
      }
      return `renommé : ${rel} → ${toRel(dest)} (liens mis à jour dans ${touched} note(s))`;
    }
    case "supprimer":
      mustExist();
      await fs.rm(abs);
      return `supprimé : ${rel}`;
  }
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "coffre-obsidian", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "regles",
    {
      title: "Règles du coffre",
      description:
        "Renvoie les règles à suivre avant d'écrire : pour le CRM (Mode d'emploi, Règles de traitement, modèles Contact/Échange/Échéance/Note savoir) ou pour la Garde-robe. À appeler en début de conversation dès qu'il faut écrire.",
      inputSchema: { domaine: z.enum(["crm", "garde-robe"]).default("crm") },
      annotations: { readOnlyHint: true },
    },
    async ({ domaine }) => {
      try {
        const files =
          domaine === "crm"
            ? [
                "CRM GPM/Mode d'emploi.md",
                "CRM GPM/Règles de traitement.md",
                "CRM GPM/Templates/Contact.md",
                "CRM GPM/Templates/Échange.md",
                "CRM GPM/Templates/Échéance.md",
                "CRM GPM/Templates/Note savoir.md",
              ]
            : [
                "Garde-robe/Règles de traitement garde-robe.md",
                "Garde-robe/Règles de couleur.md",
                "Garde-robe/Style.md",
                "Garde-robe/Profil.md",
                "Garde-robe/Templates/Pièce.md",
                "Garde-robe/Templates/Tenue.md",
              ];
        const out = await withVault(async () => {
          const parts = [`Date du jour (Paris) : ${todayParis()}`];
          for (const f of files) {
            const abs = await resolveInVault(f);
            if (existsSync(abs)) parts.push(`\n===== ${toRel(abs)} =====\n${await readText(abs)}`);
          }
          if (domaine === "crm") {
            parts.push(
              "\nNote : les modèles contiennent du code Templater (<%* ... %>) qui ne sert qu'à la saisie manuelle dans Obsidian. " +
                "Quand tu écris une note, reproduis uniquement la structure obtenue (propriétés + sections), avec les valeurs réelles.",
            );
          }
          return parts.join("\n");
        });
        return text(out);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "etat_crm",
    {
      title: "État du CRM",
      description:
        "Extraction complète et à jour du CRM GPM en JSON : tâches en retard / du jour / de la semaine, contacts à relancer, RDV à venir, fenêtres d'échéances ouvertes, échéances à 30 jours, propositions silencieuses, dormants, revues clients, pipeline, hygiène, activité de la semaine, mantras, totaux. Base du brief du matin et des revues du vendredi.",
      inputSchema: { jours: z.number().int().min(1).max(60).default(7).describe("Fenêtre en jours pour « semaine » et RDV") },
      annotations: { readOnlyHint: true },
    },
    async ({ jours }) => {
      try {
        return json(await withVault(() => etatCrm(jours)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "lister",
    {
      title: "Lister un dossier",
      description:
        "Liste les notes et documents PDF d'un dossier du coffre (récursif), avec les propriétés principales des notes et la taille des PDF. Ex : « CRM GPM/Contacts », « CRM GPM/Échéances », « Garde-robe/Pièces ». Dossier vide = tout le coffre (chemins seulement).",
      inputSchema: {
        dossier: z.string().default(""),
        avec_proprietes: z.boolean().default(true).describe("Inclure les propriétés (frontmatter) de chaque note"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ dossier, avec_proprietes }) => {
      try {
        const out = await withVault(async () => {
          const dir = await resolveInVault(dossier);
          const files = (await walk(dir)).sort();
          if (!dossier || !avec_proprietes) return files.map(toRel);
          const res = [];
          for (const p of files) {
            if (p.endsWith(".md")) res.push({ chemin: toRel(p), ...parseProps(await readText(p)) });
            else if (isPdf(p)) res.push({ chemin: toRel(p), taille_ko: Math.ceil((await fs.stat(p)).size / 1024) });
            else res.push({ chemin: toRel(p) });
          }
          return res;
        });
        return json(out);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "lire",
    {
      title: "Lire des notes et des PDF",
      description:
        "Renvoie le contenu complet d'une ou plusieurs notes, ou le texte extrait de documents PDF (chemins depuis la racine du coffre, extension comprise). " +
        "Un long PDF est tronqué : la réponse indique alors quelles `pages` redemander.",
      inputSchema: {
        chemins: z.array(z.string()).min(1).max(30),
        pages: z.string().optional().describe("Pour les PDF seulement : pages à lire, ex : « 3 », « 2-5 », « 1,4-6 ». Par défaut, depuis la page 1."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ chemins, pages }) => {
      try {
        const out = await withVault(async () => {
          const parts: string[] = [];
          // Budget de texte partagé entre les PDF demandés dans le même appel.
          const maxChars = Math.floor(80_000 / Math.max(1, chemins.filter(isPdf).length));
          for (const c of chemins) {
            const abs = await resolveInVault(c);
            if (!existsSync(abs)) parts.push(`===== ${c} =====\n(introuvable)`);
            else if (isPdf(abs)) {
              let body: string;
              try {
                body = await readPdf(abs, pages, maxChars);
              } catch (e) {
                body = `(PDF illisible : ${e instanceof Error ? e.message : String(e)})`;
              }
              parts.push(`===== ${toRel(abs)} =====\n${body}`);
            } else parts.push(`===== ${toRel(abs)} =====\n${await readText(abs)}`);
          }
          return parts.join("\n\n");
        });
        return text(out);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "chercher",
    {
      title: "Chercher dans le coffre",
      description:
        "Recherche plein texte, insensible aux accents et à la casse, dans les noms et le contenu des notes et des PDF (pour un PDF, chaque ligne trouvée est précédée de sa page). Sert à retrouver un contact (nom, téléphone, ville), un sujet, une objection…",
      inputSchema: {
        texte: z.string().min(2),
        dossier: z.string().default("").describe("Limiter à un dossier, ex : « CRM GPM »"),
        max: z.number().int().min(1).max(100).default(30),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ texte, dossier, max }) => {
      try {
        const out = await withVault(async () => {
          const q = stripAccents(texte);
          const qDigits = texte.replace(/\D/g, "");
          const res: { chemin: string; lignes: string[] }[] = [];
          const hit = (l: string) => stripAccents(l).includes(q) || (qDigits.length >= 6 && l.replace(/\D/g, "").includes(qDigits));
          const files = (await walk(await resolveInVault(dossier))).sort();
          for (const p of files) {
            if (!/\.(md|base|canvas)$/.test(p)) continue;
            const t = await readText(p);
            const nameHit = stripAccents(path.basename(p)).includes(q);
            const lignes = t
              .split("\n")
              .filter(hit)
              .slice(0, 5)
              .map((l) => l.trim().slice(0, 300));
            if (nameHit || lignes.length) res.push({ chemin: toRel(p), lignes });
            if (res.length >= max) break;
          }
          // PDF ensuite : l'extraction du texte est plus lente, on s'arrête après 90 s.
          const debut = Date.now();
          let nonLus = 0;
          for (const p of files) {
            if (!isPdf(p) || res.length >= max) continue;
            const nameHit = stripAccents(path.basename(p)).includes(q);
            const lignes: string[] = [];
            if (Date.now() - debut > 90_000) nonLus++;
            else {
              try {
                (await pdfPages(p)).forEach((page, i) => {
                  for (const l of page.split("\n")) {
                    if (lignes.length < 5 && hit(l)) lignes.push(`p. ${i + 1} : ${excerpt(l, q)}`);
                  }
                });
              } catch {
                // PDF illisible : seul son nom est comparé.
              }
            }
            if (nameHit || lignes.length) res.push({ chemin: toRel(p), lignes });
          }
          if (nonLus) res.push({ chemin: "(recherche incomplète)", lignes: [`${nonLus} PDF non parcourus faute de temps : relancer la même recherche.`] });
          return res;
        });
        return json(out.length ? out : `Aucun résultat pour « ${texte} ».`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "verifier",
    {
      title: "Vérifier les citations de fiches",
      description:
        "Contrôle mécanique de fiches sourcées : chaque citation « > [!quote] [[….pdf#page=N|…]] » doit figurer mot pour mot à la page indiquée du PDF. " +
        "Signale aussi les chiffres affirmés sans appui dans une citation et les PDF modifiés depuis la validation (propriété `empreintes`). " +
        "À lancer après chaque écriture de fiche : une fiche « non conforme » ne doit pas servir à répondre.",
      inputSchema: {
        chemins: z.array(z.string()).max(50).default([]).describe("Fiches à contrôler"),
        dossier: z.string().default("").describe("Ou un dossier entier : toutes les notes contenant au moins une citation"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ chemins, dossier }) => {
      try {
        if (!chemins.length && !dossier) throw new Error("Indiquer `chemins` ou `dossier`.");
        const out = await withVault(async () => {
          const targets: string[] = [];
          for (const c of chemins) targets.push(await resolveInVault(c));
          const fromDir = dossier ? (await walk(await resolveInVault(dossier))).filter((p) => p.endsWith(".md")).sort() : [];
          const res = [];
          for (const abs of targets) {
            if (!existsSync(abs)) res.push({ fiche: toRel(abs), verdict: "non conforme", erreurs: ["Fiche introuvable."] });
            else {
              const md = await readText(abs);
              res.push(await verifierFiche(abs, md, parseProps(md)));
            }
          }
          for (const abs of fromDir) {
            if (targets.includes(abs)) continue;
            const md = await readText(abs);
            if (/^>\s*\[!quote\]/im.test(md)) res.push(await verifierFiche(abs, md, parseProps(md)));
          }
          return res;
        });
        return json(out);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "modifier",
    {
      title: "Modifier le coffre",
      description:
        "Applique une liste d'opérations (créer, écrire, remplacer du texte, mettre à jour des propriétés, ajouter une ligne dans une section, renommer avec mise à jour des liens, supprimer), puis synchronise une seule fois vers les appareils de Stive. Grouper toutes les écritures d'une dictée dans un seul appel. Les opérations s'appliquent dans l'ordre ; en cas d'erreur, celles déjà faites sont quand même synchronisées et l'erreur est signalée.",
      inputSchema: { operations: z.array(Operation).min(1).max(50) },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ operations }) => {
      const done: string[] = [];
      try {
        await exclusive(async () => {
          await sync();
          try {
            for (const o of operations) done.push(await applyOp(o));
          } finally {
            await sync();
          }
        });
        return text(`Synchronisé avec Obsidian.\n${done.map((l) => `- ${l}`).join("\n")}`);
      } catch (e) {
        return fail(`${e instanceof Error ? e.message : e}\nDéjà appliqué et synchronisé :\n${done.map((l) => `- ${l}`).join("\n") || "(rien)"}`);
      }
    },
  );

  return server;
}

export { CRM_ROOT };
