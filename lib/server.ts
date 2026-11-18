// Définition du serveur MCP « Coffre Obsidian » : les outils que Claude voit.
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { exclusive, sync, resolveInVault, toRel, walk, readText, writeText, VAULT_DIR } from "./vault.js";
import { parseProps, setProps, appendToSection, renameLinks, stripAccents } from "./markdown.js";
import { etatCrm, todayParis, CRM_ROOT } from "./crm.js";

const INSTRUCTIONS = `Connecteur du coffre Obsidian « Vie » de Stive (synchronisé par Obsidian Sync : ce que tu écris arrive sur son iPhone, son iPad et son Mac).
Deux espaces : « CRM GPM » (CRM commercial prévoyance GPM) et « Garde-robe ».
- Avant d'écrire dans le CRM, appelle \`regles\` (domaine crm) et applique « Règles de traitement » à la lettre : Échange + mise à jour de la fiche Contact + ligne d'Historique + tâches \`- [ ] Action [[Nom]] [due:: AAAA-MM-JJ]\` + Échéances.
- Stive dicte en vrac : tu ranges sans lui reposer de questions, sauf nom ou date ambigus.
- Groupe toutes les modifications d'une dictée dans UN seul appel à \`modifier\`.
- Pour le brief du matin ou une revue : \`etat_crm\`, puis écris la note dans « CRM GPM/Briefs » au format des briefs existants.
- Jamais de données de santé d'un contact dans le coffre.
- Dates au format AAAA-MM-JJ, fuseau Europe/Paris.`;

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 1));
const fail = (e: unknown) => ({ ...text(`Erreur : ${e instanceof Error ? e.message : String(e)}`), isError: true });

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
    .enum(["ecrire", "creer", "remplacer", "proprietes", "ajouter_ligne", "renommer", "supprimer"])
    .describe(
      "ecrire = créer ou écraser la note avec `contenu` ; creer = comme ecrire mais échoue si la note existe ; " +
        "remplacer = remplacer le texte exact `ancien` par `nouveau` (doit apparaître une seule fois) ; " +
        "proprietes = fusionner `proprietes` dans le frontmatter (null supprime une propriété) ; " +
        "ajouter_ligne = ajouter `ligne` à la fin de la section `section` (ex : « Historique », « Actions ») ; " +
        "renommer = déplacer/renommer vers `nouveau_chemin` et mettre à jour tous les liens [[...]] du coffre ; " +
        "supprimer = supprimer la note (récupérable dans l'historique Obsidian Sync).",
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
        "Liste les notes d'un dossier du coffre (récursif), avec leurs propriétés principales. Ex : « CRM GPM/Contacts », « CRM GPM/Échéances », « Garde-robe/Pièces ». Dossier vide = tout le coffre (chemins seulement).",
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
            res.push(p.endsWith(".md") ? { chemin: toRel(p), ...parseProps(await readText(p)) } : { chemin: toRel(p) });
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
      title: "Lire des notes",
      description: "Renvoie le contenu complet d'une ou plusieurs notes (chemins depuis la racine du coffre, extension comprise).",
      inputSchema: { chemins: z.array(z.string()).min(1).max(30) },
      annotations: { readOnlyHint: true },
    },
    async ({ chemins }) => {
      try {
        const out = await withVault(async () => {
          const parts: string[] = [];
          for (const c of chemins) {
            const abs = await resolveInVault(c);
            parts.push(
              existsSync(abs) ? `===== ${toRel(abs)} =====\n${await readText(abs)}` : `===== ${c} =====\n(introuvable)`,
            );
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
        "Recherche plein texte, insensible aux accents et à la casse, dans les noms et le contenu des notes. Sert à retrouver un contact (nom, téléphone, ville), un sujet, une objection…",
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
          for (const p of (await walk(await resolveInVault(dossier))).sort()) {
            if (!/\.(md|base|canvas)$/.test(p)) continue;
            const t = await readText(p);
            const nameHit = stripAccents(path.basename(p)).includes(q);
            const lignes = t
              .split("\n")
              .filter((l) => stripAccents(l).includes(q) || (qDigits.length >= 6 && l.replace(/\D/g, "").includes(qDigits)))
              .slice(0, 5)
              .map((l) => l.trim().slice(0, 300));
            if (nameHit || lignes.length) res.push({ chemin: toRel(p), lignes });
            if (res.length >= max) break;
          }
          return res;
        });
        return json(out.length ? out : `Aucun résultat pour « ${texte} ».`);
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
