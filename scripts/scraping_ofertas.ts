/**
 * Scraping das Ofertas do Dia do Mercado Livre.
 *
 * Fluxo:
 *   1. Abre https://www.mercadolivre.com.br/ofertas
 *   2. Raspa todos os produtos da página 1
 *   3. Salva em ofertas/ofertas_YYYY-MM-DD_HH-MM.json
 *
 * Uso: npm run ofertas
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import * as fs from "fs";
import * as path from "path";

chromium.use(StealthPlugin());

// ─── Tipos (espelho do schema public.products) ──────────────────────────────────

interface Produto {
  external_id:    string;
  slug:           string;
  title:          string;
  desc:           string;
  category:       string;
  original_price: number | null;
  current_price:  number;
  discount:       number | null;  // inteiro, ex: 68
  image:          string | null;
  product_link:   string | null;
  source:         "mercadolivre";
  status:         "scraped";
}

// ─── Configuração ──────────────────────────────────────────────────────────────

const ML_OFERTAS = "https://www.mercadolivre.com.br/ofertas";
const OUTPUT_DIR = path.resolve(__dirname, "../ofertas");

// ─── Ocultar janela ────────────────────────────────────────────────────────────
// true  → Chrome abre fora da tela (invisível)
// false → Chrome abre normalmente (útil para debug)
const OCULTAR_JANELA = true;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Extrai o slug e o id do produto a partir da URL
// Ex: "www.mercadolivre.com.br/celular-samsung/p/MLB44372580"
//  → slug: "celular-samsung", productId: "MLB44372580"
// Ex: "www.mercadolivre.com.br/celular-samsung/MLB5206936778"
//  → slug: "celular-samsung", productId: "MLB5206936778"
function extrairSlugEId(url: string): { slug: string; productId: string | null } {
  try {
    const partes = url.replace(/^https?:\/\//, "").split("/").filter(Boolean);
    // Remove o domínio (primeiro elemento)
    partes.shift();

    // Procura segmento que parece um ID do ML (MLB + dígitos)
    const idIndex = partes.findIndex((p) => /^MLB\d+$/i.test(p));

    if (idIndex !== -1) {
      // Slug é tudo antes do id, ignorando segmentos como "p" ou "up"
      const slugPartes = partes.slice(0, idIndex).filter((p) => p !== "p" && p !== "up");
      return {
        slug:      slugPartes.join("/") || partes[0] || "",
        productId: partes[idIndex],
      };
    }

    // Sem ID na URL — slug é o primeiro segmento
    return { slug: partes[0] ?? "", productId: null };
  } catch {
    return { slug: "", productId: null };
  }
}

// ─── Extração via JSON embutido ────────────────────────────────────────────────

async function rasparProdutos(page: import("playwright").Page): Promise<Produto[]> {
  const raw = await page.evaluate(() => {
    // Tentativa 1: window._n já exposto como global
    const fromWindow = (window as any)._n?.ctx?.r?.appProps?.pageProps?.data;
    if (fromWindow) return fromWindow;

    // Tentativa 2: ler e executar o conteúdo do script tag
    const scriptEl = document.querySelector("#__NORDIC_RENDERING_CTX__");
    if (!scriptEl?.textContent) return { _erro: "script tag não encontrado" };

    try {
      const _n = { ctx: { r: {} as any } };
      // eslint-disable-next-line no-new-func
      new Function("_n", scriptEl.textContent)(_n);
      return _n.ctx.r?.appProps?.pageProps?.data ?? { _erro: "data não encontrado em _n.ctx.r" };
    } catch (e) {
      return { _erro: String(e) };
    }
  });

  // Salva debug para diagnóstico
  const debugPath = path.join(OUTPUT_DIR, "_debug_pagina1.json");
  fs.writeFileSync(debugPath, JSON.stringify(raw, null, 2), "utf-8");
  process.stderr.write(`  [debug] JSON bruto salvo em: ${debugPath}\n`);

  if (!raw || raw._erro) {
    process.stderr.write(`  Falha ao extrair dados: ${raw?._erro ?? "raw nulo"}\n`);
    return [];
  }

  const items: any[] = raw.items ?? raw.results ?? [];

  if (items.length === 0) {
    process.stderr.write("  Nenhum item encontrado. Verifique _debug_pagina1.json.\n");
    return [];
  }

  // Busca um componente pelo tipo dentro de item.card.components
  const comp = (item: any, tipo: string) =>
    item.card?.components?.find((c: any) => c.type === tipo)?.[tipo] ?? null;

  return items.map((item: any): Produto => {
    const metadata  = item.card?.metadata ?? {};
    const preco     = comp(item, "price");
    const seller    = comp(item, "seller");
    const highlight = comp(item, "highlight");

    const currentPrice  = preco?.current_price?.value ?? null;
    const previousPrice = preco?.previous_price?.value ?? null;
    const discountText  = preco?.discount_label?.text ?? null;
    const discount      = discountText ? (parseInt(discountText.match(/(\d+)/)?.[1] ?? "0") || null) : null;

    // Imagem via ML CDN
    const pictureId = item.card?.pictures?.pictures?.[0]?.id ?? null;
    const image     = pictureId
      ? `https://http2.mlstatic.com/D_NQ_NP_${pictureId}-F.jpg`
      : null;

    const urlBase      = metadata.url ?? "";
    const product_link = metadata.id
      ? `https://produto.mercadolivre.com.br/${metadata.id}`
      : null;

    const { slug } = extrairSlugEId(urlBase);

    const desc = seller?.text?.replace(/\{[^}]+\}/g, "").trim()
      ?? highlight?.text
      ?? "";

    return {
      external_id:    metadata.id ?? "",
      slug,
      title:          comp(item, "title")?.text ?? "",
      desc,
      category:       metadata.vertical ?? "",
      original_price: previousPrice ?? null,
      current_price:  currentPrice ?? 0,
      discount,
      image,
      product_link,
      source:         "mercadolivre",
      status:         "scraped",
    };
  }).filter((p) => p.title.length > 0);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  process.stderr.write("─".repeat(50) + "\n");
  process.stderr.write("Bot Afiliados — Scraping Ofertas do Dia\n");
  process.stderr.write("─".repeat(50) + "\n\n");

  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    args: [
      "--no-first-run",
      ...(OCULTAR_JANELA
        ? ["--window-position=-10000,0"]
        : ["--start-maximized"]),
    ],
  });

  const context = await browser.newContext({ viewport: null });
  const page    = await context.newPage();

  process.stderr.write(`Abrindo ${ML_OFERTAS} ...\n\n`);
  await page.goto(ML_OFERTAS, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await sleep(2000);

  const produtos = await rasparProdutos(page);
  process.stderr.write(`  ${produtos.length} produto(s) encontrado(s).\n`);

  await browser.close();

  // ── Saída limpa para o n8n ───────────────────────────────────────────────────
  process.stdout.write(JSON.stringify({ sucesso: true, total: produtos.length, produtos }) + "\n");
}

main().catch((err) => {
  process.stderr.write(`\nErro fatal: ${err.message}\n`);
  process.stdout.write(JSON.stringify({ sucesso: false, erro: err.message }) + "\n");
  process.exit(1);
});
