const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuração do Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ ERRO: Variáveis SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórias');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Middlewares de segurança
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Signature', 'User-Agent']
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // Máximo 100 requests por IP por janela
  message: {
    error: 'Muitas requisições. Tente novamente em 15 minutos.',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

// Logging
app.use(morgan('combined'));

// Parse JSON com limite de tamanho
app.use(express.json({ 
  limit: '10mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Middleware para capturar IP real
app.use((req, res, next) => {
  req.clientIP = req.headers['x-forwarded-for'] || 
                 req.headers['x-real-ip'] || 
                 req.connection.remoteAddress || 
                 req.socket.remoteAddress ||
                 (req.connection.socket ? req.connection.socket.remoteAddress : null);
  next();
});

// Função auxiliar para validar token
async function getWebhookByToken(token) {
  const { data, error } = await supabase
    .rpc('get_webhook_by_token', { p_token: token })
    .single();
    
  if (error) {
    console.error('Erro ao buscar webhook:', error);
    return null;
  }
  
  return data;
}

// ✅ Função ÚNICA para processar webhook - reescrita para funcionar 100%
async function processWebhookPayload(webhookId, payload, headers, sourceIP) {
  try {
    console.log('🔄 Processando webhook...');
    
    // Extrair e processar campos detectados para log
    const detectedFields = Object.keys(payload).filter(key => {
      const value = payload[key];
      return value !== null && value !== undefined && value !== '';
    });
    
    console.log('📋 Campos detectados:', detectedFields);
    
    // Preparar dados para a função SQL (4 parâmetros que ela aceita)
    const processedData = {
      p_webhook_endpoint_id: webhookId,
      p_payload: payload,
      p_headers: headers,
      p_source_ip: sourceIP
    };
    
    console.log('📤 Enviando dados para função SQL:', {
      webhook_id: webhookId,
      detected_fields_count: detectedFields.length,
      detected_fields: detectedFields,
      payload_keys: Object.keys(payload)
    });
    
    const { data, error } = await supabase
      .rpc('process_webhook_payload', processedData);
      
    if (error) {
      console.error('❌ Erro na função SQL:', error);
      return {
        success: false,
        error: error.message,
        error_code: error.code
      };
    }
    
    console.log('✅ Webhook processado com sucesso');
    return data;
  } catch (err) {
    console.error('❌ Exceção no processamento:', err);
    return {
      success: false,
      error: err.message,
      error_code: 'PROCESSING_ERROR'
    };
  }
}

// ✅ FUNÇÃO REMOVIDA - Agora usa apenas a função SQL process_webhook_payload reescrita

// Função auxiliar para acessar valores aninhados
function getNestedValue(obj, path) {
  return path.split('.').reduce((current, key) => {
    return current && current[key] !== undefined ? current[key] : null;
  }, obj);
}

// Health Check
app.get('/', (req, res) => {
  res.json({
    service: 'Zionic Webhook Service',
    version: '1.0.0',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    checks: {
      supabase: supabaseUrl ? 'configured' : 'missing',
      memory: process.memoryUsage(),
      uptime: process.uptime()
    }
  });
});

// Endpoint principal do webhook
app.post('/webhook/:token', [
  body().custom((value, { req }) => {
    if (!req.body || Object.keys(req.body).length === 0) {
      throw new Error('Payload JSON é obrigatório');
    }
    return true;
  })
], async (req, res) => {
  try {
    // Validar entrada
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: 'Dados inválidos',
        details: errors.array()
      });
    }

    const { token } = req.params;
    const payload = req.body;
    const headers = req.headers;
    const sourceIP = req.clientIP;

    // Log da requisição
    console.log(`📥 Webhook recebido: ${token} de ${sourceIP}`);
    console.log(`📊 Payload: ${JSON.stringify(payload).substring(0, 200)}...`);

    // Validar token e obter configurações do webhook
    const webhook = await getWebhookByToken(token);
    
    if (!webhook) {
      console.log(`❌ Token inválido: ${token}`);
      return res.status(404).json({
        success: false,
        error: 'Webhook não encontrado',
        code: 'WEBHOOK_NOT_FOUND'
      });
    }

    // Verificar se webhook está ativo
    if (!webhook.is_active) {
      console.log(`⏸️ Webhook inativo: ${token}`);
      return res.status(403).json({
        success: false,
        error: 'Webhook está inativo',
        code: 'WEBHOOK_INACTIVE'
      });
    }

    // ✅ Processar webhook usando APENAS a função SQL reescrita
    const result = await processWebhookPayload(
      webhook.webhook_id,
      payload,
      JSON.stringify(headers), // Converter headers para string JSON
      sourceIP
    );

    // Log do resultado
    if (result.success) {
      console.log(`✅ Webhook processado com sucesso: ${token}`);
      if (result.lead_id) {
        console.log(`🎯 Lead criado: ${result.lead_id}`);
      }
    } else {
      console.log(`❌ Erro no processamento: ${result.error}`);
    }

    // Retornar resposta baseada no modo
    if (webhook.mapping_mode === 'mapping') {
      return res.json({
        success: true,
        mode: 'mapping',
        message: 'Dados de exemplo salvos para mapeamento',
        webhook_name: webhook.name,
        company_id: webhook.company_id
      });
    }

    // Resposta para modo ativo
    return res.json({
      success: result.success,
      message: result.success ? 'Lead processado com sucesso' : result.error,
      data: result.success ? {
        lead_id: result.lead_id,
        contact_id: result.contact_id,
        pipeline_id: result.pipeline_id,
        column_id: result.column_id,
        webhook_name: webhook.name
      } : null,
      error_code: result.success ? null : result.error_code
    });

  } catch (error) {
    console.error('❌ Erro interno:', error);
    return res.status(500).json({
      success: false,
      error: 'Erro interno do servidor',
      code: 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Erro interno'
    });
  }
});

// Endpoint para teste de webhook (desenvolvimento)
app.get('/webhook/:token/test', async (req, res) => {
  try {
    const { token } = req.params;
    
    const webhook = await getWebhookByToken(token);
    
    if (!webhook) {
      return res.status(404).json({
        success: false,
        error: 'Webhook não encontrado'
      });
    }

    return res.json({
      success: true,
      webhook: {
        name: webhook.name,
        is_active: webhook.is_active,
        mapping_mode: webhook.mapping_mode,
        company_id: webhook.company_id
      },
      test_payload_example: {
        customer: {
          name: "João Silva",
          email: "joao@exemplo.com",
          phone: "+5511999999999",
          company: "Empresa Exemplo"
        },
        deal: {
          title: "Negócio de Teste",
          value: 5000,
          source: "Website"
        }
      }
    });
  } catch (error) {
    console.error('Erro no teste:', error);
    return res.status(500).json({
      success: false,
      error: 'Erro interno'
    });
  }
});

// Middleware de tratamento de erros
app.use((error, req, res, next) => {
  console.error('❌ Erro não tratado:', error);
  res.status(500).json({
    success: false,
    error: 'Erro interno do servidor',
    code: 'UNHANDLED_ERROR'
  });
});

// Middleware para rotas não encontradas
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint não encontrado',
    code: 'NOT_FOUND',
    available_endpoints: [
      'GET /',
      'GET /health',
      'POST /webhook/:token',
      'GET /webhook/:token/test'
    ]
  });
});

// Inicializar servidor
app.listen(PORT, () => {
  console.log(`🚀 Zionic Webhook Service rodando na porta ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 Exemplo webhook: http://localhost:${PORT}/webhook/SEU_TOKEN`);
  console.log(`📊 Ambiente: ${process.env.NODE_ENV || 'development'}`);
  
  // Testar conexão com Supabase
  supabase.from('webhook_endpoints').select('count').limit(1)
    .then(() => console.log('✅ Conexão com Supabase OK'))
    .catch(err => console.error('❌ Erro na conexão com Supabase:', err.message));
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM recebido, encerrando servidor...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT recebido, encerrando servidor...');
  process.exit(0);
}); 
