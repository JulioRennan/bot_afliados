# Plano de Desenvolvimento - Bot de Afiliados Mercado Livre

## Visão Geral

Bot de automação para geração de posts de stories no Instagram com links de afiliados do Mercado Livre, orquestrado via n8n.

---

## Arquitetura Geral

```
[n8n Workflow]
      │
      ├── 1. Busca de Produtos (API ML)
      │         └── Termo de busca → Lista de produtos
      │
      ├── 2. Geração de Links de Afiliados (API Interna ML)
      │         └── IDs dos produtos → Links de afiliado
      │
      └── 3. Geração do HTML (Template Stories)
                └── Dados do produto + Link → HTML renderizado
```

---

## Etapas do Projeto

### Etapa 0 — Autenticação (Manual)

> Passo necessário toda vez que o token/cookie expirar.

**Objetivo:** Capturar os cookies de sessão e o token de autorização usado pelas APIs internas do Mercado Livre.

**Processo:**
1. Abrir o browser (Chrome/Firefox) com DevTools aberto na aba **Network**
2. Acessar `https://www.mercadolivre.com.br` e fazer login
3. Navegar até a área de **Afiliados** (ex: `https://www.mercadolivre.com.br/afiliados`)
4. Filtrar as requisições de rede por chamadas à API interna (ex: `/affiliates`, `/partner`)
5. Copiar os headers relevantes:
   - `Cookie` (valor completo da sessão)
   - `Authorization` (Bearer token, se presente)
   - `X-CSRF-Token` ou similares
6. Salvar esses valores num arquivo `.env` local ou numa **credential** do n8n

**Artefatos:**
- `.env` com as variáveis de ambiente:
  ```env
  ML_COOKIE=...
  ML_AUTH_TOKEN=...
  ML_USER_ID=...
  ```

---

### Etapa 1 — Busca de Produtos no Mercado Livre

**API:** Pública (não requer autenticação especial)
```
GET https://api.mercadolibre.com/sites/MLB/search?q={termo}&limit={quantidade}
```

**Parâmetros configuráveis:**
- `q` — termo de busca (ex: "fone bluetooth")
- `limit` — quantidade de produtos a retornar (ex: 5, 10)
- `sort` — ordenação (ex: `price_asc`, `relevance`)

**Resposta relevante por produto:**
```json
{
  "id": "MLB123456789",
  "title": "Nome do Produto",
  "price": 199.90,
  "thumbnail": "https://...",
  "permalink": "https://produto.mercadolivre.com.br/...",
  "seller": { "id": 123, "nickname": "..." }
}
```

**Saída desta etapa:** Lista com N produtos (ID, título, preço, imagem, link original)

---

### Etapa 2 — Geração de Links de Afiliados

**API:** Interna (requer autenticação da Etapa 0)

> A URL exata da API interna será descoberta durante o processo de captura de tráfego da Etapa 0. Provavelmente algo como:
```
POST https://www.mercadolivre.com.br/afiliados/api/links
```
ou via API pública de parceiros:
```
POST https://api.mercadolibre.com/affinity_partner/links
```

**Headers necessários:**
```
Cookie: {ML_COOKIE}
Authorization: Bearer {ML_AUTH_TOKEN}
Content-Type: application/json
```

**Body (estimado):**
```json
{
  "item_id": "MLB123456789",
  "tracking_id": "seu_tracking_id"
}
```

**Resposta esperada:**
```json
{
  "affiliate_link": "https://mercadolivre.com.br/...?aff_id=..."
}
```

**Saída desta etapa:** Link de afiliado para cada produto

---

### Etapa 3 — Geração do HTML (Template Stories)

**Objetivo:** Preencher um template HTML com layout de post para Instagram Stories (proporção 9:16 — 1080x1920px).

**Template base (`template_stories.html`):**
- Imagem do produto em destaque
- Nome do produto (limitado a X caracteres)
- Preço formatado (R$ XX,XX)
- Link de afiliado (encurtado ou como QR code)
- Elementos visuais (badge "OFERTA", CTA "Clique no link da bio", etc.)

**Tecnologia sugerida para renderização:**
- **Opção A:** HTML puro com variáveis `{{placeholder}}` substituídas via n8n (HTTP Request + string replace) — mais simples
- **Opção B:** Serviço local com Puppeteer para converter o HTML em imagem PNG — mais próximo do resultado final

**Variáveis no template:**
```
{{PRODUTO_NOME}}
{{PRODUTO_PRECO}}
{{PRODUTO_IMAGEM}}
{{LINK_AFILIADO}}
{{DATA}}
```

---

## Fluxo n8n Detalhado

```
[Trigger: Manual / Cron / Webhook]
         │
         ▼
[Node 1 - Set] ← Define o termo de busca e quantidade
         │
         ▼
[Node 2 - HTTP Request] ← GET API de busca ML
         │
         ▼
[Node 3 - SplitInBatches] ← Itera sobre cada produto
         │
         ▼
[Node 4 - HTTP Request] ← POST API de afiliados (com Cookie/Token)
         │
         ▼
[Node 5 - Code / Set] ← Monta os dados do produto + link afiliado
         │
         ▼
[Node 6 - HTML Template] ← Preenche o template com os dados
         │
         ▼
[Node 7 - Write Binary File / Send Email / Telegram]
         └── Salva o HTML ou envia para revisão
```

---

## Estrutura de Arquivos do Projeto

```
bot_afiliados/
├── PLANO_DESENVOLVIMENTO.md     # Este arquivo
├── .env                          # Credenciais (não versionar)
├── .env.example                  # Modelo de variáveis
├── templates/
│   └── stories_template.html     # Template HTML do stories
├── scripts/
│   └── capture_cookies.md        # Guia passo a passo da Etapa 0
└── n8n/
    └── workflow_afiliados.json   # Export do workflow n8n
```

---

## Riscos e Considerações

| Risco | Impacto | Mitigação |
|---|---|---|
| Cookie/Token expira com frequência | Alto | Documentar bem o processo de renovação; automatizar captura com Playwright se possível futuramente |
| API interna muda sem aviso | Alto | Manter monitoramento das requisições; ter fallback para API pública de parceiros |
| Rate limit na API de busca | Médio | Respeitar limites; adicionar delay entre requisições no n8n |
| Link de afiliado inválido retornado | Médio | Validar resposta antes de inserir no template |
| TOS do Mercado Livre | Alto | Revisar os termos do programa de afiliados para uso automatizado |

---

## Próximos Passos

- [ ] **Etapa 0:** Fazer o processo manual de login e capturar os cookies/tokens
- [ ] **Etapa 1:** Criar e testar o node de busca de produtos no n8n
- [ ] **Etapa 2:** Identificar a URL exata da API de afiliados via DevTools e criar o node
- [ ] **Etapa 3:** Criar o template HTML do stories
- [ ] **Integração:** Montar o workflow completo no n8n e testar end-to-end
- [ ] **Refinamento:** Ajustar layout do template e possível exportação como imagem (Puppeteer)
