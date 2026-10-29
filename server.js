const http = require('http');
const { createClient } = require('@supabase/supabase-js');

// Инициализация Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/telegram') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', async () => {
      try {
        const update = JSON.parse(body);
        console.log('Received update from Telegram:', update);

        if (update.message && update.message.text) {
          const chatId = update.message.chat.id;
          const text = update.message.text;
          const token = process.env.TELEGRAM_BOT_TOKEN;

          let replyText = '';

          if (text.startsWith('/start')) {
            replyText = 'Привет! Бот Hellstorm успешно запущен и готов к работе!';[span_3](start_span)[span_3](end_span)
          } else if (text.startsWith('/guild')) {
            replyText = '⚔️ Информация об альянсе Hellstorm: экспедиции, активность и координация бойцов.';
          } else if (text.startsWith('/builds')) {
            replyText = '🛡 Актуальные билды и прокачка героев для Битвы Замков.';
          } else if (text.startsWith('/guide')) {
            replyText = '📖 Руководства и гайды по стратегии доступны в нашем сообществе.';
          } else if (text.startsWith('/help')) {
            replyText = '📌 Доступные команды:\n/start - Запуск бота\n/guild - Информация об альянсе\n/builds - Билды героев\n/guide - Гайды';
          }

          if (replyText) {
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: chatId,
                text: replyText
              })
            });
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (e) {
        console.error('Error processing update:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Hellstorm Bot is running!');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
