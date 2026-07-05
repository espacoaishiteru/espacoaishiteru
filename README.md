# Espaço Aishiteru — Backend

Backend de agendamento com pagamento automático via Mercado Pago, Google Calendar e Firebase.

## Arquivos necessários na pasta (NÃO subir para o GitHub)
- `firebase-key.json` → chave baixada do Firebase
- `google-calendar-key.json` → chave baixada do Google Cloud

## Rotas disponíveis
- `GET /` → health check
- `GET /horarios/:data` → horários disponíveis (ex: /horarios/2024-01-15)
- `POST /criar-pagamento` → gera cobrança Pix
- `POST /webhook/mercadopago` → recebe confirmação de pagamento
- `GET /status-pagamento/:id` → status de um pagamento

## Variáveis de ambiente no Railway
- `MP_ACCESS_TOKEN` → Access Token do Mercado Pago
- `WHATSAPP_NUMBER` → número do dono
