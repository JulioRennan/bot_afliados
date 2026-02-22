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

// ─── Tipos ─────────────────────────────────────────────────────────────────────

interface Produto {
  itemId:        string;        // ex: MLB5206936778
  productId:     string | null; // ex: MLB44372580
  slug:          string;        // ex: celular-samsung-galaxy-a16-...
  titulo:        string;
  descricao:     string;
  categoria:     string;
  precoOriginal: string | null;
  precoDesconto: string;
  desconto:      string | null;
  imagem:        string | null;
  link:          string | null;
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

function nomeArquivo(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const data = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const hora = `${pad(now.getHours())}-${pad(now.getMinutes())}`;
  return `ofertas_${data}_${hora}.json`;
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
  console.log(`  [debug] JSON bruto salvo em: ${debugPath}`);

  if (!raw || raw._erro) {
    console.warn(`  Falha ao extrair dados: ${raw?._erro ?? "raw nulo"}`);
    return [];
  }

  const items: any[] = raw.items ?? raw.results ?? [];

  if (items.length === 0) {
    console.warn("  Nenhum item encontrado. Verifique _debug_pagina1.json.");
    return [];
  }

  // Busca um componente pelo tipo dentro de item.card.components
  const comp = (item: any, tipo: string) =>
    item.card?.components?.find((c: any) => c.type === tipo)?.[tipo] ?? null;

  return items.map((item: any): Produto => {
    const metadata = item.card?.metadata ?? {};
    const titulo   = comp(item, "title")?.text ?? "";
    const preco    = comp(item, "price");
    const seller   = comp(item, "seller");
    const highlight = comp(item, "highlight");

    const precoDesconto = preco?.current_price?.value ?? null;
    const precoOriginal = preco?.previous_price?.value ?? null;
    const desconto      = preco?.discount_label?.text ?? null;

    // Imagem via ML CDN
    const pictureId = item.card?.pictures?.pictures?.[0]?.id ?? null;
    const imagem    = pictureId
      ? `https://http2.mlstatic.com/D_NQ_NP_${pictureId}-F.jpg`
      : null;

    // Link limpo (sem fragmentos de tracking)
    const urlBase = metadata.url ?? "";
    const link    = urlBase ? `https://${urlBase}` : null;

    // Slug e productId extraídos da URL
    const { slug, productId: slugProductId } = extrairSlugEId(urlBase);

    // productId: prefere metadata.product_id, fallback para o extraído da URL
    const productId = metadata.product_id ?? slugProductId ?? null;

    // Descrição: vendedor ou highlight
    const descricao = seller?.text?.replace(/\{[^}]+\}/g, "").trim()
      ?? highlight?.text
      ?? "";

    return {
      itemId:        metadata.id ?? "",
      productId,
      slug,
      titulo,
      descricao,
      categoria:     metadata.vertical ?? "",
      precoOriginal: precoOriginal != null ? `R$ ${precoOriginal.toFixed(2)}` : null,
      precoDesconto: precoDesconto != null ? `R$ ${precoDesconto.toFixed(2)}` : "",
      desconto,
      imagem,
      link,
    };
  }).filter((p) => p.titulo.length > 0);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log("─".repeat(50));
  console.log("Bot Afiliados — Scraping Ofertas do Dia");
  console.log("─".repeat(50) + "\n");

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

  console.log(`Abrindo ${ML_OFERTAS} ...\n`);
  await page.goto(ML_OFERTAS, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await sleep(2000);

  const produtos = await rasparProdutos(page);
  console.log(`  ${produtos.length} produto(s) encontrado(s).`);

  await browser.close();

  const saida = {
    capturadoEm:   new Date().toISOString(),
    totalProdutos: produtos.length,
    produtos,
  };

  const arquivo = path.join(OUTPUT_DIR, nomeArquivo());
  fs.writeFileSync(arquivo, JSON.stringify(saida, null, 2), "utf-8");

  console.log("\n" + "─".repeat(50));
  console.log(`Total capturado: ${produtos.length} produto(s)`);
  console.log(`Salvo em: ${arquivo}`);
  console.log("─".repeat(50) + "\n");
}

main().catch((err) => {
  console.error("\nErro fatal:", err.message);
  process.exit(1);
});
