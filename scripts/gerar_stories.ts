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
 * Saída (stdout): JSON com o nome do arquivo no R2
 *   {"sucesso":true,"arquivo":"story_amazon_1234567890.jpg"}
 */

import "dotenv/config";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import * as fs from "fs";
import * as path from "path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

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

const OUTPUT_DIR      = path.resolve(__dirname, "../stories");
const FONTS_CACHE     = path.resolve(__dirname, "../.fonts_cache");
const TEMPLATES_DIR   = path.resolve(__dirname, "../templates_stories");

// ─── Cloudflare R2 ─────────────────────────────────────────────────────────────

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

async function uploadR2(nome: string, buffer: Buffer): Promise<void> {
  await r2.send(new PutObjectCommand({
    Bucket:      process.env.R2_BUCKET_NAME!,
    Key:         `stories/${nome}`,
    Body:        buffer,
    ContentType: "image/jpeg",
  }));
}

// ─── Design tokens (Figma: MEI clube / Instagram story - 5) ───────────────────

const C = {
  cardBorder:    "#7d2f04",
  branco:        "#FFFFFF",
  textoPrimario: "#1a1a1a",
  precoRiscado:  "#c7c7cc",
  verdeDesconto: "#13a853",
  bgBadge:       "#ecf7ef",
} as const;

// Medidas exatas extraídas do Figma (canvas 1080×1920)
const CARD = { left: 77, top: 266, width: 925, padding: 40 } as const;
const BTN  = { left: 77, top: 1541, width: 925, height: 169 } as const;

// ─── Fontes ────────────────────────────────────────────────────────────────────

const POPPINS_TTF: Record<500 | 600 | 700, string> = {
  500: "https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-Medium.ttf",
  600: "https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-SemiBold.ttf",
  700: "https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-Bold.ttf",
};

async function baixarPoppins(peso: 500 | 600 | 700): Promise<Buffer> {
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
  const [w500, w600, w700] = await Promise.all([
    baixarPoppins(500),
    baixarPoppins(600),
    baixarPoppins(700),
  ]);
  return [
    { name: "Poppins", data: w500, weight: 500 as const },
    { name: "Poppins", data: w600, weight: 600 as const },
    { name: "Poppins", data: w700, weight: 700 as const },
  ];
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function imagemParaBase64(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    // Converte para JPEG: resvg não suporta WebP nem alguns formatos modernos
    const jpeg = await sharp(Buffer.from(buf)).jpeg({ quality: 90 }).toBuffer();
    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  } catch {
    return null;
  }
}

function carregarTemplateBg(source: string | undefined): string {
  const arquivo = source?.toLowerCase() === "amazon"
    ? "template_story_amazon.png"
    : "template_story_mercado_livre.png";
  const buf = fs.readFileSync(path.join(TEMPLATES_DIR, arquivo));
  return `data:image/png;base64,${buf.toString("base64")}`;
}

function extrairPercentual(desconto: string | null): number | null {
  const m = desconto?.match(/(\d+)%/);
  return m ? parseInt(m[1], 10) : null;
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
  const ts = Date.now();
  const plataforma = produto.source?.toLowerCase() === "amazon" ? "amazon" : "ml";
  return `story_${plataforma}_${ts}.jpg`;
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

// Envolve um elemento com uma sombra que acompanha automaticamente seu tamanho.
// Funciona dentro de um flex column — sem position absolute no wrapper externo.
function comSombra(cardStyle: Record<string, any>, children: any[]): any {
  return {
    type: "div",
    props: {
      // position: relative → contexto para a sombra absolute interna
      style: { position: "relative", display: "flex" },
      children: [
        // Sombra: insets negativos fazem ela "vazar" 20px à direita e abaixo
        {
          type: "div",
          props: {
            style: {
              position:        "absolute",
              top:             20,
              left:            20,
              right:           -20,
              bottom:          -20,
              backgroundColor: C.cardBorder,
              borderRadius:    20,
            },
            children: "",
          },
        },
        // Conteúdo real (posterior no DOM → fica na frente da sombra)
        { type: "div", props: { style: cardStyle, children } },
      ],
    },
  };
}

function gerarLayout(produto: Produto, imgSrc: string | null, bgBase64: string): any {
  const percentual = extrairPercentual(produto.desconto);
  const precoOrig  = formatarPreco(produto.precoOriginal);
  const precoDesc  = formatarPreco(produto.precoDesconto) ?? produto.precoDesconto;

  return {
    type: "div",
    props: {
      style: {
        display:         "flex",
        position:        "relative",
        width:           1080,
        height:          1920,
        backgroundImage: `url(${bgBase64})`,
        backgroundSize:  "cover",
        fontFamily:      "Poppins",
      },
      children: [

        // ── Coluna: card + 60px gap + botão (tudo responsivo) ─────────────────
        {
          type: "div",
          props: {
            style: {
              position:      "absolute",
              top:           CARD.top,
              left:          CARD.left,
              width:         CARD.width,
              display:       "flex",
              flexDirection: "column",
              gap:           60,
            },
            children: [

              // ── Card de produto ──────────────────────────────────────────────
              comSombra({
                position:        "relative",
                width:           CARD.width,
                display:         "flex",
                flexDirection:   "column",
                backgroundColor: C.branco,
                borderWidth:     8,
                borderStyle:     "solid",
                borderColor:     C.cardBorder,
                borderRadius:    20,
                padding:         CARD.padding,
              }, [

                // Imagem do produto
                {
                  type: "div",
                  props: {
                    style: {
                      width:          845, // 925 - 2×40 padding
                      height:         594,
                      display:        "flex",
                      alignItems:     "center",
                      justifyContent: "center",
                    },
                    children: imgSrc
                      ? {
                          type: "img",
                          props: {
                            src: imgSrc,
                            style: { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" },
                          },
                        }
                      : {
                          type: "div",
                          props: {
                            style: { fontSize: 120, color: "#e0e0e0", display: "flex" },
                            children: "?",
                          },
                        },
                  },
                },

                // Spacer
                { type: "div", props: { style: { height: 24 }, children: "" } },

                // Título do produto (máx. 3 linhas, altura automática)
                {
                  type: "div",
                  props: {
                    style: {
                      fontSize:        40,
                      fontWeight:      600,
                      color:           C.textoPrimario,
                      lineHeight:      1.5,
                      display:         "-webkit-box",
                      WebkitLineClamp: 3,
                      WebkitBoxOrient: "vertical",
                      overflow:        "hidden",
                    },
                    children: produto.titulo,
                  },
                },

                // Spacer
                { type: "div", props: { style: { height: 12 }, children: "" } },

                // Badge de desconto (condicional)
                ...(percentual
                  ? [{
                      type: "div",
                      props: {
                        style: {
                          display:         "flex",
                          alignSelf:       "flex-start",
                          alignItems:      "center",
                          backgroundColor: C.bgBadge,
                          borderRadius:    10,
                          paddingLeft:     24,
                          paddingRight:    24,
                          paddingTop:      12,
                          paddingBottom:   12,
                        },
                        children: {
                          type: "span",
                          props: {
                            style: { fontSize: 40, fontWeight: 500, color: C.verdeDesconto },
                            children: `${percentual}% OFF`,
                          },
                        },
                      },
                    }]
                  : []),

                // Área de preço (altura automática)
                {
                  type: "div",
                  props: {
                    style: { display: "flex", flexDirection: "column" },
                    children: [
                      ...(precoOrig
                        ? [{
                            type: "div",
                            props: {
                              style: {
                                display:        "flex",
                                fontSize:       48,
                                fontWeight:     600,
                                color:          C.precoRiscado,
                                textDecoration: "line-through",
                              },
                              children: `de ${precoOrig}`,
                            },
                          }]
                        : []),
                      {
                        type: "div",
                        props: {
                          style: {
                            display:    "flex",
                            fontSize:   96,
                            fontWeight: 700,
                            color:      C.textoPrimario,
                            lineHeight: 1,
                          },
                          children: precoDesc,
                        },
                      },
                    ],
                  },
                },

              ]),

              // ── Botão "LINK NA BIO" (60px abaixo do card via gap) ───────────
              comSombra({
                position:        "relative",
                width:           CARD.width,
                height:          BTN.height,
                display:         "flex",
                alignItems:      "center",
                justifyContent:  "center",
                backgroundColor: C.branco,
                borderWidth:     5,
                borderStyle:     "solid",
                borderColor:     C.cardBorder,
                borderRadius:    20,
              }, [{
                type: "span",
                props: {
                  style: {
                    fontSize:      64,
                    fontWeight:    700,
                    color:         C.cardBorder,
                    letterSpacing: 2,
                  },
                  children: "LINK NA BIO",
                },
              }]),

            ],
          },
        },

      ],
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

  // ── Carrega em paralelo: fontes + imagem + background ───────────────────────
  const [fonts, imgBase64, bgBase64] = await Promise.all([
    carregarFontes(),
    produto.imagem ? imagemParaBase64(produto.imagem) : Promise.resolve(null),
    Promise.resolve(carregarTemplateBg(produto.source)),
  ]);

  // ── Gera SVG → PNG → JPEG ────────────────────────────────────────────────────
  const svg  = await satori(gerarLayout(produto, imgBase64, bgBase64), {
    width:  1080,
    height: 1920,
    fonts,
  });

  const png  = new Resvg(svg, { fitTo: { mode: "width", value: 1080 } }).render().asPng();
  const jpeg = await sharp(png).jpeg({ quality: 92 }).toBuffer();

  // ── Upload para o R2 ─────────────────────────────────────────────────────────
  const nome = nomeArquivo(produto);
  await uploadR2(nome, jpeg);

  // ── Saída JSON (para n8n ou qualquer orquestrador) ──────────────────────────
  process.stdout.write(JSON.stringify({ sucesso: true, arquivo: `stories/${nome}` }) + "\n");
}

main().catch((err) => {
  process.stderr.write(`Erro: ${err.message}\n`);
  process.stdout.write(JSON.stringify({ sucesso: false, erro: err.message }) + "\n");
  process.exit(1);
});
