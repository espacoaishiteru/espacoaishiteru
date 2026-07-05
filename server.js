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
const firebaseKey = JSON.parse(process.env.FIREBASE_KEY);
admin.initializeApp({
  credential: admin.credential.cert(firebaseKey),
  databaseURL: 'https://aishiteru-23682-default-rtdb.firebaseio.com'
});
const db = admin.database();

// ── GOOGLE CALENDAR ──
const googleKey = JSON.parse(process.env.GOOGLE_CALENDAR_KEY);
const calendarAuth = new google.auth.GoogleAuth({
  credentials: googleKey,
  scopes: ['https://www.googleapis.com/auth/calendar']
});
const calendar = google.calendar({ version: 'v3', auth: calendarAuth });
const CALENDAR_ID = 'espacoaishiteru@gmail.com';

// ── MERCADO PAGO ──
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

// ════════════════════════════════════════
// ROTA 1: Health check
// ════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({ status: 'online', app: 'Espaço Aishiteru Backend', versao: '1.0.0' });
});

// ════════════════════════════════════════
// ROTA 2: Verificar horários disponíveis
// ════════════════════════════════════════
app.get('/horarios/:data', async (req, res) => {
  try {
    const data = req.params.data;
    const dataInicio = new Date(`${data}T00:00:00-03:00`);
    const dataFim = new Date(`${data}T23:59:00-03:00`);

    const eventos = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: dataInicio.toISOString(),
      timeMax: dataFim.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    const bloqueados = (eventos.data.items || []).map(evento => {
      const inicio = new Date(evento.start.dateTime || evento.start.date);
      return `${String(inicio.getHours()).padStart(2,'0')}:${String(inicio.getMinutes()).padStart(2,'0')}`;
    });

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
// ROTA 3: Criar cobrança Pix
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
        email: `cliente${Date.now()}@aishiteru.temp`,
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
          'X-Idempotency-Key': `aish-${Date.now()}`
        }
      }
    );

    const pagamento = resposta.data;

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
    res.status(500).json({ erro: 'Erro ao criar pagamento', detalhe: err.response?.data });
  }
});

// ════════════════════════════════════════
// ROTA 4: Webhook Mercado Pago
// ════════════════════════════════════════
app.post('/webhook/mercadopago', async (req, res) => {
  try {
    const { type, data } = req.body;
    if (type !== 'payment') return res.status(200).send('OK');

    const pagamentoId = data.id;
    const resposta = await axios.get(
      `https://api.mercadopago.com/v1/payments/${pagamentoId}`,
      { headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` } }
    );

    const pagamento = resposta.data;
    if (pagamento.status !== 'approved') return res.status(200).send('OK');

    const snapshot = await db.ref(`agendamentos/${pagamentoId}`).once('value');
    const agendamento = snapshot.val();
    if (!agendamento || agendamento.status === 'confirmado') return res.status(200).send('OK');

    const { servico, data: dataAg, horario, nomeCliente, telefoneCliente, preco } = agendamento;

    // Criar evento no Google Calendar
    const dataInicio = new Date(`${dataAg}T${horario}:00-03:00`);
    const dataFim = new Date(dataInicio.getTime() + 60 * 60 * 1000);

    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `${nomeCliente} - ${servico}`,
        description: `Tel: ${telefoneCliente}\nSinal: R$${agendamento.sinal}\nRestante: R$${preco - agendamento.sinal}`,
        start: { dateTime: dataInicio.toISOString(), timeZone: 'America/Sao_Paulo' },
        end: { dateTime: dataFim.toISOString(), timeZone: 'America/Sao_Paulo' },
        colorId: '2'
      }
    });

    // Bloquear no Firebase
    const chaveData = dataAg.replace(/-/g, '');
    const chaveHorario = horario.replace(':', '');
    await db.ref(`horarios_bloqueados/${chaveData}/${chaveHorario}`).set({
      servico, nomeCliente, telefoneCliente, pagamentoId
    });

    await db.ref(`agendamentos/${pagamentoId}`).update({
      status: 'confirmado',
      confirmadoEm: new Date().toISOString()
    });

    const dataFormatada = new Date(`${dataAg}T12:00:00`).toLocaleDateString('pt-BR', {
      weekday: 'long', day: 'numeric', month: 'long'
    });

    console.log(`✅ CONFIRMADO: ${nomeCliente} - ${servico} - ${dataFormatada} ${horario}`);

    res.status(200).send('OK');
  } catch (err) {
    console.error('Erro no webhook:', err);
    res.status(500).send('Erro');
  }
});

// ════════════════════════════════════════
// ROTA 5: Status de pagamento
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌿 Aishiteru Backend rodando na porta ${PORT}`);
});
