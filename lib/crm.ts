// Portage de « CRM GPM/_système/crm_data.py » : extraction déterministe de
// tout ce qui est daté dans le CRM, pour les briefs et les revues.
import path from "node:path";
import { VAULT_DIR, walk, readText, resolveInVault } from "./vault.js";
import { parseProps, splitFrontmatter } from "./markdown.js";

export const CRM_ROOT = "CRM GPM";

type Note = Record<string, unknown> & { _nom: string; _path: string; _body: string };

/** Date du jour à Paris, au format AAAA-MM-JJ. */
export function todayParis(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
}

function d(v: unknown): Date | null {
  const s = String(v ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = new Date(`${s}T00:00:00Z`);
  return isNaN(t.getTime()) ? null : t;
}
const DAY = 86_400_000;
const days = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / DAY);
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

async function load(folder: string): Promise<Note[]> {
  const dir = await resolveInVault(`${CRM_ROOT}/${folder}`);
  const out: Note[] = [];
  for (const p of await walk(dir)) {
    if (!p.endsWith(".md")) continue;
    const txt = await readText(p);
    out.push({
      ...parseProps(txt),
      _nom: path.basename(p, ".md").normalize("NFC"),
      _path: path.relative(VAULT_DIR, p),
      _body: splitFrontmatter(txt).body,
    });
  }
  return out;
}

function linkName(v: unknown): string {
  const m = str(v).match(/\[\[([^\]|#]+)/);
  return (m ? m[1] : str(v)).normalize("NFC");
}

export async function etatCrm(jours = 7) {
  const TODAY = d(todayParis())!;
  const plus = (n: number) => new Date(TODAY.getTime() + n * DAY);

  const [contacts, echeances, echanges, mantras] = await Promise.all([
    load("Contacts"),
    load("Échéances"),
    load("Échanges"),
    load("Mantras"),
  ]);

  const tasks: { texte: string; due: string; note: string; retard_jours: number }[] = [];
  for (const folder of ["Contacts", "Échanges", "Échéances", "Structures"]) {
    for (const p of await walk(await resolveInVault(`${CRM_ROOT}/${folder}`))) {
      if (!p.endsWith(".md")) continue;
      for (const line of (await readText(p)).split("\n")) {
        const m = line.match(/^\s*-\s+\[ \]\s+(.*)$/);
        if (!m) continue;
        const due = line.match(/\[due::\s*(\d{4}-\d{2}-\d{2})\]/);
        if (!due) continue;
        tasks.push({
          texte: m[1].replace(/\s*\[(due|scheduled|priority|repeat)::[^\]]*\]/g, "").trim(),
          due: due[1],
          note: path.basename(p, ".md").normalize("NFC"),
          retard_jours: days(TODAY, d(due[1])!),
        });
      }
    }
  }

  const cMin = (c: Note) => ({
    nom: c._nom,
    type: c.type,
    statut: c.statut,
    priorite: c.priorite,
    profession: c.profession,
    ville: c.ville,
    telephone: c.telephone,
    besoins: c.besoins,
    prochaine_action: c.prochaine_action,
    prochaine_action_texte: c.prochaine_action_texte,
    dernier_contact: c.dernier_contact,
    rdv: c.rdv,
    rdv_lieu: c.rdv_lieu,
    potentiel: c.potentiel,
    revue_annuelle: c.revue_annuelle,
    contrats_gpm: c.contrats_gpm,
  });
  const byKey = <T>(k: (x: T) => string) => (a: T, b: T) => k(a).localeCompare(k(b));

  const actifs = contacts.filter((c) => !["Signé", "Perdu"].includes(str(c.statut)) && c.type === "Prospect");
  const enCours = (e: Note) => e.statut === "À venir";

  const pipeline: Record<string, string[]> = {};
  for (const c of actifs) (pipeline[str(c.statut) || "Sans statut"] ??= []).push(c._nom);

  const creeLe = (c: Note) => {
    const m = c._body.match(/(\d{2})\/(\d{2})\/(\d{4}) : fiche créée/);
    return m ? d(`${m[3]}-${m[2]}-${m[1]}`) : null;
  };

  return {
    date: todayParis(),
    jours_fenetre: jours,
    taches_retard: tasks.filter((t) => t.retard_jours > 0).sort(byKey((t) => t.due)),
    taches_jour: tasks.filter((t) => t.retard_jours === 0),
    taches_semaine: tasks.filter((t) => t.retard_jours < 0 && t.retard_jours >= -jours).sort(byKey((t) => t.due)),
    a_relancer: contacts
      .filter((c) => d(c.prochaine_action) && d(c.prochaine_action)! <= TODAY && !["Signé", "Perdu"].includes(str(c.statut)))
      .map(cMin)
      .sort(byKey((c) => str(c.prochaine_action))),
    rdv_a_venir: contacts
      .filter((c) => d(c.rdv) && d(c.rdv)! >= TODAY && d(c.rdv)! <= plus(jours))
      .map(cMin)
      .sort(byKey((c) => str(c.rdv))),
    fenetres_ouvertes: echeances
      .filter((e) => enCours(e) && d(e.rappel) && d(e.rappel)! <= TODAY)
      .map((e) => ({
        nom: e._nom,
        contact: linkName(e.contact),
        date: e.date,
        rappel: e.rappel,
        type: e.type,
        produit: e.produit,
        note: e.note,
        jours_restants: d(e.date) ? days(d(e.date)!, TODAY) : null,
      }))
      .sort(byKey((e) => str(e.date))),
    echeances_30j: echeances
      .filter((e) => enCours(e) && d(e.date) && d(e.date)! >= TODAY && d(e.date)! <= plus(30))
      .map((e) => ({ nom: e._nom, contact: linkName(e.contact), date: e.date, type: e.type, produit: e.produit }))
      .sort(byKey((e) => str(e.date))),
    echeances_passees_non_traitees: echeances
      .filter((e) => enCours(e) && d(e.date) && d(e.date)! < TODAY)
      .map((e) => ({ nom: e._nom, contact: linkName(e.contact), date: e.date, type: e.type })),
    propositions_silencieuses: contacts
      .filter((c) => c.statut === "Proposition envoyée" && d(c.dernier_contact) && days(TODAY, d(c.dernier_contact)!) > 10)
      .map(cMin),
    dormants: actifs
      .filter((c) => c.statut !== "Veille" && d(c.dernier_contact) && days(TODAY, d(c.dernier_contact)!) > 30)
      .map((c) => ({ ...cMin(c), jours: days(TODAY, d(c.dernier_contact)!) }))
      .sort((a, b) => b.jours - a.jours),
    clients_revue: contacts
      .filter((c) => c.type === "Client" && d(c.revue_annuelle) && d(c.revue_annuelle)! <= plus(45))
      .map(cMin),
    pipeline,
    hygiene: {
      sans_prochaine_action: actifs.filter((c) => !d(c.prochaine_action)).map((c) => c._nom),
      veille_sans_echeance: contacts
        .filter((c) => c.statut === "Veille" && !echeances.some((e) => linkName(e.contact) === c._nom && enCours(e)))
        .map((c) => c._nom),
      sans_telephone: actifs.filter((c) => !str(c.telephone)).map((c) => c._nom),
      sans_profession: actifs.filter((c) => !str(c.profession)).map((c) => c._nom),
      clients_sans_revue: contacts.filter((c) => c.type === "Client" && !d(c.revue_annuelle)).map((c) => c._nom),
      clients_sans_date_naissance: contacts.filter((c) => c.type === "Client" && !d(c.date_naissance)).map((c) => c._nom),
    },
    semaine: {
      echanges: echanges
        .filter((e) => d(e.date) && d(e.date)! >= plus(-jours))
        .map((e) => ({ nom: e._nom, contact: linkName(e.contact), date: e.date, canal: e.canal, resultat: e.resultat })),
      nouveaux_contacts: contacts.filter((c) => creeLe(c) && creeLe(c)! >= plus(-jours)).map((c) => c._nom),
      signes: contacts
        .filter((c) => c.statut === "Signé" && d(c.client_depuis) && d(c.client_depuis)! >= plus(-jours))
        .map((c) => c._nom),
    },
    mantras: mantras.map((m) => m._nom),
    totaux: {
      contacts: contacts.length,
      prospects_actifs: actifs.length,
      clients: contacts.filter((c) => c.type === "Client").length,
      echeances_a_venir: echeances.filter(enCours).length,
    },
  };
}
