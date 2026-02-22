/**
 * Captura cookies, X-CSRF-Token e Authorization token do Mercado Livre.
 *
 * - Abre Chrome com perfil persistente dedicado ao bot
 * - Remove flags de automação para evitar detecção
 * - Se não estiver logado, aguarda login manual e detecta automaticamente
 *
 * Uso: npm run capturar
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { BrowserContext } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

chromium.use(StealthPlugin());

// ─── Configuração ──────────────────────────────────────────────────────────────

const PROFILE_DIR = path.resolve(__dirname, "../.chrome_profile");
const ENV_FILE = path.resolve(__dirname, "../.env");

dotenv.config({ path: ENV_FILE });

const N8N_BASE_URL = process.env.N8N_BASE_URL ?? "http://localhost:5678";
const N8N_WEBHOOK_PATH = "/webhook/refresh-ml-cookies";

const ML_HOME = "https://www.mercadolivre.com.br";
const ML_AFILIADOS = "https://www.mercadolivre.com.br/afiliados";

const ML_DOMAINS = [
  "mercadolivre.com.br",
  "mercadolibre.com",
  "mercadopago.com.br",
  "meli.com",
];

// ─── Estado capturado ──────────────────────────────────────────────────────────

const captured = {
  csrfToken: null as string | null,
  authToken: null as string | null,
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isML(url: string) {
  return ML_DOMAINS.some((d) => url.includes(d));
}

// ─── Interceptação de requests ─────────────────────────────────────────────────

function registrarInterceptadores(context: BrowserContext) {
  context.on("request", (req) => {
    if (!isML(req.url())) return;
    const h = req.headers();

    if (h["x-csrf-token"] && !captured.csrfToken) {
      captured.csrfToken = h["x-csrf-token"];
      console.log(`  [+] X-CSRF-Token:  ${captured.csrfToken.slice(0, 40)}...`);
    }
    if (h["authorization"] && !captured.authToken) {
      captured.authToken = h["authorization"];
      console.log(`  [+] Authorization: ${captured.authToken.slice(0, 40)}...`);
    }
  });

  context.on("response", (res) => {
    if (!isML(res.url())) return;
    const h = res.headers();

    if (h["x-csrf-token"] && !captured.csrfToken) {
      captured.csrfToken = h["x-csrf-token"];
      console.log(`  [+] X-CSRF-Token (resp): ${captured.csrfToken.slice(0, 40)}...`);
    }
  });
}

// ─── Detecção de login ─────────────────────────────────────────────────────────

function urlEhPaginaDeLogin(url: string): boolean {
  return (
    url.includes("/login") ||
    url.includes("/access") ||
    url.includes("accounts.mercadolivre") ||
    url === "about:blank" ||
    url === ""
  );
}

async function estaLogado(context: BrowserContext): Promise<boolean> {
  const pages = context.pages();
  if (!pages.length) return false;
  const url = pages[0].url();
  return url.includes("mercadolivre.com.br") && !urlEhPaginaDeLogin(url);
}

async function aguardarLogin(context: BrowserContext): Promise<void> {
  const page = context.pages()[0];

  console.log("\nAguardando login no Mercado Livre...");
  console.log("(Faça o login no browser e aguarde — detecção automática)\n");

  await page.waitForFunction(
    () => {
      const url = window.location.href;
      return (
        url.includes("mercadolivre.com.br") &&
        !url.includes("/login") &&
        !url.includes("/access") &&
        !url.includes("accounts.mercadolivre")
      );
    },
    { timeout: 300_000, polling: 2000 }
  );

  console.log("  Login detectado!");
  await sleep(2000);
}

// ─── Persistência ──────────────────────────────────────────────────────────────

function salvarEnv(cookieStr: string) {
  const novas: Record<string, string> = { ML_COOKIE: cookieStr };
  if (captured.csrfToken) novas.ML_CSRF_TOKEN = captured.csrfToken;
  if (captured.authToken) novas.ML_AUTH_TOKEN = captured.authToken;

  let linhasExistentes: string[] = [];
  if (fs.existsSync(ENV_FILE)) {
    linhasExistentes = fs
      .readFileSync(ENV_FILE, "utf-8")
      .split("\n")
      .filter((l) => {
        const chave = l.split("=")[0].trim();
        return chave && !Object.keys(novas).includes(chave);
      });
  }

  const novasLinhas = Object.entries(novas).map(([k, v]) => `${k}="${v}"`);
  fs.writeFileSync(ENV_FILE, [...linhasExistentes, ...novasLinhas].join("\n") + "\n");
}

async function notificarN8n(cookieStr: string) {
  const url = `${N8N_BASE_URL}${N8N_WEBHOOK_PATH}`;
  console.log(`\nNotificando n8n em ${url} ...`);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cookie: cookieStr,
        csrfToken: captured.csrfToken,
        authToken: captured.authToken,
      }),
    });

    if (res.ok) {
      console.log(`  n8n respondeu: ${res.status} ${res.statusText}`);
    } else {
      console.warn(`  n8n retornou status inesperado: ${res.status}`);
    }
  } catch (err) {
    console.warn(`  Falha ao notificar n8n: ${(err as Error).message}`);
    console.warn("  (Verifique se o n8n está rodando e o webhook está ativo)");
  }
}

function imprimirResumo(cookieStr: string) {
  console.log("\n" + "─".repeat(50));
  console.log("RESUMO:");
  console.log(`  Cookie:     ${cookieStr ? `OK  (${cookieStr.length} chars)` : "NÃO CAPTURADO"}`);
  console.log(`  CSRF Token: ${captured.csrfToken ? `OK  — ${captured.csrfToken.slice(0, 25)}...` : "NÃO CAPTURADO"}`);
  console.log(`  Auth Token: ${captured.authToken ? `OK  — ${captured.authToken.slice(0, 25)}...` : "NÃO CAPTURADO"}`);
  console.log(`\nSalvo em: ${ENV_FILE}`);
  console.log("─".repeat(50) + "\n");
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  console.log("─".repeat(50));
  console.log("Bot Afiliados — Captura de Credenciais");
  console.log("─".repeat(50) + "\n");

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: false,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--start-maximized",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    viewport: null,
  });

  registrarInterceptadores(context);

  const page = context.pages()[0] ?? (await context.newPage());

  // Abre pela home primeiro — navegar direto para /afiliados é suspeito
  console.log(`Navegando para ${ML_HOME} ...`);
  try {
    await page.goto(ML_HOME, { waitUntil: "domcontentloaded", timeout: 120_000 });
  } catch (err) {
    console.warn(`  Aviso: ${(err as Error).message}`);
  }

  console.log(`  URL atual: ${page.url()}`);

  if (await estaLogado(context)) {
    console.log("  Sessão ativa detectada — sem necessidade de login.");
  } else {
    console.log("  Não logado. Aguarde o login manual...");
    await aguardarLogin(context);
  }

  // Navega para /afiliados via JS
  console.log(`\nNavegando para ${ML_AFILIADOS} ...`);
  await sleep(1500);
  await page.evaluate((url) => { window.location.href = url; }, ML_AFILIADOS);
  try {
    await page.waitForURL(`**afiliados**`, { timeout: 120_000 });
  } catch (err) {
    console.warn(`  Aviso ao aguardar URL: ${(err as Error).message}`);
  }
  await page.waitForLoadState("domcontentloaded");

  // Clica em "Compartilhar" para capturar o token
  console.log("\nClicando em 'Compartilhar' para capturar o token...");
  try {
    const botaoCompartilhar = page.getByRole("button", { name: /compartilhar/i }).first();
    await botaoCompartilhar.waitFor({ timeout: 30_000 });
    await botaoCompartilhar.click();
    console.log("  Clique realizado.");
  } catch {
    try {
      await page.locator("text=Compartilhar").first().click();
      console.log("  Clique realizado (seletor alternativo).");
    } catch {
      console.log("  Botão 'Compartilhar' não encontrado — pulando.");
    }
  }

  console.log("  Aguardando token nas requisições...");
  const TOKEN_TIMEOUT = 15_000;
  const inicio = Date.now();
  while (!captured.csrfToken && !captured.authToken) {
    if (Date.now() - inicio > TOKEN_TIMEOUT) {
      console.log("  Tokens não encontrados. Salvando só os cookies.");
      break;
    }
    await sleep(300);
  }

  console.log("\nCapturando cookies do Mercado Livre...");

  const todosCookies = await context.cookies();
  console.log(`  Total de cookies encontrados: ${todosCookies.length}`);

  const mlCookies = todosCookies.filter((c) =>
    ML_DOMAINS.some((d) => c.domain.includes(d))
  );
  console.log(`  Cookies do ML: ${mlCookies.length}`);
  console.log(`  Nomes: ${mlCookies.map((c) => c.name).join(", ")}`);

  const cookieStr = mlCookies.map((c) => `${c.name}=${c.value}`).join("; ");

  salvarEnv(cookieStr);
  await notificarN8n(cookieStr);
  imprimirResumo(cookieStr);

  await context.close();
  console.log("Browser fechado.");
}

main().catch((err) => {
  console.error("\nErro fatal:", err.message);
  process.exit(1);
});
