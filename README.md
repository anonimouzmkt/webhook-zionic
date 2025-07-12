# 🔗 Zionic Webhook Service

Serviço de webhook para integração automática de leads no Zionic CRM via mapeamento de campos personalizados.

## 🚀 Deploy no Render

### 1. Configurações do Render

- **Service Type:** Web Service
- **Repository:** `https://github.com/anonimozmkt/webhook-zionic`
- **Branch:** `main`
- **Root Directory:** `webhook-api`
- **Build Command:** `npm install`
- **Start Command:** `npm start`

### 2. Variáveis de Ambiente (Environment Variables)

```bash
SUPABASE_URL=https://sua-url-do-supabase.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua-service-role-key-aqui
NODE_ENV=production
ALLOWED_ORIGINS=https://app.zionic.com
```

## 🔧 Desenvolvimento Local

### 1. Instalação

```bash
# Clonar repositório
git clone https://github.com/anonimozmkt/webhook-zionic.git
cd webhook-zionic/webhook-api

# Instalar dependências
npm install

# Configurar variáveis de ambiente
cp .env.example .env
# Edite o arquivo .env com suas configurações

# Executar em modo desenvolvimento
npm run dev
```

### 2. Configuração do Supabase

1. Acesse seu projeto no Supabase
2. Vá em Settings > API
3. Copie a **URL** e a **service_role key**
4. Configure no arquivo `.env`:

```bash
SUPABASE_URL=https://abcdefghijklmnop.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## 📋 Como Usar

### 1. Criar Webhook no Zionic

1. Acesse **Configurações > Integrações**
2. Clique em **Novo Webhook**
3. Dê um nome: ex: "RD Station"
4. Copie a URL gerada: `https://zionic-webhooks.onrender.com/webhook/abc123...`

### 2. Configurar Mapeamento

1. **Ative o modo "Mapeamento"** no webhook
2. **Envie um payload de teste** para a URL
3. **Configure os mapeamentos** de campo:
   - `lead.name` → `contact_name`
   - `lead.email` → `contact_email`
   - `deal.value` → `estimated_value`
4. **Ative o webhook** (modo "Ativo")

### 3. Payload de Exemplo

```json
{
  "lead": {
    "name": "João Silva",
    "email": "joao@empresa.com",
    "phone": "+5511999999999",
    "company": "Empresa XYZ"
  },
  "deal": {
    "title": "Interesse no produto",
    "value": 5000,
    "source": "Website"
  },
  "utm": {
    "source": "google",
    "medium": "cpc",
    "campaign": "vendas"
  }
}
```

## 🔍 Endpoints

### `POST /webhook/:token`
Endpoint principal para receber webhooks.

**Resposta de sucesso:**
```json
{
  "success": true,
  "message": "Lead processado com sucesso",
  "data": {
    "lead_id": "uuid-do-lead",
    "contact_id": "uuid-do-contato",
    "webhook_name": "RD Station"
  }
}
```

### `GET /webhook/:token/test`
Testa configurações do webhook.

### `GET /health`
Health check do serviço.

## 🛡️ Segurança

- ✅ Rate limiting: 100 requests por 15 minutos
- ✅ Validação de payload JSON
- ✅ Headers de segurança (Helmet)
- ✅ CORS configurável
- ✅ Logs detalhados
- ✅ Validação de token único

## 📊 Monitoramento

### Logs Importantes

```bash
📥 Webhook recebido: abc123 de 192.168.1.1
✅ Webhook processado com sucesso: abc123
🎯 Lead criado: uuid-do-lead
❌ Erro no processamento: Required field missing
```

### Métricas Disponíveis

- Total de requests
- Requests bem-sucedidos
- Requests falharam
- Tempo de processamento
- Última requisição

## 🔧 Troubleshooting

### Problema: Webhook não encontrado
```json
{
  "success": false,
  "error": "Webhook não encontrado",
  "code": "WEBHOOK_NOT_FOUND"
}
```
**Solução:** Verifique se o token na URL está correto.

### Problema: Campo obrigatório faltando
```json
{
  "success": false,
  "error": "Required field missing: customer.email"
}
```
**Solução:** Configure o mapeamento de campos ou adicione valor padrão.

### Problema: Rate limit
```json
{
  "error": "Muitas requisições. Tente novamente em 15 minutos.",
  "code": "RATE_LIMIT_EXCEEDED"
}
```
**Solução:** Aguarde ou distribua as requisições ao longo do tempo.

## 🏗️ Arquitetura

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Sistema       │    │  Webhook Service │    │    Supabase     │
│   Externo       │───▶│  (Render.com)    │───▶│   Database      │
│  (RD Station)   │    │                  │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                              │
                              ▼
                       ┌──────────────────┐
                       │  Zionic CRM      │
                       │  (Frontend)      │
                       └──────────────────┘
```

## 📝 Changelog

### v1.0.0
- ✅ Webhook endpoints únicos por empresa
- ✅ Mapeamento de campos personalizável
- ✅ Modo mapping para configuração
- ✅ Criação automática de leads e contatos
- ✅ Sistema de logs e métricas
- ✅ Integração completa com Supabase

## 🤝 Contribuindo

1. Fork o projeto
2. Crie uma branch: `git checkout -b feature/nova-funcionalidade`
3. Commit suas mudanças: `git commit -m 'Adiciona nova funcionalidade'`
4. Push para a branch: `git push origin feature/nova-funcionalidade`
5. Abra um Pull Request

## 📄 Licença

MIT License - veja [LICENSE](LICENSE) para detalhes. 
