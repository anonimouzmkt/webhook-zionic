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

// Função auxiliar para processar webhook
async function processWebhookPayload(webhookId, payload, headers, sourceIP) {
  try {
    console.log('🔄 Tentando processamento principal...');
    const { data, error } = await supabase
      .rpc('process_webhook_payload', {
        p_webhook_endpoint_id: webhookId,
        p_payload: payload,
        p_headers: headers,
        p_source_ip: sourceIP
      });
      
    if (error) {
      console.log('❌ Erro na função principal, detalhes:', error.message);
      console.log('🔄 Usando processamento alternativo...');
      return await processWebhookPayloadFallback(webhookId, payload, JSON.stringify(headers), sourceIP);
    }
    
    console.log('✅ Processamento principal bem-sucedido');
    return data;
  } catch (err) {
    console.log('❌ Exceção na função principal:', err.message);
    console.log('🔄 Usando processamento alternativo...');
    return await processWebhookPayloadFallback(webhookId, payload, JSON.stringify(headers), sourceIP);
  }
}

// Função alternativa para processar webhook quando há problemas com a função principal
async function processWebhookPayloadFallback(webhookId, payload, headers, sourceIP) {
  console.log('🔄 Usando processamento alternativo para webhook:', webhookId);
  
  try {
    // Buscar configurações do webhook
    const { data: webhook, error: webhookError } = await supabase
      .from('webhook_endpoints')
      .select(`
        *,
        pipelines (
          id,
          name,
          pipeline_columns (
            id,
            position
          )
        )
      `)
      .eq('id', webhookId)
      .single();
      
    if (webhookError) {
      throw webhookError;
    }
    
    if (!webhook) {
      return {
        success: false,
        error: 'Webhook endpoint não encontrado'
      };
    }
    
    // Registrar requisição
    const { data: requestData, error: requestError } = await supabase
      .from('webhook_requests')
      .insert({
        webhook_endpoint_id: webhookId,
        method: 'POST',
        payload: payload,
        headers: typeof headers === 'string' ? JSON.parse(headers) : headers,
        source_ip: sourceIP ? sourceIP.split(',')[0].trim() : null,
        status: 'processing'
      })
      .select()
      .single();
    
    if (requestError) {
      console.error('Erro ao registrar requisição:', requestError);
    }
    
    // Se está em modo mapping, apenas salvar dados de exemplo
    if (webhook.mapping_mode === 'mapping') {
      const { error: sampleError } = await supabase
        .from('webhook_sample_data')
        .upsert({
          webhook_endpoint_id: webhookId,
          sample_payload: payload,
          detected_fields: Object.keys(payload)
        });
      
      if (sampleError) {
        console.error('Erro ao salvar dados de exemplo:', sampleError);
      }
      
      // Atualizar status da requisição
      if (requestData) {
        await supabase
          .from('webhook_requests')
          .update({
            status: 'completed',
            processed_at: new Date().toISOString()
          })
          .eq('id', requestData.id);
      }
      
      return {
        success: true,
        mode: 'mapping',
        message: 'Dados de exemplo salvos para mapeamento'
      };
    }
    
    // Se não está ativo, ignorar
    if (webhook.mapping_mode !== 'active') {
      return {
        success: false,
        error: 'Webhook não está em modo ativo'
      };
    }
    
    // Buscar usuário para criação do lead (primeiro admin da empresa)
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('company_id', webhook.company_id)
      .eq('is_admin', true)
      .limit(1)
      .single();
    
    if (userError || !user) {
      console.error('Erro ao buscar usuário:', userError);
      return {
        success: false,
        error: 'Usuário não encontrado para criação do lead'
      };
    }
    
    // Buscar mapeamentos de campos
    const { data: mappings, error: mappingsError } = await supabase
      .from('webhook_field_mappings')
      .select('source_field, target_field, is_required, default_value')
      .eq('webhook_endpoint_id', webhookId)
      .eq('is_active', true);
    
    if (mappingsError) {
      console.error('Erro ao buscar mapeamentos:', mappingsError);
    }
    
    // ✅ Função para mapear priority para valores válidos do enum
    const mapPriorityToEnum = (priority) => {
      const validValues = ['low', 'medium', 'high'];
      const lowerPriority = (priority || 'medium').toLowerCase().trim();
      
      // Mapeamento de valores comuns
      if (lowerPriority === 'baixa' || lowerPriority === 'baixo') return 'low';
      if (lowerPriority === 'media' || lowerPriority === 'medio' || lowerPriority === 'médio' || lowerPriority === 'média') return 'medium';
      if (lowerPriority === 'alta' || lowerPriority === 'alto') return 'high';
      
      // Se já está em um formato válido, usar
      if (validValues.includes(lowerPriority)) return lowerPriority;
      
      // Padrão
      return 'medium';
    };

    // Processar campos do lead
    let leadData = {
      status: webhook.default_lead_status || 'new',
      priority: mapPriorityToEnum(webhook.default_lead_priority), // ✅ Mapear para enum válido
      source: webhook.default_lead_source || 'webhook'
    };
    
    // Aplicar mapeamentos
    if (mappings && mappings.length > 0) {
      for (const mapping of mappings) {
        const sourceValue = getNestedValue(payload, mapping.source_field);
        const fieldValue = sourceValue || mapping.default_value;
        
        if (mapping.is_required && !fieldValue) {
          return {
            success: false,
            error: `Campo obrigatório ausente: ${mapping.source_field}`
          };
        }
        
        if (fieldValue) {
          // ✅ Mapear priority para valor válido do enum se necessário
          if (mapping.target_field === 'priority') {
            leadData[mapping.target_field] = mapPriorityToEnum(fieldValue);
          } else {
            leadData[mapping.target_field] = fieldValue;
          }
        }
      }
    } else {
      // Se não há mapeamentos configurados, não criar lead automaticamente
      return {
        success: false,
        error: 'Nenhum mapeamento de campo configurado. Configure os mapeamentos primeiro.'
      };
    }
    
    // ✅ Verificar se já existe contato com o mesmo número/email
    let contactId = null;
    if (leadData.phone || leadData.email || leadData.name || leadData.nome) {
      // Primeiro, tentar encontrar contato existente pelo telefone ou email
      let existingContact = null;
      
      if (leadData.phone) {
        const { data: phoneContact } = await supabase
          .from('contacts')
          .select('id')
          .eq('company_id', webhook.company_id)
          .eq('phone', leadData.phone)
          .single();
        
        if (phoneContact) {
          existingContact = phoneContact;
        }
      }
      
      // Se não encontrou pelo telefone, tentar pelo email
      if (!existingContact && leadData.email) {
        const { data: emailContact } = await supabase
          .from('contacts')
          .select('id')
          .eq('company_id', webhook.company_id)
          .eq('email', leadData.email)
          .single();
        
        if (emailContact) {
          existingContact = emailContact;
        }
      }
      
      if (existingContact) {
        // Usar contato existente
        contactId = existingContact.id;
        console.log(`📞 Usando contato existente: ${contactId}`);
      } else {
        // Criar novo contato
        const { data: contactResult, error: contactError } = await supabase
          .from('contacts')
          .insert({
            company_id: webhook.company_id,
            first_name: leadData.name || leadData.nome || 'Contato',
            full_name: leadData.name || leadData.nome || 'Contato via Webhook',
            email: leadData.email,
            phone: leadData.phone,
            source: 'webhook',
            created_by: user.id
          })
          .select()
          .single();
        
        if (!contactError) {
          contactId = contactResult.id;
          console.log(`👤 Novo contato criado: ${contactId}`);
        }
      }
    }
    
         // ✅ Criar lead usando a função SQL ao invés de INSERT direto
     const { data: leadResult, error: leadError } = await supabase
       .rpc('create_lead_unified', {
         lead_data: {
           company_id: webhook.company_id,
           contact_id: contactId,
           title: leadData.title || leadData.name || leadData.nome || 'Lead via Webhook',
           description: leadData.notes || 'Lead criado via webhook',
           email: leadData.email,
           phone: leadData.phone,
           status: leadData.status,
           priority: leadData.priority, // ✅ Já mapeado para enum válido
           source: leadData.source,
           contact_name: leadData.name || leadData.nome,
           contact_email: leadData.email,
           contact_phone: leadData.phone,
           contact_company: leadData.company
         },
         user_id: user.id,
         target_company_id: webhook.company_id
       });
     
     if (leadError) {
       console.error('Erro ao criar lead:', leadError);
       throw leadError;
     }
     
     // ✅ Verificar se a função retornou sucesso
     if (!leadResult || !leadResult.success) {
       console.error('Erro na criação do lead:', leadResult?.error || 'Erro desconhecido');
       throw new Error(leadResult?.error || 'Erro na criação do lead');
     }
     
     console.log('✅ Lead criado com sucesso:', leadResult.lead_id);
     
     // ✅ Mover lead para a coluna específica do webhook se configurada
     if (webhook.default_column_id && leadResult.lead_id) {
       const { error: moveError } = await supabase
         .rpc('move_lead_to_column', {
           lead_id: leadResult.lead_id,
           column_id: webhook.default_column_id
         });
       
       if (moveError) {
         console.error('Erro ao mover lead para coluna específica:', moveError);
       } else {
         console.log(`📍 Lead movido para coluna configurada: ${webhook.default_column_id}`);
       }
     }
     
     // Atualizar status da requisição para sucesso
     if (requestData) {
       await supabase
         .from('webhook_requests')
         .update({
           status: 'success',
           processed_at: new Date().toISOString(),
           lead_id: leadResult.lead_id
         })
         .eq('id', requestData.id);
     }
     
     return {
       success: true,
       lead_id: leadResult.lead_id,
       contact_id: leadResult.contact_id,
       pipeline_id: leadResult.pipeline_id,
       column_id: webhook.default_column_id || leadResult.column_id,
       message: 'Lead criado com sucesso via webhook'
     };
    
  } catch (error) {
    console.error('Erro no processamento alternativo:', error);
    return {
      success: false,
      error: error.message || 'Erro interno no processamento'
    };
  }
}

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

    // Processar webhook
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
