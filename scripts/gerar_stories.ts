/**
 * Gerador de Story — recebe UM produto, gera UMA imagem PNG.
 *
 * Stack: satori (flex/CSS → SVG) + resvg (SVG → PNG). Sem browser.
 * Fontes: Poppins TTF, baixadas do GitHub na 1ª execução e cacheadas.
 *
 * Uso:
 *   # via argumento JSON:
 *   npx tsx scripts/gerar_stories.ts '{"titulo":"...","precoDesconto":"...",...}'
 *
 *   # via stdin (ex: n8n Execute Command):
 *   echo '{"titulo":"..."}' | npx tsx scripts/gerar_stories.ts
 *
 * Saída (stdout): JSON com o caminho do arquivo gerado
 *   {"sucesso":true,"arquivo":"/caminho/stories/story_....png"}
 */

import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import * as fs from "fs";
import * as path from "path";

// ─── Tipos ─────────────────────────────────────────────────────────────────────

interface Produto {
  row_number?:   number;
  titulo:        string;
  descricao?:    string;
  categoria?:    string;
  precoOriginal: string | null;
  precoDesconto: string;
  desconto:      string | null;
  imagem:        string | null;
  link?:         string | null;
  source?:       string;
  linkAfiliado?: string | null;
}

// ─── Configuração ──────────────────────────────────────────────────────────────

const OUTPUT_DIR  = path.resolve(__dirname, "../stories");
const FONTS_CACHE = path.resolve(__dirname, "../.fonts_cache");

// ─── Design tokens ─────────────────────────────────────────────────────────────

const C = {
  bg:         "#0F0F0F",
  laranja:    "#F57C00",
  laranjaClr: "#FF9800",
  branco:     "#FFFFFF",
  cinza:      "#AAAAAA",
  cinzaSub:   "#666666",
} as const;

const GRAD_LARANJA = `linear-gradient(155deg, ${C.laranja} 0%, ${C.laranjaClr} 100%)`;

// ─── Fontes ────────────────────────────────────────────────────────────────────

const POPPINS_TTF: Record<500 | 700 | 800, string> = {
  500: "https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-Medium.ttf",
  700: "https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-Bold.ttf",
  800: "https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-ExtraBold.ttf",
};

async function baixarPoppins(peso: 500 | 700 | 800): Promise<Buffer> {
  const cacheFile = path.join(FONTS_CACHE, `poppins-${peso}.ttf`);
  if (fs.existsSync(cacheFile)) return fs.readFileSync(cacheFile);

  process.stderr.write(`  Baixando Poppins ${peso}...\n`);
  const data = Buffer.from(
    await fetch(POPPINS_TTF[peso]).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} ao baixar Poppins ${peso}`);
      return r.arrayBuffer();
    }),
  );

  fs.mkdirSync(FONTS_CACHE, { recursive: true });
  fs.writeFileSync(cacheFile, data);
  process.stderr.write(`  Poppins ${peso} salva em cache.\n`);
  return data;
}

async function carregarFontes() {
  const [w500, w700, w800] = await Promise.all([
    baixarPoppins(500),
    baixarPoppins(700),
    baixarPoppins(800),
  ]);
  return [
    { name: "Poppins", data: w500, weight: 500 as const },
    { name: "Poppins", data: w700, weight: 700 as const },
    { name: "Poppins", data: w800, weight: 800 as const },
  ];
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function imagemParaBase64(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const buf  = await res.arrayBuffer();
    const mime = res.headers.get("content-type") ?? "image/jpeg";
    return `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
  } catch {
    return null;
  }
}

function extrairPercentual(desconto: string | null): number | null {
  const m = desconto?.match(/(\d+)%/);
  return m ? parseInt(m[1], 10) : null;
}

function extrairCondicao(desconto: string | null): string {
  if (!desconto) return "";
  return desconto.replace(/^\d+%\s*OFF\s*/i, "").trim();
}

// Converte "R$ 1549.00" → "R$ 1.549,00"  /  "R$ 788.50" → "R$ 788,50"
function formatarPreco(preco: string | null): string | null {
  if (!preco) return null;
  if (preco.includes(",")) return preco; // já formatado
  return preco.replace(/([\d.]+)$/, (match) => {
    const num = parseFloat(match);
    return num.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  });
}

function nomeArquivo(produto: Produto): string {
  const id = produto.row_number ?? Date.now();
  const ts = new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-");
  return `story_${id}_${ts}.png`;
}

async function lerStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

// ─── Layout ────────────────────────────────────────────────────────────────────

function gerarLayout(produto: Produto, imgSrc: string): any {
  const percentual = extrairPercentual(produto.desconto);
  const condicao   = extrairCondicao(produto.desconto);
  const precoOrig  = formatarPreco(produto.precoOriginal);
  const precoDesc  = formatarPreco(produto.precoDesconto) ?? produto.precoDesconto;

  return {
    type: "div",
    props: {
      style: {
        display:       "flex",
        flexDirection: "column",
        alignItems:    "center",
        width:         1080,
        height:        1920,
        background:    C.bg,
        padding:       "80px 80px 80px",
        fontFamily:    "Poppins",
      },
      children: [

        // Título (max 2 linhas)
        {
          type: "div",
          props: {
            style: {
              fontSize:        62,
              fontWeight:      800,
              fontFamily:      "Poppins",
              color:           C.branco,
              textAlign:       "center",
              lineHeight:      1.2,
              marginBottom:    60,
              display:         "-webkit-box",
              WebkitLineClamp: "2",
              WebkitBoxOrient: "vertical",
              overflow:        "hidden",
            },
            children: produto.titulo,
          },
        },

        // Imagem do produto (com fade nas bordas)
        {
          type: "div",
          props: {
            style: {
              position:       "relative",
              display:        "flex",
              flex:           1,
              width:          "100%",
              alignItems:     "center",
              justifyContent: "center",
              marginBottom:   60,
              minHeight:      0,
            },
            children: [
              // Imagem
              imgSrc
                ? { type: "img", props: { src: imgSrc, style: { width: "100%", height: "100%", objectFit: "contain" } } }
                : { type: "div", props: { style: { fontSize: 200, color: "#2a2a2a", display: "flex" }, children: "?" } },
              // Fade inferior
              {
                type: "div",
                props: {
                  style: {
                    position:   "absolute",
                    bottom:     0,
                    left:       0,
                    right:      0,
                    height:     "20%",
                    background: `linear-gradient(to bottom, transparent 0%, ${C.bg} 100%)`,
                  },
                  children: "",
                },
              },
              // Fade lateral esquerdo
              {
                type: "div",
                props: {
                  style: {
                    position:   "absolute",
                    top:        0,
                    left:       0,
                    bottom:     0,
                    width:      "12%",
                    background: `linear-gradient(to right, ${C.bg} 0%, transparent 100%)`,
                  },
                  children: "",
                },
              },
              // Fade lateral direito
              {
                type: "div",
                props: {
                  style: {
                    position:   "absolute",
                    top:        0,
                    right:      0,
                    bottom:     0,
                    width:      "12%",
                    background: `linear-gradient(to left, ${C.bg} 0%, transparent 100%)`,
                  },
                  children: "",
                },
              },
              // Fade superior
              {
                type: "div",
                props: {
                  style: {
                    position:   "absolute",
                    top:        0,
                    left:       0,
                    right:      0,
                    height:     "10%",
                    background: `linear-gradient(to top, transparent 0%, ${C.bg} 100%)`,
                  },
                  children: "",
                },
              },
            ],
          },
        },

        // DE preço (riscado)
        precoOrig ? {
          type: "div",
          props: {
            style: {
              display:        "flex",
              fontSize:       52,
              fontWeight:     500,
              fontFamily:     "Poppins",
              color:          C.cinza,
              textDecoration: "line-through",
              marginBottom:   10,
            },
            children: `DE ${precoOrig}`,
          },
        } : null,

        // POR preço
        {
          type: "div",
          props: {
            style: {
              display:       "flex",
              flexDirection: "row",
              alignItems:    "baseline",
              marginBottom:  condicao ? 16 : 0,
            },
            children: [
              {
                type: "span",
                props: {
                  style: { fontSize: 96, fontWeight: 800, fontFamily: "Poppins", color: C.branco, lineHeight: 1 },
                  children: "POR ",
                },
              },
              {
                type: "span",
                props: {
                  style: { fontSize: 96, fontWeight: 800, fontFamily: "Poppins", color: C.laranja, lineHeight: 1 },
                  children: precoDesc,
                },
              },
            ],
          },
        },

        // Condição de pagamento
        condicao ? {
          type: "div",
          props: {
            style: {
              display:       "flex",
              fontSize:      40,
              fontWeight:    700,
              fontFamily:    "Poppins",
              color:         C.laranjaClr,
              textAlign:     "center",
              letterSpacing: 1,
            },
            children: condicao,
          },
        } : null,

      ].filter(Boolean),
    },
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // ── Lê o produto (argumento ou stdin) ───────────────────────────────────────
  let raw: string;
  if (process.argv[2]) {
    raw = process.argv[2];
  } else {
    raw = await lerStdin();
  }

  const produto: Produto = JSON.parse(raw.trim());

  // ── Fontes ──────────────────────────────────────────────────────────────────
  const fonts = await carregarFontes();

  // ── Imagem do produto ────────────────────────────────────────────────────────
  const imgBase64 = produto.imagem ? await imagemParaBase64(produto.imagem) : null;

  // ── Gera SVG → PNG ───────────────────────────────────────────────────────────
  const svg = await satori(gerarLayout(produto, imgBase64 ?? ""), {
    width: 1080,
    height: 1920,
    fonts,
  });

  const png = new Resvg(svg, { fitTo: { mode: "width", value: 1080 } }).render().asPng();

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const caminho = path.join(OUTPUT_DIR, nomeArquivo(produto));
  fs.writeFileSync(caminho, png);

  // ── Saída JSON (para n8n ou qualquer orquestrador) ──────────────────────────
  process.stdout.write(JSON.stringify({ sucesso: true, arquivo: caminho }) + "\n");
}

main().catch((err) => {
  process.stderr.write(`Erro: ${err.message}\n`);
  process.stdout.write(JSON.stringify({ sucesso: false, erro: err.message }) + "\n");
  process.exit(1);
});
