// Токен вашего бота и ID чата/канала депо
// Вы можете указать их прямо здесь или вынести в .env переменные (VITE_TELEGRAM_BOT_TOKEN / VITE_TELEGRAM_CHAT_ID)
const BOT_TOKEN = (import.meta as any).env?.VITE_TELEGRAM_BOT_TOKEN || '8872968230:AAEiHMBxH_NBHmv1M9qer4AauajC5ykeqq8';
const CHAT_ID = (import.meta as any).env?.VITE_TELEGRAM_CHAT_ID || '-1004219666305';

async function sendRawTelegramMessage(text: string) {
  if (!BOT_TOKEN || BOT_TOKEN === 'ВАШ_BOT_TOKEN' || !CHAT_ID || CHAT_ID === 'ВАШ_CHAT_ID') {
    console.warn('Telegram Bot Token или Chat ID не настроены. Уведомление пропущено.');
    return;
  }

  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
  } catch (err) {
    console.error('Ошибка отправки уведомления в Telegram:', err);
  }
}

// 1. Алерт: Вагон прибыл на депо
export function notifyWagonArrived(wagonNumber: string, repairType: string, owner: string, wagonType: string) {
  const message = 
`🚆 <b>НОВЫЙ ВАГОН НА ДЕПО</b>
───────────────
<b>Номер вагона:</b> <code>№ ${wagonNumber}</code>
<b>Тип вагона:</b> ${wagonType}
<b>Вид ремонта:</b> <b>${repairType}</b>
<b>Собственник:</b> ${owner}

⏱ <i>Ожидает комиссионной дефектовки (ВУ-22)...</i>`;

  sendRawTelegramMessage(message);
}

// 2. Алерт: Мастер подписал Акт ВУ-22
export function notifyActSigned(wagonNumber: string, shopLabel: string, masterName: string) {
  const message = 
`📝 <b>ПОДПИСАН АКТ ВУ-22</b>
───────────────
<b>Вагон:</b> <code>№ ${wagonNumber}</code>
<b>Цех:</b> ${shopLabel}
✍️ <b>Подписал:</b> ${masterName}
⏰ <b>Время:</b> ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;

  sendRawTelegramMessage(message);
}

// 3. Алерт: Вагон завезли на путь или отправили в очередь
export function notifyPositionAssigned(wagonNumber: string, isRepair: boolean, track?: string, position?: string) {
  const locationText = isRepair 
    ? `📍 <b>Завезён на:</b> ${track}, ${position}`
    : `⏳ <b>Отправлен в очередь</b> (накопительный путь)`;

  const message = 
`🏗 <b>ДИСПЕТЧЕРИЗАЦИЯ ВАГОНА</b>
───────────────
<b>Вагон:</b> <code>№ ${wagonNumber}</code>
${locationText}
⏰ <b>Время:</b> ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;

  sendRawTelegramMessage(message);
}

// 4. Алерт: Изменение этапа работы цеха
export function notifyShopStageUpdated(wagonNumber: string, shopLabel: string, status: string, masterName: string) {
  const statusEmoji = status === 'DONE' ? '✅' : '⚙️';
  const statusTitle = status === 'DONE' ? 'Завершены работы в цехе' : 'Начаты работы в цехе';

  const message = 
`${statusEmoji} <b>${statusTitle.toUpperCase()}</b>
───────────────
<b>Вагон:</b> <code>№ ${wagonNumber}</code>
<b>Цех:</b> ${shopLabel}
👤 <b>Ответственный:</b> ${masterName}
⏰ <b>Время:</b> ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;

  sendRawTelegramMessage(message);
}

// 5. Алерт: Регистрация критической задержки (Blocker)
export function notifyDelayRegistered(wagonNumber: string, category: string, cause: string, responsible: string, nextAction: string) {
  const message = 
`🚨 <b>КРИТИЧЕСКАЯ ЗАДЕРЖКА (BLOCKER)</b>
───────────────
<b>Вагон:</b> <code>№ ${wagonNumber}</code>
<b>Категория:</b> ${category}
⚠️ <b>Причина:</b> ${cause}
👤 <b>Ответственный:</b> ${responsible}
👉 <b>Next Action:</b> ${nextAction}`;

  sendRawTelegramMessage(message);
}

// 6. Алерт: Смена статуса вагона (Готов к отправке / Закрыт)
export function notifyStatusChanged(wagonNumber: string, statusRu: string) {
  const message = 
`🔔 <b>ИЗМЕНЕНИЕ СТАТУСА ВАГОНА</b>
───────────────
<b>Вагон:</b> <code>№ ${wagonNumber}</code>
📊 <b>Новый статус:</b> <b>${statusRu}</b>`;

  sendRawTelegramMessage(message);
}