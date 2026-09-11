const BOT_TOKEN = '8872968230:AAEiHMBxH_NBHmv1M9qer4AauajC5ykeqq8';
const CHAT_ID = '-1004219666305';

async function sendRawTelegramMessage(text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML'
      })
    });
  } catch (e) {
    console.error('Telegram notification error:', e);
  }
}

export function notifyWagonArrived(wagonNumber: string, repairType: string, owner: string, wagonType: string) {
  const message = 
`🚆 <b>ПРИБЫТИЕ ВАГОНА НА КПП</b>
───────────────
<b>Вагон:</b> № <code>${wagonNumber}</code>
<b>Тип:</b> ${wagonType}
<b>Вид ремонта:</b> <b>${repairType}</b>
<b>Собственник:</b> ${owner}`;

  sendRawTelegramMessage(message);
}

export function notifyWagonsArrivedBulk(
  wagonNumbers: string[],
  repairType: string,
  owner: string,
  wagonType: string,
  registeredBy?: string
) {
  const countText = wagonNumbers.length > 0 ? `${wagonNumbers.length} шт.` : 'Состав (без номеров)';
  const numbersText = wagonNumbers.length > 0 ? wagonNumbers.map(w => `• <code>${w}</code>`).join('\n') : 'Присваиваются оператором';
  const registrarText = registeredBy ? `\n<b>🛡️ Принял (КПП):</b> ${registeredBy}` : '';

  const message = 
`🛡 <b>ОХРАНА: ПРИХОД СОСТАВА С КПП</b>
───────────────
<b>Количество:</b> ${countText}${registrarText}
<b>Вид ремонта:</b> <b>${repairType}</b>
<b>Собственник:</b> ${owner}

<b>Список вагонов:</b>
${numbersText}

⏳ <i>Ожидают комиссионной дефектовки (ВУ-22)...</i>`;

  sendRawTelegramMessage(message);
}

export function notifyActSigned(wagonNumber: string, shopName: string, masterName: string) {
  const message = 
`📝 <b>ПОДПИСАН АКТ ВУ-22</b>
───────────────
🚂 <b>Вагон:</b> № <code>${wagonNumber}</code>
🏢 <b>Цех:</b> ${shopName}
👤 <b>Подписал:</b> ${masterName}`;

  sendRawTelegramMessage(message);
}

export function notifyPositionAssigned(wagonNumber: string, toRepair: boolean, track: string, position: string) {
  const message = toRepair 
    ? `➡️ <b>ЗАВОЗ НА ПУТЬ (СТАРТ)</b>\n───────────────\n🚂 <b>Вагон:</b> № <code>${wagonNumber}</code>\n📍 <b>Дислокация:</b> ${track}, ${position}`
    : `⏳ <b>ПЕРЕВЕДЕН В ОЧЕРЕДЬ</b>\n───────────────\n🚂 <b>Вагон:</b> № <code>${wagonNumber}</code> ожидают заезда`;

  sendRawTelegramMessage(message);
}

export function notifyShopStageUpdated(wagonNumber: string, shopName: string, status: string, masterName: string) {
  const isDone = status === 'DONE';
  const icon = isDone ? '✅' : '▶️';
  const statusTitle = isDone ? 'ЦЕХ ЗАВЕРШИЛ РАБОТУ' : 'ЦЕХ ВЗЯЛ В РАБОТУ';

  const message = 
`${icon} <b>${statusTitle}</b>
───────────────
🚂 <b>Вагон:</b> № <code>${wagonNumber}</code>
🏢 <b>Цех:</b> ${shopName}
👤 <b>Ответственный:</b> ${masterName}`;

  sendRawTelegramMessage(message);
}

export function notifyDelayRegistered(wagonNumber: string, category: string, cause: string, responsible: string, nextAction: string) {
  const message = 
`🚨 <b>ВНИМАНИЕ: ЗАДЕРЖКА ВАГОНА</b>
───────────────
🚂 <b>Вагон:</b> № <code>${wagonNumber}</code>
📦 <b>Категория:</b> ${category}
⚠️ <b>Причина:</b> ${cause}
👤 <b>Ответственный:</b> ${responsible}
🎯 <b>Next Action:</b> ${nextAction}`;

  sendRawTelegramMessage(message);
}

export function notifyStatusChanged(wagonNumber: string, newStatusRu: string) {
  const message = 
`🔄 <b>СМЕНА СТАТУСА ВАГОНА</b>
───────────────
🚂 <b>Вагон:</b> № <code>${wagonNumber}</code>
📊 <b>Новый статус:</b> <b>${newStatusRu}</b>`;

  sendRawTelegramMessage(message);
}