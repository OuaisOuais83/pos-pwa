// Lecture des PDF du coffre : extraction du texte page par page (pdf.js via unpdf).
// Le texte extrait est gardé en mémoire tant que le fichier ne change pas.
import { promises as fs } from "node:fs";
import { extractText, getDocumentProxy } from "unpdf";

const cache = new Map<string, { key: string; pages: string[] }>();

export const isPdf = (p: string) => /\.pdf$/i.test(p);

/** Texte de chaque page d'un PDF (chaîne vide pour une page sans couche texte, ex : scan). */
export async function pdfPages(abs: string): Promise<string[]> {
  const st = await fs.stat(abs);
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = cache.get(abs);
  if (hit && hit.key === key) return hit.pages;
  const pdf = await getDocumentProxy(new Uint8Array(await fs.readFile(abs)));
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = text.map((t) => t.normalize("NFC").trim());
    cache.set(abs, { key, pages });
    return pages;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** « 3 », « 2-5 », « 1,4-6 » → numéros de pages (à partir de 1), bornés au document. */
export function parsePages(spec: string | undefined, total: number): number[] {
  if (!spec || !spec.trim()) return Array.from({ length: total }, (_, i) => i + 1);
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error(`Pages invalides : « ${spec} » (attendu : « 3 », « 2-5 » ou « 1,4-6 »)`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let n = Math.min(a, b); n <= Math.max(a, b); n++) if (n >= 1 && n <= total) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}

/** Rend le texte d'un PDF, limité à `maxChars` : la suite se demande avec `pages`. */
export async function readPdf(abs: string, spec: string | undefined, maxChars: number): Promise<string> {
  const pages = await pdfPages(abs);
  const total = pages.length;
  const wanted = parsePages(spec, total);
  const vides = pages.filter((t) => !t).length;
  const head = [`PDF de ${total} page(s).`];
  if (vides === total) {
    head.push("Aucun texte extractible : ce PDF est un scan (images), son contenu n'est pas lisible par ce connecteur.");
    return head.join(" ");
  }
  if (vides) head.push(`${vides} page(s) sans texte (scans ou images).`);
  const parts: string[] = [];
  let used = 0;
  let stoppedAt: number | null = null;
  for (const n of wanted) {
    const t = pages[n - 1] || "(page sans texte)";
    if (parts.length && used + t.length > maxChars) {
      stoppedAt = n;
      break;
    }
    parts.push(`--- page ${n} ---\n${t}`);
    used += t.length;
  }
  if (stoppedAt !== null) {
    head.push(`Texte tronqué : pour la suite, rappeler \`lire\` avec pages = « ${stoppedAt}-${wanted[wanted.length - 1]} ».`);
  }
  return `${head.join(" ")}\n${parts.join("\n\n")}`;
}
