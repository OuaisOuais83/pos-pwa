// Lecture et modification des notes Markdown d'Obsidian (propriétés YAML,
// sections, liens), en gardant le format existant autant que possible.
import YAML from "yaml";

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(text: string): { fm: string | null; body: string } {
  const m = text.match(FM_RE);
  if (!m) return { fm: null, body: text };
  return { fm: m[1], body: text.slice(m[0].length) };
}

/** Propriétés d'une note sous forme d'objet simple (dates gardées en texte). */
export function parseProps(text: string): Record<string, unknown> {
  const { fm } = splitFrontmatter(text);
  if (!fm) return {};
  try {
    const v = YAML.parse(fm, { schema: "core" });
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Fusionne des propriétés dans le frontmatter. Une valeur null supprime la
 * propriété. L'ordre et le style des propriétés existantes sont conservés.
 */
export function setProps(text: string, props: Record<string, unknown>): string {
  const { fm, body } = splitFrontmatter(text);
  const doc = YAML.parseDocument(fm ?? "", { schema: "core" });
  if (!doc.contents) doc.contents = doc.createNode({}) as never;
  for (const [k, v] of Object.entries(props)) {
    if (v === null) doc.delete(k);
    else doc.set(k, v);
  }
  let out = doc.toString({ nullStr: "", lineWidth: 0, flowCollectionPadding: false }).replace(/\n+$/, "");
  out = out.replace(/:[ \t]+$/gm, ":");
  return `---\n${out}\n---\n${body}`;
}

/**
 * Ajoute une ligne à la fin d'une section « ## Titre » (avant la section
 * suivante). La section est créée en fin de note si elle n'existe pas.
 */
export function appendToSection(text: string, section: string, line: string): string {
  const lines = text.split("\n");
  const title = section.replace(/^#+\s*/, "").trim().toLowerCase();
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, "").trim().toLowerCase() === title);
  if (start === -1) {
    const trimmed = text.replace(/\s+$/, "");
    return `${trimmed}\n\n## ${section.replace(/^#+\s*/, "").trim()}\n${line}\n`;
  }
  const level = (lines[start].match(/^#+/) ?? ["##"])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  // Dernière ligne non vide de la section ; on remplace une puce vide « - » s'il y en a une.
  let insertAt = end;
  while (insertAt > start + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  if (insertAt > start + 1 && /^\s*-\s*$/.test(lines[insertAt - 1])) {
    lines[insertAt - 1] = line;
  } else {
    lines.splice(insertAt, 0, line);
  }
  return lines.join("\n");
}

/** Remplace les liens [[Ancien]], [[Ancien|alias]], [[Ancien#titre]] par le nouveau nom. */
export function renameLinks(text: string, oldName: string, newName: string): string {
  const esc = oldName.normalize("NFC").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\[\\[(?:[^\\]|#]*/)?${esc}((?:#[^\\]|]*)?(?:\\|[^\\]]*)?)\\]\\]`, "g");
  return text.normalize("NFC").replace(re, (_m, rest: string) => `[[${newName}${rest}]]`);
}

export function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
