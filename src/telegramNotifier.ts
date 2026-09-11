const BOT_TOKEN = '8872968230:AAEiHMBxH_NBHmv1M9qer4AauajC5ykeqq8'; // Подставьте ваш токен или переменную окружения
const CHAT_ID = '-1004219666305';     // Подставьте ваш chat_id

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
  const message = `🚆 <b>ПРИБЫТИЕ ВАГОНА</b>\n№ <code>${wagonNumber}</code> (${wagonType})\nВид ремонта: ${repairType}\nСобственник: ${owner}`;
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
  const numbersText = wagonNumbers.length > 0 ? wagonNumbers.join(', ') : 'Присваиваются оператором';
  const registrarText = registeredBy ? `\n<b>Принял (КПП):</b> ${registeredBy}` : '';

  const message = 
`🛡 <b>ОХРАНА: ПРИБЫТИЕ ВАГОНОВ НА КПП</b>
───────────────
<b>Количество:</b> ${countText}${registrarText}
<b>Номера:</b> <code>${numbersText}</code>
<b>Тип:</b> ${wagonType}
<b>Вид ремонта:</b> <b>${repairType}</b>
<b>Собственник:</b> ${owner}

⏱ <i>Вагоны ожидают комиссионной дефектовки (ВУ-22) мастерами цехов...</i>`;

  sendRawTelegramMessage(message);
}

export function notifyActSigned(wagonNumber: string, shopName: string, masterName: string) {
  const message = `📝 <b>ПОДПИСАН АКТ ВУ-22</b>\nВагон: № <code>${wagonNumber}</code>\nЦех: ${shopName}\nПодписал: ${masterName}`;
  sendRawTelegramMessage(message);
}

export function notifyPositionAssigned(wagonNumber: string, toRepair: boolean, track: string, position: string) {
  const message = toRepair 
    ? `➡️ <b>ЗАВОЗ НА ПУТЬ</b>\nВагон № <code>${wagonNumber}</code> завезён на ${track}, ${position}`
    : `⏳ <b>ОТПРАВЛЕН В ОЧЕРЕДЬ</b>\nВагон № <code>${wagonNumber}</code> переведён в очередь`;
  sendRawTelegramMessage(message);
}

export function notifyShopStageUpdated(wagonNumber: string, shopName: string, status: string, masterName: string) {
  const statusText = status === 'DONE' ? '✓ Завершён' : '▶ В работе';
  const message = `🏗️ <b>ЭТАП РЕМОНТА</b>\nВагон: № <code>${wagonNumber}</code>\nЦех: ${shopName}\nСтатус: ${statusText}\nОтветственный: ${masterName}`;
  sendRawTelegramMessage(message);
}

export function notifyDelayRegistered(wagonNumber: string, category: string, cause: string, responsible: string, nextAction: string) {
  const message = `⛔ <b>ЗАДЕРЖКА РЕМОНТА</b>\nВагон: № <code>${wagonNumber}</code>\nКатегория: ${category}\nПричина: ${cause}\nОтветственный: ${responsible}\nNext Action: ${nextAction}`;
  sendRawTelegramMessage(message);
}

export function notifyStatusChanged(wagonNumber: string, newStatusRu: string) {
  const message = `🔄 <b>СМЕНА СТАТУСА</b>\nВагон № <code>${wagonNumber}</code>\nНовый статус: ${newStatusRu}`;
  sendRawTelegramMessage(message);
}