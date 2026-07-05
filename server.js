require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { google } = require('googleapis');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// ── FIREBASE ──
const serviceAccount = require('./firebase-key.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://aishiteru-23682-default-rtdb.firebaseio.com'
});
const db = admin.database();

// ── GOOGLE CALENDAR ──
const calendarAuth = new google.auth.GoogleAuth({
  keyFile: './google-calendar-key.json',
  scopes: ['https://www.googleapis.com/auth/calendar']
});
const calendar = google.calendar({ version: 'v3', auth: calendarAuth });
const CALENDAR_ID = 'espacoaishiteru@gmail.com';

// ── MERCADO PAGO ──
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

// ── WHATSAPP ──
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '5511952917765';

// ════════════════════════════════════════
// ROTA 1: Verificar horários disponíveis
// ════════════════════════════════════════
app.get('/horarios/:data', async (req, res) => {
  try {
    const data = req.params.data; // formato: 2024-01-15
    const dataInicio = new Date(`${data}T00:00:00-03:00`);
    const dataFim = new Date(`${data}T23:59:00-03:00`);

    // Buscar eventos do Google Calendar
    const eventos = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: dataInicio.toISOString(),
      timeMax: dataFim.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    // Horários bloqueados pelo calendar
    const bloqueados = (eventos.data.items || []).map(evento => {
      const inicio = new Date(evento.start.dateTime || evento.start.date);
      return `${String(inicio.getHours()).padStart(2,'0')}:${String(inicio.getMinutes()).padStart(2,'0')}`;
    });

    // Horários bloqueados no Firebase (pagamentos pendentes confirmados)
    const snapshot = await db.ref(`horarios_bloqueados/${data.replace(/-/g,'')}`).once('value');
    const bloqueadosFirebase = snapshot.val() ? Object.keys(snapshot.val()) : [];

    const todosBloqueados = [...new Set([...bloqueados, ...bloqueadosFirebase])];

    res.json({ data, bloqueados: todosBloqueados });
  } catch (err) {
    console.error('Erro ao buscar horários:', err);
    res.status(500).json({ erro: 'Erro ao buscar horários' });
  }
});

// ════════════════════════════════════════
// ROTA 2: Criar cobrança Pix no Mercado Pago
// ════════════════════════════════════════
app.post('/criar-pagamento', async (req, res) => {
  try {
    const { servico, preco, data, horario, nomeCliente, telefoneCliente } = req.body;
    const sinal = Math.round(preco * 0.3 * 100) / 100;

    const payload = {
      transaction_amount: sinal,
      description: `Sinal 30% - ${servico} - ${data} às ${horario}`,
      payment_method_id: 'pix',
      payer: {
        email: `cliente_${telefoneCliente}@aishiteru.com`,
        first_name: nomeCliente || 'Cliente',
        identification: { type: 'CPF', number: '00000000000' }
      },
      metadata: { servico, preco, data, horario, nomeCliente, telefoneCliente }
    };

    const resposta = await axios.post(
      'https://api.mercadopago.com/v1/payments',
      payload,
      {
        headers: {
          'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': `aish-${Date.now()}-${telefoneCliente}`
        }
      }
    );

    const pagamento = resposta.data;

    // Salvar no Firebase como pendente
    await db.ref(`agendamentos/${pagamento.id}`).set({
      id: pagamento.id,
      status: 'pendente',
      servico, preco, sinal, data, horario,
      nomeCliente, telefoneCliente,
      criadoEm: new Date().toISOString()
    });

    res.json({
      id: pagamento.id,
      qrCode: pagamento.point_of_interaction?.transaction_data?.qr_code,
      qrCodeBase64: pagamento.point_of_interaction?.transaction_data?.qr_code_base64,
      valor: sinal,
      status: pagamento.status
    });

  } catch (err) {
    console.error('Erro ao criar pagamento:', err.response?.data || err.message);
    res.status(500).json({ erro: 'Erro ao criar pagamento' });
  }
});

// ════════════════════════════════════════
// ROTA 3: Webhook do Mercado Pago
// (chamado automaticamente quando cliente paga)
// ════════════════════════════════════════
app.post('/webhook/mercadopago', async (req, res) => {
  try {
    const { type, data } = req.body;

    if (type !== 'payment') {
      return res.status(200).send('OK');
    }

    const pagamentoId = data.id;

    // Buscar dados do pagamento no MP
    const resposta = await axios.get(
      `https://api.mercadopago.com/v1/payments/${pagamentoId}`,
      { headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` } }
    );

    const pagamento = resposta.data;

    if (pagamento.status !== 'approved') {
      return res.status(200).send('OK');
    }

    // Buscar dados do agendamento no Firebase
    const snapshot = await db.ref(`agendamentos/${pagamentoId}`).once('value');
    const agendamento = snapshot.val();

    if (!agendamento || agendamento.status === 'confirmado') {
      return res.status(200).send('OK');
    }

    const { servico, data: dataAg, horario, nomeCliente, telefoneCliente, preco } = agendamento;

    // 1. Criar evento no Google Calendar
    const [hora, minuto] = horario.split(':').map(Number);
    const dataInicio = new Date(`${dataAg}T${horario}:00-03:00`);
    const dataFim = new Date(dataInicio.getTime() + 60 * 60 * 1000); // +1 hora

    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `${nomeCliente} - ${servico}`,
        description: `Tel: ${telefoneCliente}\nSinal pago: R$${agendamento.sinal}\nRestante: R$${preco - agendamento.sinal}`,
        start: { dateTime: dataInicio.toISOString(), timeZone: 'America/Sao_Paulo' },
        end: { dateTime: dataFim.toISOString(), timeZone: 'America/Sao_Paulo' },
        colorId: '2' // verde
      }
    });

    // 2. Bloquear horário no Firebase
    const chaveData = dataAg.replace(/-/g, '');
    const chaveHorario = horario.replace(':', '');
    await db.ref(`horarios_bloqueados/${chaveData}/${chaveHorario}`).set({
      servico, nomeCliente, telefoneCliente, pagamentoId
    });

    // 3. Atualizar status do agendamento
    await db.ref(`agendamentos/${pagamentoId}`).update({
      status: 'confirmado',
      confirmadoEm: new Date().toISOString()
    });

    // 4. Enviar mensagem de confirmação no WhatsApp (link direto)
    const dataFormatada = new Date(`${dataAg}T12:00:00`).toLocaleDateString('pt-BR', {
      weekday: 'long', day: 'numeric', month: 'long'
    });
    const mensagem = `✅ *Sessão confirmada!*\n\nOlá${nomeCliente ? `, ${nomeCliente}` : ''}! Seu pagamento foi recebido e sua sessão está confirmada.\n\n🌿 *Serviço:* ${servico}\n📅 *Data:* ${dataFormatada}\n🕐 *Horário:* ${horario}\n💰 *Sinal pago:* R$ ${agendamento.sinal}\n💵 *Restante no dia:* R$ ${preco - agendamento.sinal}\n\n📍 R. Máximo Gonçalves, 114 - Cidade Maia, Guarulhos\n_(Ao lado do Senai)_\n\nAté lá! 🙏`;

    console.log(`📱 Mensagem para ${telefoneCliente}:\n${mensagem}`);

    // Notificar o dono também
    console.log(`🔔 NOVO AGENDAMENTO CONFIRMADO:\n${nomeCliente} - ${servico} - ${dataAg} ${horario}`);

    res.status(200).send('OK');
  } catch (err) {
    console.error('Erro no webhook:', err);
    res.status(500).send('Erro');
  }
});

// ════════════════════════════════════════
// ROTA 4: Verificar status de um pagamento
// ════════════════════════════════════════
app.get('/status-pagamento/:id', async (req, res) => {
  try {
    const snapshot = await db.ref(`agendamentos/${req.params.id}`).once('value');
    const agendamento = snapshot.val();
    if (!agendamento) return res.status(404).json({ erro: 'Não encontrado' });
    res.json({ status: agendamento.status, agendamento });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar status' });
  }
});

// ════════════════════════════════════════
// ROTA 5: Health check
// ════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({ status: 'online', app: 'Espaço Aishiteru Backend', versao: '1.0.0' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌿 Aishiteru Backend rodando na porta ${PORT}`);
});
