const express = require('express');
const path = require('path');
const multer = require('multer');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('./db');
const reminderLogic = require('./reminder-logic');
const { initStorage, savePaymentScreenshot, saveAboutMePhoto, deleteAboutMePhoto } = require('./storage');

const app = express();
app.use(express.json());

// Configure multer for file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// CORS middleware for admin panel
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Parse ADMIN_TELEGRAM_IDS from env (comma-separated string)
const ADMIN_TELEGRAM_IDS_STR = process.env.ADMIN_TELEGRAM_IDS || '';
const ADMIN_TELEGRAM_IDS = ADMIN_TELEGRAM_IDS_STR.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
let adminGroupChatId = process.env.ADMIN_GROUP_CHAT_ID?.trim() || null;

function getAdminGroupChatId() {
  return adminGroupChatId;
}

function isAdminGroupChat(chatId) {
  const groupId = getAdminGroupChatId();
  return groupId != null && String(chatId) === groupId;
}

async function telegramGetChat(chatId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getChat`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: String(chatId) }),
  });
  return response.json();
}

async function validateAdminGroupChat() {
  const id = getAdminGroupChatId();
  if (!id) {
    console.warn('⚠️ Admin group chat not configured');
    return false;
  }
  const chat = await telegramGetChat(id);
  if (!chat?.ok) {
    console.error('❌ Admin group chat not reachable:', id, JSON.stringify(chat));
    return false;
  }
  const info = chat.result;
  console.log(`✓ Admin group chat: ${info.title} (${id}), forum=${info.is_forum}`);
  if (!info.is_forum) {
    console.error('❌ Admin group must have Topics (forum) enabled');
    return false;
  }
  return true;
}

async function registerAdminGroupChat(chatId, title) {
  adminGroupChatId = String(chatId);
  await db.setSetting('admin_group_chat_id', { chatId: adminGroupChatId, title: title || null });
  return validateAdminGroupChat();
}

async function loadAdminGroupChatId() {
  const fromEnv = process.env.ADMIN_GROUP_CHAT_ID?.trim();
  if (fromEnv) {
    adminGroupChatId = fromEnv;
    if (await validateAdminGroupChat()) return;
    console.warn('⚠️ ADMIN_GROUP_CHAT_ID from .env is invalid, trying DB...');
  }
  const setting = await db.getSetting('admin_group_chat_id');
  if (setting?.value) {
    const value = typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
    if (value?.chatId) {
      adminGroupChatId = String(value.chatId);
      if (await validateAdminGroupChat()) return;
    }
  }
  adminGroupChatId = null;
  console.warn('⚠️ Admin group chat not configured. Add bot to forum group or send /set_admin_group there.');
}

function isAdmin(telegramId) {
  return ADMIN_TELEGRAM_IDS.includes(telegramId);
}

// Validate environment variables
if (!TELEGRAM_BOT_TOKEN) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN is not set!');
  process.exit(1);
}

console.log('✓ Environment variables loaded');
console.log('✓ Bot token:', TELEGRAM_BOT_TOKEN ? `${TELEGRAM_BOT_TOKEN.substring(0, 10)}...` : 'NOT SET');
console.log('✓ Admin IDs:', ADMIN_TELEGRAM_IDS);
console.log('✓ Admin group chat:', getAdminGroupChatId() || 'not set (will load from DB on start)');

// Telegram API functions
async function sendMessageToAllAdmins(text, replyMarkup = null, excludeTelegramId = null) {
  const adminIds = excludeTelegramId == null
    ? ADMIN_TELEGRAM_IDS
    : ADMIN_TELEGRAM_IDS.filter((id) => id !== excludeTelegramId);
  const promises = adminIds.map(adminId =>
    sendMessage(adminId, text, replyMarkup, false).catch(error => {
      console.error(`❌ Error sending message to admin ${adminId}:`, error);
      return null;
    })
  );
  return Promise.all(promises);
}

async function sendMessage(chatId, text, replyMarkup, useReplyKeyboard = true, messageThreadId = null) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  };

  if (messageThreadId != null) {
    body.message_thread_id = messageThreadId;
  }

  // Если передана инлайн-клавиатура, мы всё равно можем отправить reply_markup с кнопкой меню,
  // но Telegram позволяет только один тип клавиатуры в одном сообщении.
  // Поэтому Reply Keyboard нужно отправить ОДИН РАЗ при /start или открытии меню, 
  // и она будет висеть под полем ввода.
  
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  } else if (useReplyKeyboard) {
    body.reply_markup = {
      keyboard: [[{ text: '📋 Главное меню' }]],
      resize_keyboard: true,
      persistent: true
    };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const result = await response.json();

  if (!result.ok) {
    console.error('❌ Telegram API error:', JSON.stringify(result));
  } else {
    console.log('✅ Message sent successfully to chat_id:', chatId);
  }

  return result;
}

async function sendPhoto(chatId, photoUrl, caption, replyMarkup) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;
  const body = {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: 'HTML',
  };
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return response.json();
}

async function answerCallbackQuery(callbackQueryId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
    }),
  });
}

async function setChatMenuButton(chatId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setChatMenuButton`;
  const body = {
    menu_button: { type: 'commands' }
  };
  
  if (chatId) {
    body.chat_id = chatId;
  }

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function setMyCommands() {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { command: 'menu', description: '🏠 Главное меню' }
      ]
    }),
  });
}

async function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    }),
  });
  const result = await response.json();
  if (!result.ok) {
    console.warn('editMessageReplyMarkup:', JSON.stringify(result));
  }
  return result;
}

function formatDate(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleDateString('ru-RU', {
    weekday: 'short',
    day: 'numeric',
    month: 'long'
  });
}

function formatTime(timeStr) {
  return timeStr.slice(0, 5);
}

function getMainMenuKeyboard(telegramId) {
  const projectUrl = process.env.PROJECT_URL || 'https://liftme.by';

  const keyboard = [
    [{ text: '🗓 Записаться на консультацию', callback_data: 'book_session' }],
    [
      { text: '📁 Свободные даты', callback_data: 'free_slots' },
      { text: '🗓 Моя запись', callback_data: 'my_bookings' },
    ],
    [
      { text: '📒 Дневник терапии', callback_data: 'diary' },
      { text: '💳 Оплата', callback_data: 'payment' },
    ],
    [{ text: '👤 Обо мне', callback_data: 'about_me' }],
    [{ text: '🆘 SOS', callback_data: 'sos' }],
  ];

  if (isAdmin(telegramId)) {
    keyboard.push([{ text: '📋 Управление расписанием', url: projectUrl }]);
    keyboard.push([{ text: '📢 Рассылка', callback_data: 'admin_broadcast' }]);
  }

  return { inline_keyboard: keyboard };
}

function looksLikeClientUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function fbaTopicSettingKey(clientUuid) {
  return `fba_topic_${clientUuid}`;
}

function fbaTopicLookupKey(groupChatId, threadId) {
  return `fba_topic_lookup_${groupChatId}_${threadId}`;
}

function threadStateKey(chatId, threadId) {
  return `state_${chatId}_${threadId}`;
}

async function getFbaTopicForClient(clientUuid) {
  const setting = await db.getSetting(fbaTopicSettingKey(clientUuid));
  if (!setting?.value) return null;
  const value = typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
  return value?.topicId ? value : null;
}

async function saveFbaTopicForClient(clientUuid, groupChatId, topicId) {
  await db.setSetting(fbaTopicSettingKey(clientUuid), { groupChatId, topicId });
  await db.setSetting(fbaTopicLookupKey(groupChatId, topicId), { clientUuid });
}

async function getClientUuidByFbaTopic(groupChatId, threadId) {
  const setting = await db.getSetting(fbaTopicLookupKey(groupChatId, threadId));
  if (!setting?.value) return null;
  const value = typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
  return value?.clientUuid || null;
}

async function getThreadState(chatId, threadId) {
  const setting = await db.getSetting(threadStateKey(chatId, threadId));
  return setting ? (typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value) : null;
}

async function setThreadState(chatId, threadId, state) {
  await db.setSetting(threadStateKey(chatId, threadId), state);
}

async function clearThreadState(chatId, threadId) {
  await db.query('DELETE FROM bot_settings WHERE key = $1', [threadStateKey(chatId, threadId)]);
}

async function createForumTopic(chatId, name) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createForumTopic`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: String(chatId),
      name: String(name).slice(0, 128),
    }),
  });
  const result = await response.json();
  if (!result.ok) {
    console.error('❌ createForumTopic error:', JSON.stringify(result));
    return null;
  }
  return result.result.message_thread_id;
}

function buildFirstBookingAccessAdminText(clientRow) {
  const name = clientRow.first_name || 'Клиент';
  const username = clientRow.username ? `@${clientRow.username}` : 'нет username';
  const lastName = clientRow.last_name ? ` ${clientRow.last_name}` : '';
  return (
    `📋 <b>Запрос на первую запись</b>\n\n` +
    `Новый пользователь хочет записаться на консультацию.\n\n` +
    `👤 ${name}${lastName}\n${username}\n🆔 telegram id: <code>${clientRow.telegram_id}</code>\n\n` +
    `Используйте «Ответить», чтобы написать клиенту через бота, или «Одобрить запись», чтобы открыть самостоятельную запись.`
  );
}

function buildFirstBookingAccessAdminKeyboard(clientUuid) {
  return {
    inline_keyboard: [
      [
        { text: '💬 Ответить', callback_data: `fba_reply_${clientUuid}` },
        { text: '✅ Одобрить запись', callback_data: `fba_y_${clientUuid}` },
      ],
    ],
  };
}

async function ensureFbaAdminTopic(clientRow) {
  const groupChatId = getAdminGroupChatId();
  if (!groupChatId) return null;

  const existing = await getFbaTopicForClient(clientRow.id);
  if (existing?.topicId) {
    return existing;
  }

  const name = clientRow.first_name || 'Клиент';
  const username = clientRow.username ? `@${clientRow.username}` : `id ${clientRow.telegram_id}`;
  const topicName = `${name} · ${username}`.slice(0, 128);
  const topicId = await createForumTopic(groupChatId, topicName);
  if (!topicId) return null;

  await saveFbaTopicForClient(clientRow.id, groupChatId, topicId);
  return { groupChatId, topicId };
}

async function notifyAdminsFirstBookingAccessRequest(clientRow) {
  const text = buildFirstBookingAccessAdminText(clientRow);
  const replyMarkup = buildFirstBookingAccessAdminKeyboard(clientRow.id);
  const clientTelegramId = Number(clientRow.telegram_id);

  const groupChatId = getAdminGroupChatId();
  if (groupChatId) {
    const topic = await ensureFbaAdminTopic(clientRow);
    if (topic) {
      await sendMessage(
        topic.groupChatId,
        text,
        replyMarkup,
        false,
        topic.topicId
      );
      console.log('✅ First booking request sent to admin group topic:', topic.topicId);
      return;
    }
    console.error('❌ Failed to create forum topic in group', groupChatId, '- check bot permissions and forum mode');
  } else {
    console.error('❌ Admin group chat not configured - cannot create booking topic');
  }

  await sendMessageToAllAdmins(text, replyMarkup, clientTelegramId);
}

async function relayClientMessageToFbaTopic(clientRow, text) {
  const topic = await getFbaTopicForClient(clientRow.id);
  if (!topic?.topicId) return false;

  const name = clientRow.first_name || 'Клиент';
  const username = clientRow.username ? `@${clientRow.username}` : 'нет username';
  await sendMessage(
    topic.groupChatId,
    `👤 <b>Сообщение от клиента</b> (${name}, ${username}):\n\n${text}`,
    buildFirstBookingAccessAdminKeyboard(clientRow.id),
    false,
    topic.topicId
  );
  return true;
}

async function getOrCreateClient(telegramUser) {
  console.log('🔍 getOrCreateClient called for telegram_id:', telegramUser.id);
  let client = await db.getClientByTelegramId(telegramUser.id);
  console.log('🔍 Client lookup result:', client ? `Found client id: ${client.id}` : 'Client not found');

  if (!client) {
    console.log('👤 Creating new client:', telegramUser.id);
    client = await db.createClient(telegramUser);
    console.log('✅ New client created:', client.id);

    // Уведомляем админа о новом пользователе
    try {
      const name = client.first_name || 'Клиент';
      const username = client.username ? `@${client.username}` : 'нет username';
      const lastName = client.last_name ? ` ${client.last_name}` : '';

      const adminMessage = `🎉 <b>Новый пользователь!</b>\n👤 username: ${username}\n✨ Имя: ${name}${lastName}`;

      console.log('📤 Sending new user notification to all admins');
      const results = await sendMessageToAllAdmins(adminMessage);
      console.log('✅ New user notification sent to all admins. Results:', results.length);
    } catch (error) {
      console.error('❌ Error sending new user notification:', error);
    }
  } else {
    console.log('ℹ️ Client already exists, skipping notification');
  }

  return client;
}

// Get available slots
async function getAvailableSlots() {
  return await db.getAvailableSlots(30);
}

// Get unique dates from available slots
async function getAvailableDates() {
  const slots = await getAvailableSlots();
  const uniqueDates = [...new Set(slots.map(slot => {
    // Ensure date is in YYYY-MM-DD format (string)
    const date = slot.date;
    if (date instanceof Date) {
      return date.toISOString().split('T')[0];
    }
    return typeof date === 'string' ? date.split('T')[0] : date;
  }))];
  return uniqueDates;
}

// Get slots for a specific date
async function getSlotsForDate(date) {
  return await db.getSlotsForDate(date);
}

// Get client's upcoming bookings only
async function getClientBookings(clientId) {
  console.log('📅 getClientBookings: querying DB for clientId:', clientId);
  const bookings = await db.getClientBookings(clientId);
  console.log('📅 getClientBookings: raw bookings from DB:', JSON.stringify(bookings, null, 2));
  console.log('📅 getClientBookings: number of bookings:', bookings.length);

  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const currentTime = now.toTimeString().slice(0, 5); // HH:MM format
  console.log('📅 Filter criteria:', { today, currentTime });

  // Filter only upcoming bookings
  const filtered = bookings.filter(booking => {
    if (!booking.date) {
      return false;
    }

    // Convert date to string if needed
    const bookingDate = booking.date instanceof Date
      ? booking.date.toISOString().split('T')[0]
      : (typeof booking.date === 'string' ? booking.date.split('T')[0] : String(booking.date));

    // Convert time to HH:MM format (cut seconds if present)
    const bookingTime = typeof booking.time === 'string'
      ? booking.time.slice(0, 5) // Take only HH:MM
      : String(booking.time).slice(0, 5);

    if (bookingDate > today) {
      return true; // Future date
    }
    if (bookingDate === today && bookingTime >= currentTime) {
      return true; // Today but not past
    }
    return false; // Past booking
  });

  return filtered.map(booking => {
    const dateStr = booking.date instanceof Date
      ? booking.date.toISOString().split('T')[0]
      : (typeof booking.date === 'string' ? booking.date.split('T')[0] : String(booking.date));

    return {
      ...booking,
      date: dateStr,
      slots: {
        date: dateStr,
        time: booking.time,
        format: booking.format
      }
    };
  });
}

// Book a slot with format
async function bookSlot(clientId, slotId, format = 'offline') {
  try {
    console.log('📅 bookSlot called:', { clientId, slotId, format });
    if (!(await db.clientCanSelfServiceBook(clientId))) {
      console.log('❌ Booking blocked: first booking access not approved');
      return false;
    }
    const slot = await db.getSlotById(slotId);
    if (!slot) {
      console.log('❌ Slot not found:', slotId);
      return false;
    }

    // Check if slot date is in the past
    const today = new Date().toISOString().split('T')[0];
    const slotDate = slot.date instanceof Date 
      ? slot.date.toISOString().split('T')[0] 
      : (typeof slot.date === 'string' ? slot.date.split('T')[0] : String(slot.date));
    
    if (slotDate < today) {
      console.log('❌ Cannot book slot in the past:', slotDate);
      return false;
    }

    // Check if slot is today but time has passed
    if (slotDate === today) {
      const now = new Date();
      const currentTime = now.toTimeString().slice(0, 5); // HH:MM
      const slotTime = typeof slot.time === 'string' ? slot.time.slice(0, 5) : String(slot.time).slice(0, 5);
      if (slotTime < currentTime) {
        console.log('❌ Cannot book slot - time has passed:', slotTime);
        return false;
      }
    }

    console.log('✅ Slot found:', slot);
    await db.updateSlot(slotId, { status: 'booked', client_id: clientId, format });
    console.log('✅ Slot updated');

    const booking = await db.createBooking(clientId, slotId);
    console.log('✅ Booking created:', booking);

    const client = await db.getClientById(clientId);

    if (client) {
      const name = client.first_name || 'Клиент';
      const username = client.username ? `@${client.username}` : '';
      const formatText = format === 'online' ? '💻 онлайн' : '🏠 очно';

      await sendMessageToAllAdmins(
        `📅 <b>Новая запись!</b>\n\nКлиент: ${name} ${username}\n🆔 id: ${client.telegram_id}\n\n📆 ${formatDate(slot.date)} в ${formatTime(slot.time)}\n${formatText}`
      );
    }

    return true;
  } catch (error) {
    console.error('❌ Error in bookSlot:', error);
    return false;
  }
}

// Cancel booking with 24h check for clients
async function cancelBooking(bookingId, isAdminCancel = false) {
  const bookingResult = await db.query(
    'SELECT slot_id, client_id FROM bookings WHERE id = $1',
    [bookingId]
  );

  if (!bookingResult.rows[0]) {
    return { success: false, error: 'Запись не найдена' };
  }

  const booking = bookingResult.rows[0];
  const slot = await db.getSlotById(booking.slot_id);

  if (!slot) {
    return { success: false, error: 'Слот не найден' };
  }

  // Check 24h rule for client cancellations
  if (!isAdminCancel) {
    const slotDateTime = new Date(`${slot.date}T${slot.time}`);
    const now = new Date();
    const hoursUntilSlot = (slotDateTime.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (hoursUntilSlot < 24) {
      return { success: false, error: 'Отменить запись можно не позднее чем за 24 часа до начала' };
    }
  }

  const client = await db.getClientById(booking.client_id);
  await db.cancelBooking(bookingId);
  await db.updateSlot(booking.slot_id, { status: 'free', client_id: null, format: null });

  return { success: true, slot, client };
}

// Save diary entry
async function saveDiaryEntry(clientId, text) {
  try {
    await db.createDiaryEntry(clientId, text);
    return true;
  } catch (error) {
    console.error('Error saving diary entry:', error);
    return false;
  }
}

// Get diary entries
async function getDiaryEntries(clientId) {
  return await db.getDiaryEntries(clientId, 5);
}

// Create SOS request and notify admin
async function createSosRequest(clientId, client, text) {
  try {
    await db.createSosRequest(clientId, text || '');

    // Notify admin about SOS
    const name = client.first_name || 'Пользователь';
    const username = client.username ? `@${client.username}` : 'нет username';

    const adminMessage = `⚠️ <b>SOS-сигнал</b>

Пользователь нажал кнопку SOS.

🆔 id: ${client.telegram_id}
👤 username: ${username}
📛 Имя: ${name}

Вы можете ответить пользователю напрямую в Telegram.`;

    await sendMessageToAllAdmins(adminMessage);
    return true;
  } catch (error) {
    console.error('Error creating SOS request:', error);
    return false;
  }
}

// Get current state
async function getState(chatId) {
  const setting = await db.getSetting(`state_${chatId}`);
  return setting ? (typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value) : null;
}

// Clear state
async function clearState(chatId) {
  await db.query('DELETE FROM bot_settings WHERE key = $1', [`state_${chatId}`]);
}

// Get file URL from Telegram
async function getFileUrl(fileId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });

  const result = await response.json();
  if (result.ok && result.result?.file_path) {
    return `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${result.result.file_path}`;
  }
  return null;
}

// Save payment screenshot (using local storage) - function name conflicts, using storage module directly

async function ensureClientSelfServiceBooking(chatId, telegramId, client) {
  const fresh = await db.getClientByTelegramId(telegramId);
  const clientId = fresh?.id || client.id;
  if (await db.clientCanSelfServiceBook(clientId)) return true;
  if (fresh?.first_booking_access_requested_at) {
    await sendMessage(
      chatId,
      '⏳ Ваша заявка на возможность записи уже отправлена и ожидает решения администратора.\n\nКогда заявку рассмотрят, вы получите сообщение здесь.',
      { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'main_menu' }]] }
    );
    return false;
  }
  await sendMessage(
    chatId,
    '⏳ Самостоятельная запись пока недоступна: дождитесь одобрения заявки администратором или откройте «Записаться на консультацию», чтобы отправить заявку.',
    getMainMenuKeyboard(telegramId)
  );
  return false;
}

// Handle booking flow - step 1: select day
async function handleBookSession(chatId, telegramId, client) {
  try {
    const fresh = await db.getClientByTelegramId(telegramId);
    const subject = fresh || client;
    const canBook = await db.clientCanSelfServiceBook(subject.id);
    if (!canBook) {
      if (subject.first_booking_access_requested_at) {
        await sendMessage(
          chatId,
          '⏳ Ваша заявка на возможность записи уже отправлена и ожидает решения администратора.\n\nКогда заявку рассмотрят, вы получите сообщение здесь.',
          { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'main_menu' }]] }
        );
        return;
      }
      const marked = await db.markClientFirstBookingAccessRequested(subject.id);
      if (!marked) {
        const again = await db.getClientByTelegramId(telegramId);
        if (again?.first_booking_access_requested_at) {
          await sendMessage(
            chatId,
            '⏳ Заявка уже на рассмотрении. Ожидайте ответа.',
            { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'main_menu' }]] }
          );
        } else {
          await sendMessage(
            chatId,
            '❌ Не удалось отправить заявку. Попробуйте позже.',
            getMainMenuKeyboard(telegramId)
          );
        }
        return;
      }
      await notifyAdminsFirstBookingAccessRequest(marked);
      await sendMessage(
        chatId,
        '✉️ Заявка отправлена администратору.\n\nПосле одобрения вы сможете выбрать дату и время консультации в меню «Записаться на консультацию».',
        { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'main_menu' }]] }
      );
      return;
    }

    console.log('📅 handleBookSession: getting available slots');
    const slots = await getAvailableSlots();
    console.log('📅 Raw slots from DB:', JSON.stringify(slots, null, 2));
    console.log('📅 Number of slots:', slots.length);

    const dates = await getAvailableDates();
    console.log('📅 Available dates after processing:', dates);
    console.log('📅 Number of dates:', dates.length);

    if (dates.length === 0) {
      console.log('❌ No available dates - checking slots in DB');
      const allSlotsCheck = await db.query(
        'SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = $1) as free_count FROM slots WHERE date >= CURRENT_DATE',
        ['free']
      );
      console.log('📊 Slots check:', allSlotsCheck.rows[0]);

      await sendMessage(
        chatId,
        '😔 К сожалению, свободных слотов нет.\n\nПопробуйте позже или свяжитесь с психологом напрямую.',
        { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'main_menu' }]] }
      );
      return;
    }

    const keyboard = dates.map((date) => [{
      text: formatDate(date),
      callback_data: `select_date_${date}`,
    }]);
    keyboard.push([{ text: '◀️ Назад', callback_data: 'main_menu' }]);

    console.log('📅 Sending date selection message');
    await sendMessage(
      chatId,
      '🗓 <b>Записаться на консультацию</b>\n\nВыберите день:',
      { inline_keyboard: keyboard }
    );
    console.log('✅ Date selection message sent');
  } catch (error) {
    console.error('❌ Error in handleBookSession:', error);
    throw error;
  }
}

// Handle booking flow - step 2: select time for selected date
async function handleSelectTime(chatId, date) {
  const slots = await getSlotsForDate(date);

  if (slots.length === 0) {
    await sendMessage(
      chatId,
      '😔 К сожалению, на этот день свободных слотов нет.\n\nВыберите другой день.',
      { inline_keyboard: [[{ text: '◀️ Выбрать другой день', callback_data: 'book_session' }]] }
    );
    return;
  }

  const keyboard = slots.map((slot) => {
    const formatIcon = slot.available_formats === 'both' ? '🏠💻' : slot.available_formats === 'offline' ? '🏠' : '💻';
    return [{
      text: `${formatTime(slot.time)} ${formatIcon}`,
      callback_data: `select_slot_${slot.id}`,
    }];
  });
  keyboard.push([{ text: '◀️ Выбрать другой день', callback_data: 'book_session' }]);

  await sendMessage(
    chatId,
    `🕐 <b>${formatDate(date)}</b>\n\nВыберите время:\n\n🏠 — очно, 💻 — онлайн`,
    { inline_keyboard: keyboard }
  );
}

// Handle format selection - step 3: select format based on available_formats
async function handleSelectFormat(chatId, slotId) {
  const slot = await db.getSlotById(slotId);
  const availableFormats = slot?.available_formats || 'both';

  const buttons = [];

  if (availableFormats === 'offline' || availableFormats === 'both') {
    buttons.push([{ text: '🏠 Очно', callback_data: `book_offline_${slotId}` }]);
  }

  if (availableFormats === 'online' || availableFormats === 'both') {
    buttons.push([{ text: '💻 Онлайн', callback_data: `book_online_${slotId}` }]);
  }

  buttons.push([{ text: '◀️ Назад', callback_data: 'book_session' }]);

  await sendMessage(
    chatId,
    '📍 <b>Выберите формат консультации:</b>',
    { inline_keyboard: buttons }
  );
}

// Handle my bookings - only upcoming
async function handleMyBookings(chatId, clientId, telegramId) {
  try {
    console.log('📅 handleMyBookings: getting bookings for clientId:', clientId);
    const bookings = await getClientBookings(clientId);
    console.log('📅 Client bookings:', bookings.length);

    if (bookings.length === 0) {
      console.log('📅 No bookings, sending empty message');
      await sendMessage(
        chatId,
        '🗓 <b>Моя запись</b>\n\nУ вас нет предстоящих записей.\n\nХотите записаться на консультацию?',
        {
          inline_keyboard: [
            [{ text: '📅 Записаться', callback_data: 'book_session' }],
            [{ text: '◀️ Назад', callback_data: 'main_menu' }],
          ]
        }
      );
      console.log('✅ Empty bookings message sent');
      return;
    }

    let text = '🗓 <b>Предстоящие записи:</b>\n\n';
    const keyboard = [];

    for (const booking of bookings) {
      const slot = booking.slots;
      if (slot) {
        const formatIcon = slot.format === 'online' ? '💻' : '🏠';
        text += `📌 ${formatDate(slot.date)} в ${formatTime(slot.time)} ${formatIcon}\n`;
        keyboard.push([{
          text: `❌ Отменить ${formatDate(slot.date)} ${formatTime(slot.time)}`,
          callback_data: `cancel_${booking.id}`,
        }]);
      }
    }

    text += '\n<i>Отменить запись можно не позднее чем за 24 часа до начала.</i>';

    keyboard.push([{ text: '◀️ Назад', callback_data: 'main_menu' }]);

    console.log('📅 Sending bookings list');
    await sendMessage(chatId, text, { inline_keyboard: keyboard });
    console.log('✅ Bookings list sent');
  } catch (error) {
    console.error('❌ Error in handleMyBookings:', error);
    throw error;
  }
}

// Handle diary with buttons
async function handleDiary(chatId, clientId, telegramId) {
  await sendMessage(
    chatId,
    `📒 <b>Дневник терапии</b>\n\nЗдесь вы можете записывать свои мысли, переживания или то, что вас беспокоит. Это останется между нами.`,
    {
      inline_keyboard: [
        [{ text: '➕ Добавить запись', callback_data: 'diary_add' }],
        [{ text: '📖 Посмотреть записи', callback_data: 'diary_view' }],
        [{ text: '◀️ Назад', callback_data: 'main_menu' }]
      ]
    }
  );
}

// Handle view diary entries
async function handleDiaryView(chatId, clientId, telegramId) {
  const entries = await getDiaryEntries(clientId);

  let text = `📖 <b>Ваши записи:</b>\n\n`;

  if (entries.length === 0) {
    text = `📖 <b>Ваши записи:</b>\n\nУ вас пока нет записей в дневнике.`;
  } else {
    for (const entry of entries) {
      const date = new Date(entry.created_at);
      const dateStr = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
      const preview = entry.text.length > 100 ? entry.text.slice(0, 100) + '...' : entry.text;
      text += `📝 <b>${dateStr}:</b>\n${preview}\n\n`;
    }
  }

  await sendMessage(
    chatId,
    text,
    {
      inline_keyboard: [
        [{ text: '➕ Добавить запись', callback_data: 'diary_add' }],
        [{ text: '◀️ Назад в дневник', callback_data: 'diary' }]
      ]
    }
  );
}

// Handle add diary entry
async function handleDiaryAdd(chatId, clientId) {
  await sendMessage(
    chatId,
    `📝 <b>Новая запись</b>\n\nНапишите свои мысли, переживания или то, что вас беспокоит.\n\n<i>Отправьте текст в следующем сообщении.</i>`,
    { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'diary' }]] }
  );

  // Set state for waiting diary entry
  await db.setSetting(`state_${chatId}`, { state: 'waiting_diary' });
}

// Helper function to parse setting value
function parseSettingValue(setting) {
  if (!setting) return '';
  if (typeof setting.value === 'string') {
    try {
      const parsed = JSON.parse(setting.value);
      return parsed.value || parsed.card_number || '';
    } catch {
      return setting.value;
    }
  }
  return setting.value?.value || setting.value?.card_number || '';
}

// Handle payment
async function handlePayment(chatId, clientId) {
  // Get all payment settings
  const paymentLink = await db.getSetting('payment_link');
  const eripPath = await db.getSetting('erip_path');
  const accountNumber = await db.getSetting('account_number');
  const cardSetting = await db.getSetting('payment_card');

  const paymentLinkValue = parseSettingValue(paymentLink);
  const eripPathValue = parseSettingValue(eripPath);
  const accountNumberValue = parseSettingValue(accountNumber);
  const cardNumber = parseSettingValue(cardSetting);

  // Build menu with buttons for available payment methods
  const buttons = [];

  // Online payment link button
  if (paymentLinkValue && paymentLinkValue.trim()) {
    buttons.push([{ text: '🔗 Ссылка на оплату', callback_data: 'payment_link' }]);
  }

  // ERIP button
  if (eripPathValue && eripPathValue.trim()) {
    buttons.push([{ text: '📱 Путь ЕРИП', callback_data: 'payment_erip' }]);
  }

  // Bank account button
  if (accountNumberValue && accountNumberValue.trim()) {
    buttons.push([{ text: '🏦 Номер счёта', callback_data: 'payment_account' }]);
  }

  // Card number button
  if (cardNumber && cardNumber.trim()) {
    buttons.push([{ text: '💳 Номер карты', callback_data: 'payment_card' }]);
  }

  if (buttons.length === 0) {
    await sendMessage(
      chatId,
      '💳 <b>Способы оплаты</b>\n\nСпособы оплаты пока не настроены.',
      { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'main_menu' }]] }
    );
    return;
  }

  // Add back button
  buttons.push([{ text: '◀️ Назад', callback_data: 'main_menu' }]);

  // Send payment menu
  await sendMessage(
    chatId,
    '💳 <b>Выберите способ оплаты:</b>',
    { inline_keyboard: buttons }
  );

  // Set state for waiting payment screenshot
  await db.setSetting(`state_${chatId}`, { state: 'waiting_payment', client_id: clientId });
}

// Handle individual payment method display
async function handlePaymentMethod(chatId, clientId, method) {
  let paymentMessage = '';
  let buttons = [];

  switch (method) {
    case 'payment_link': {
      const paymentLink = await db.getSetting('payment_link');
      const paymentLinkValue = parseSettingValue(paymentLink);
      if (!paymentLinkValue || !paymentLinkValue.trim()) {
        await sendMessage(chatId, '❌ Ссылка на оплату не настроена.', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'payment' }]] });
        return;
      }
      paymentMessage = `🔗 <b>Ссылка на оплату:</b>\n\n<a href="${paymentLinkValue}">${paymentLinkValue}</a>\n\nПосле оплаты пришлите скриншот в этот чат.`;
      buttons = [
        [{ text: '🔗 Перейти к оплате', url: paymentLinkValue }],
        [{ text: '◀️ К способам оплаты', callback_data: 'payment' }]
      ];
      break;
    }
    case 'payment_erip': {
      const eripPath = await db.getSetting('erip_path');
      const eripPathValue = parseSettingValue(eripPath);
      if (!eripPathValue || !eripPathValue.trim()) {
        await sendMessage(chatId, '❌ Путь ЕРИП не настроен.', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'payment' }]] });
        return;
      }
      paymentMessage = `📱 <b>Путь ЕРИП:</b>\n\n`;
      const eripLines = eripPathValue.split('\n').filter(line => line.trim());
      eripLines.forEach(line => {
        paymentMessage += `<code>${line.trim()}</code>\n`;
      });
      paymentMessage += '\nПосле оплаты пришлите скриншот в этот чат.';
      buttons = [[{ text: '◀️ К способам оплаты', callback_data: 'payment' }]];
      break;
    }
    case 'payment_account': {
      const accountNumber = await db.getSetting('account_number');
      const accountNumberValue = parseSettingValue(accountNumber);
      if (!accountNumberValue || !accountNumberValue.trim()) {
        await sendMessage(chatId, '❌ Номер счёта не настроен.', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'payment' }]] });
        return;
      }
      paymentMessage = `🏦 <b>Номер счёта:</b>\n\n<code>${accountNumberValue}</code>\n\nПосле оплаты пришлите скриншот в этот чат.`;
      buttons = [[{ text: '◀️ К способам оплаты', callback_data: 'payment' }]];
      break;
    }
    case 'payment_card': {
      const cardSetting = await db.getSetting('payment_card');
      const cardNumber = parseSettingValue(cardSetting);
      if (!cardNumber || !cardNumber.trim()) {
        await sendMessage(chatId, '❌ Номер карты не настроен.', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'payment' }]] });
        return;
      }
      paymentMessage = `💳 <b>Номер карты:</b>\n\n<code>${cardNumber}</code>\n\nПосле оплаты пришлите скриншот в этот чат.`;
      buttons = [[{ text: '◀️ К способам оплаты', callback_data: 'payment' }]];
      break;
    }
    default:
      await sendMessage(chatId, '❌ Неизвестный способ оплаты.', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'payment' }]] });
      return;
  }

  await sendMessage(chatId, paymentMessage, { inline_keyboard: buttons });
  
  // Set state for waiting payment screenshot
  await db.setSetting(`state_${chatId}`, { state: 'waiting_payment', client_id: clientId });
}

// Handle SOS
async function handleSos(chatId, client) {
  await createSosRequest(client.id, client);

  await sendMessage(
    chatId,
    `🆘 <b>SOS-связь с психологом.</b>

Я передал ваше обращение!`,
    { inline_keyboard: [[{ text: '◀️ В главное меню', callback_data: 'main_menu' }]] }
  );

  // Set state for waiting SOS description
  await db.setSetting(`state_${chatId}`, { state: 'waiting_sos', client_id: client.id });
}

// Handle about me
async function handleAboutMe(chatId, telegramId) {
  try {
    const textSetting = await db.getSetting('about_me_text');
    const photoSetting = await db.getSetting('about_me_photo');
    
    const text = textSetting?.value?.value || textSetting?.value || '';
    const photoUrl = photoSetting?.value?.photo_url || photoSetting?.value || null;

    if (!text && !photoUrl) {
      await sendMessage(
        chatId,
        'ℹ️ Информация "Обо мне" пока не заполнена.',
        { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'main_menu' }]] }
      );
      return;
    }

    // Send photo with caption if both exist
    if (photoUrl && text) {
      await sendPhoto(
        chatId,
        photoUrl,
        text,
        { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'main_menu' }]] }
      );
    } else if (photoUrl) {
      // Only photo
      await sendPhoto(
        chatId,
        photoUrl,
        '',
        { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'main_menu' }]] }
      );
    } else {
      // Only text
      await sendMessage(
        chatId,
        `👤 <b>Обо мне</b>\n\n${text}`,
        { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'main_menu' }]] }
      );
    }
  } catch (error) {
    console.error('Error in handleAboutMe:', error);
    await sendMessage(
      chatId,
      '❌ Произошла ошибка при загрузке информации.',
      { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'main_menu' }]] }
    );
  }
}

// Handle free slots view
async function handleFreeSlots(chatId, telegramId) {
  const slots = await getAvailableSlots();

  if (slots.length === 0) {
    await sendMessage(
      chatId,
      '😔 К сожалению, свободных дат нет.\n\nПопробуйте позже.',
      { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'main_menu' }]] }
    );
    return;
  }

  let text = '📁 <b>Свободные даты:</b>\n\n';
  for (const slot of slots) {
    text += `• ${formatDate(slot.date)} в ${formatTime(slot.time)}\n`;
  }

  text += '\nДля записи нажмите "Записаться на консультацию"';

  await sendMessage(
    chatId,
    text,
    {
      inline_keyboard: [
        [{ text: '📅 Записаться', callback_data: 'book_session' }],
        [{ text: '◀️ Назад', callback_data: 'main_menu' }]
      ]
    }
  );
}

// Handle main menu
async function handleMainMenu(chatId, telegramId) {
  const text = `Вы в главном меню:`;
  await sendMessage(chatId, text, getMainMenuKeyboard(telegramId));
}

// Handle broadcast admin function
async function handleBroadcast(chatId) {
  await sendMessage(
    chatId,
    '📢 <b>Рассылка</b>\n\nОтправьте сообщение, которое хотите разослать всем клиентам.\n\n<i>Для отмены отправьте /cancel</i>',
    { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'main_menu' }]] }
  );

  await db.setSetting(`state_${chatId}`, { state: 'waiting_broadcast' });
}

async function sendBroadcast(text) {
  const clients = await db.getAllClientsForBroadcast();

  if (!clients || clients.length === 0) {
    return 0;
  }

  console.log(`📢 Broadcasting to ${clients.length} clients`);
  let sentCount = 0;
  let failedCount = 0;

  for (const client of clients) {
    try {
      await sendMessage(client.telegram_id, text, null, false);
      sentCount++;
      // Small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (error) {
      failedCount++;
      console.error(`Failed to send to ${client.telegram_id}:`, error.message || error);
    }
  }

  console.log(`📢 Broadcast complete: ${sentCount} sent, ${failedCount} failed out of ${clients.length} total`);
  return sentCount;
}

// Handle text messages
async function handleTextMessage(message, client) {
  const chatId = message.chat.id;
  const text = message.text || '';
  const telegramId = message.from.id;

  // Check for commands
  if (text === '/start' || text === '/menu' || text === '📋 Меню' || text === '📋 Главное меню') {
    await clearState(chatId);
    
    // Принудительно отправляем обычную кнопку под полем ввода
    await sendMessage(chatId, 'Открываю меню...', {
      keyboard: [[{ text: '📋 Главное меню' }]],
      resize_keyboard: true,
      persistent: true
    });

    // Отправляем основное инлайн-меню
    await sendMessage(chatId, 'Выберите нужный раздел:', getMainMenuKeyboard(telegramId));
    return;
  }

  if (text === '/cancel' && isAdmin(telegramId)) {
    await clearState(chatId);
    if (message.message_thread_id && isAdminGroupChat(chatId)) {
      await clearThreadState(chatId, message.message_thread_id);
      await sendMessage(
        chatId,
        'Отменено.',
        null,
        false,
        message.message_thread_id
      );
      return;
    }
    await sendMessage(chatId, 'Отменено', getMainMenuKeyboard(telegramId));
    return;
  }

  if (isAdminGroupChat(chatId) && message.message_thread_id && isAdmin(telegramId)) {
    const threadId = message.message_thread_id;
    const threadState = await getThreadState(chatId, threadId);

    if (threadState?.state === 'waiting_fba_reply') {
      const clientUuid = threadState.clientUuid;
      if (!looksLikeClientUuid(clientUuid)) {
        await clearThreadState(chatId, threadId);
        return;
      }
      const targetClient = await db.getClientById(clientUuid);
      if (!targetClient) {
        await sendMessage(chatId, '❌ Клиент не найден.', null, false, threadId);
        await clearThreadState(chatId, threadId);
        return;
      }

      const adminName = message.from.first_name || 'Админ';
      await sendMessage(
        Number(targetClient.telegram_id),
        `💬 <b>Сообщение от администратора:</b>\n\n${text}`,
        getMainMenuKeyboard(Number(targetClient.telegram_id))
      );
      await sendMessage(
        chatId,
        `✅ <b>${adminName}</b>, сообщение отправлено клиенту.`,
        buildFirstBookingAccessAdminKeyboard(clientUuid),
        false,
        threadId
      );
      await clearThreadState(chatId, threadId);
      return;
    }

    return;
  }

  if (text === '/set_admin_group' && isAdmin(telegramId)) {
    const chatType = message.chat?.type;
    if (chatType !== 'supergroup' && chatType !== 'group') {
      await sendMessage(chatId, 'Команду нужно отправить в группе админов с включёнными темами.', null, false);
      return;
    }
    const ok = await registerAdminGroupChat(chatId, message.chat.title);
    if (ok) {
      await sendMessage(
        chatId,
        `✅ Группа зарегистрирована: <b>${message.chat.title || 'без названия'}</b>\nID: <code>${chatId}</code>\n\nНовые заявки на запись будут создавать темы здесь.`,
        null,
        false,
        message.message_thread_id || undefined
      );
    } else {
      await sendMessage(
        chatId,
        '❌ Не удалось зарегистрировать группу. Включите темы (forum) и дайте боту право «Управление темами».',
        null,
        false,
        message.message_thread_id || undefined
      );
    }
    return;
  }

  if (isAdminGroupChat(chatId)) {
    return;
  }

  // Check current state
  const state = await getState(chatId);

  if (state?.state === 'waiting_diary') {
    await saveDiaryEntry(client.id, text);
    await clearState(chatId);
    await sendMessage(
      chatId,
      '✅ Запись сохранена в дневник.\n\nСпасибо, что делитесь своими мыслями.',
      {
        inline_keyboard: [
          [{ text: '📖 Посмотреть записи', callback_data: 'diary_view' }],
          [{ text: '◀️ В главное меню', callback_data: 'main_menu' }]
        ]
      }
    );
    return;
  }

  if (state?.state === 'waiting_sos') {
    // Update the last SOS request with text
    const sosRequests = await db.query(
      `SELECT id FROM sos_requests 
       WHERE client_id = $1 AND status = 'new' 
       ORDER BY created_at DESC LIMIT 1`,
      [client.id]
    );

    if (sosRequests.rows.length > 0) {
      await db.query(
        'UPDATE sos_requests SET text = $1 WHERE id = $2',
        [text, sosRequests.rows[0].id]
      );
    }

    await clearState(chatId);

    // Notify admin about the additional message
    const name = client.first_name || 'Пользователь';
    const username = client.username ? `@${client.username}` : 'нет username';

    const adminMessage = `📝 <b>Дополнение к SOS</b>

От: ${name} (${username})
🆔 id: ${client.telegram_id}

Сообщение:
${text}`;

    await sendMessageToAllAdmins(adminMessage);

    await sendMessage(
      chatId,
      '✅ Сообщение отправлено психологу.',
      getMainMenuKeyboard(telegramId)
    );
    return;
  }

  if (state?.state === 'waiting_broadcast' && isAdmin(telegramId)) {
    await clearState(chatId);
    await sendMessage(chatId, '⏳ Рассылаю сообщение...', null, false);

    const sentCount = await sendBroadcast(text);

    await sendMessage(
      chatId,
      `✅ Рассылка завершена!\n\nОтправлено: ${sentCount} клиентам`,
      getMainMenuKeyboard(telegramId)
    );
    return;
  }

  const menuButtonTexts = new Set([
    '📋 Главное меню',
    '📋 Меню',
    '🗓 Записаться на консультацию',
    '📁 Свободные даты',
    '🗓 Моя запись',
    '📒 Дневник терапии',
    '💳 Оплата',
    '👤 Обо мне',
    '🆘 SOS',
  ]);

  const freshClient = await db.getClientByTelegramId(telegramId);
  if (
    freshClient?.first_booking_access_requested_at &&
    !freshClient.first_booking_access_approved &&
    text &&
    !text.startsWith('/') &&
    !menuButtonTexts.has(text)
  ) {
    const relayed = await relayClientMessageToFbaTopic(freshClient, text);
    if (relayed) {
      await sendMessage(
        chatId,
        '✉️ Сообщение передано администратору. Ожидайте ответа.',
        { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'main_menu' }]] }
      );
      return;
    }
  }

  // Default response
  await sendMessage(
    chatId,
    'Используйте меню для навигации:',
    getMainMenuKeyboard(telegramId)
  );
}

// Handle callback queries
async function handleCallbackQuery(callbackQuery, client) {
  const chatId = callbackQuery.message?.chat.id;
  const data = callbackQuery.data;
  const telegramId = callbackQuery.from.id;

  console.log('🔔 handleCallbackQuery:', { chatId, telegramId, data, clientId: client.id });

  if (!chatId || !data) {
    console.log('❌ Missing chatId or data in callback query');
    await answerCallbackQuery(callbackQuery.id);
    return;
  }

  await clearState(chatId);
  await answerCallbackQuery(callbackQuery.id);

  if (data === 'main_menu') {
    await handleMainMenu(chatId, telegramId);
    return;
  }

  if (data === 'free_slots') {
    await handleFreeSlots(chatId, telegramId);
    return;
  }

  if (data === 'book_session') {
    try {
      console.log('📅 Calling handleBookSession');
      await handleBookSession(chatId, telegramId, client);
      console.log('✅ handleBookSession completed');
    } catch (error) {
      console.error('❌ Error in handleBookSession:', error);
      await sendMessage(chatId, '❌ Произошла ошибка. Попробуйте позже.', getMainMenuKeyboard(telegramId));
    }
    return;
  }

  if (data === 'my_bookings') {
    try {
      console.log('📅 Calling handleMyBookings');
      await handleMyBookings(chatId, client.id, telegramId);
      console.log('✅ handleMyBookings completed');
    } catch (error) {
      console.error('❌ Error in handleMyBookings:', error);
      await sendMessage(chatId, '❌ Произошла ошибка. Попробуйте позже.', getMainMenuKeyboard(telegramId));
    }
    return;
  }

  if (data === 'diary') {
    await handleDiary(chatId, client.id, telegramId);
    return;
  }

  if (data === 'diary_add') {
    await handleDiaryAdd(chatId, client.id);
    return;
  }

  if (data === 'diary_view') {
    await handleDiaryView(chatId, client.id, telegramId);
    return;
  }

  if (data === 'payment') {
    await handlePayment(chatId, client.id);
    return;
  }

  // Handle individual payment methods
  if (data === 'payment_link' || data === 'payment_erip' || data === 'payment_account' || data === 'payment_card') {
    await handlePaymentMethod(chatId, client.id, data);
    return;
  }

  if (data === 'about_me') {
    await handleAboutMe(chatId, telegramId);
    return;
  }

  if (data === 'sos') {
    await handleSos(chatId, client);
    return;
  }

  if (data === 'admin_broadcast' && isAdmin(telegramId)) {
    await handleBroadcast(chatId);
    return;
  }

  if (data.startsWith('fba_reply_') && isAdmin(telegramId)) {
    const clientUuid = data.slice('fba_reply_'.length);
    if (!looksLikeClientUuid(clientUuid)) {
      await sendMessage(chatId, 'Некорректная заявка.', null, false);
      return;
    }
    const threadId = callbackQuery.message?.message_thread_id;
    if (!threadId || !isAdminGroupChat(chatId)) {
      await sendMessage(chatId, 'Ответить можно только из темы заявки в админ-чате.', null, false);
      return;
    }
    await setThreadState(chatId, threadId, {
      state: 'waiting_fba_reply',
      clientUuid,
      adminTelegramId: telegramId,
    });
    const adminName = callbackQuery.from.first_name || 'Админ';
    await sendMessage(
      chatId,
      `✍️ <b>${adminName}</b>, напишите сообщение в этой теме — бот перешлёт его клиенту.\n\nДля отмены: /cancel`,
      null,
      false,
      threadId
    );
    return;
  }

  if ((data.startsWith('fba_y_') || data.startsWith('fba_n_')) && isAdmin(telegramId)) {
    const clientUuid = data.slice(6);
    const approve = data.startsWith('fba_y_');
    if (!looksLikeClientUuid(clientUuid)) {
      await sendMessage(chatId, 'Некорректная заявка.', null, false);
      return;
    }
    const msg = callbackQuery.message;
    const adminMsgChatId = msg?.chat?.id;
    const adminMsgId = msg?.message_id;
    const threadId = msg?.message_thread_id;
    const adminName = callbackQuery.from.first_name || 'Админ';
    if (approve) {
      const row = await db.approveClientFirstBookingAccess(clientUuid);
      if (row) {
        if (threadId) {
          await clearThreadState(adminMsgChatId, threadId);
        }
        if (adminMsgChatId != null && adminMsgId != null) {
          await editMessageReplyMarkup(adminMsgChatId, adminMsgId, { inline_keyboard: [] });
        }
        const clientTg = Number(row.telegram_id);
        await sendMessage(
          clientTg,
          '✅ <b>Заявка одобрена.</b>\n\nТеперь вы можете открыть «Записаться на консультацию» и выбрать дату и время.',
          getMainMenuKeyboard(clientTg)
        );
        if (threadId && isAdminGroupChat(adminMsgChatId)) {
          await sendMessage(
            adminMsgChatId,
            `✅ <b>${adminName}</b> одобрил(а) запись клиенту.`,
            null,
            false,
            threadId
          );
        } else {
          await sendMessage(chatId, '✅ Доступ к самостоятельной записи предоставлен.', null, false);
        }
      } else {
        await sendMessage(chatId, 'Заявка уже обработана или клиент не найден.', null, false);
      }
    } else {
      const row = await db.rejectClientFirstBookingAccess(clientUuid);
      if (row) {
        if (threadId) {
          await clearThreadState(adminMsgChatId, threadId);
        }
        if (adminMsgChatId != null && adminMsgId != null) {
          await editMessageReplyMarkup(adminMsgChatId, adminMsgId, { inline_keyboard: [] });
        }
        const clientTg = Number(row.telegram_id);
        await sendMessage(
          clientTg,
          '❌ <b>Заявка на запись отклонена.</b>\n\nЕсли это ошибка, свяжитесь с администратором.',
          getMainMenuKeyboard(clientTg)
        );
        if (threadId && isAdminGroupChat(adminMsgChatId)) {
          await sendMessage(
            adminMsgChatId,
            `❌ <b>${adminName}</b> отклонил(а) заявку.`,
            null,
            false,
            threadId
          );
        } else {
          await sendMessage(chatId, 'Заявка отклонена.', null, false);
        }
      } else {
        await sendMessage(chatId, 'Нечего отклонять или заявка уже обработана.', null, false);
      }
    }
    return;
  }

  if ((data.startsWith('fba_y_') || data.startsWith('fba_n_')) && !isAdmin(telegramId)) {
    await sendMessage(chatId, 'Эти действия доступны только администратору.', null, false);
    return;
  }

  // Handle date selection - show times for that date
  if (data.startsWith('select_date_')) {
    if (!(await ensureClientSelfServiceBooking(chatId, telegramId, client))) return;
    const selectedDate = data.replace('select_date_', '');
    await handleSelectTime(chatId, selectedDate);
    return;
  }

  // Handle slot selection - show format options
  if (data.startsWith('select_slot_')) {
    if (!(await ensureClientSelfServiceBooking(chatId, telegramId, client))) return;
    const slotId = data.replace('select_slot_', '');
    await handleSelectFormat(chatId, slotId);
    return;
  }

  // Handle booking with format
  if (data.startsWith('book_offline_') || data.startsWith('book_online_')) {
    if (!(await ensureClientSelfServiceBooking(chatId, telegramId, client))) return;
    const isOnline = data.startsWith('book_online_');
    const slotId = data.replace('book_offline_', '').replace('book_online_', '');
    const format = isOnline ? 'online' : 'offline';

    console.log('📅 Booking request:', { slotId, format, clientId: client.id, callbackData: data });

    const success = await bookSlot(client.id, slotId, format);

    if (success) {
      const formatText = isOnline ? '💻 онлайн' : '🏠 очно';
      await sendMessage(
        chatId,
        `✅ <b>Вы успешно записались!</b>\n\nФормат: ${formatText}\n\nНапоминания придут за 24 часа и за 1 час до сессии.`,
        getMainMenuKeyboard(telegramId)
      );
    } else {
      await sendMessage(
        chatId,
        '😔 К сожалению, это время уже занято.\n\nПожалуйста, выберите другой слот.',
        { inline_keyboard: [[{ text: '📅 Выбрать другое время', callback_data: 'book_session' }]] }
      );
    }
    return;
  }

  if (data.startsWith('cancel_')) {
    const bookingId = data.replace('cancel_', '');
    const result = await cancelBooking(bookingId, false); // false = client cancellation

    if (result.success) {
      await sendMessage(
        chatId,
        '✅ Запись отменена.',
        getMainMenuKeyboard(telegramId)
      );

      // Notify admin about client cancellation
      if (result.slot) {
        const name = client.first_name || 'Клиент';
        const username = client.username ? `@${client.username}` : '';
        await sendMessageToAllAdmins(
          `❌ <b>Клиент отменил запись</b>\n\nКлиент: ${name} ${username}\n🆔 id: ${client.telegram_id}\n\n📆 ${formatDate(result.slot.date)} в ${formatTime(result.slot.time)}`
        );
      }
    } else {
      await sendMessage(
        chatId,
        `❌ ${result.error || 'Не удалось отменить запись. Попробуйте позже.'}`,
        getMainMenuKeyboard(telegramId)
      );
    }
    return;
  }
}

// Main webhook handler
app.post('/webhook', async (req, res) => {
  try {
    const update = req.body;
    console.log('📥 Webhook received:', {
      hasMessage: !!update.message,
      hasCallbackQuery: !!update.callback_query,
      callbackData: update.callback_query?.data,
      messageText: update.message?.text
    });

    if (update.my_chat_member) {
      const mcm = update.my_chat_member;
      const member = mcm.new_chat_member;
      const chat = mcm.chat;
      if (
        member?.is_bot &&
        ['member', 'administrator'].includes(member.status) &&
        chat?.type === 'supergroup' &&
        chat.is_forum
      ) {
        console.log('🤖 Bot added to forum group:', chat.id, chat.title);
        await registerAdminGroupChat(chat.id, chat.title);
      }
    }

    if (update.message) {
      const client = await getOrCreateClient(update.message.from);

      // Handle photos separately from text messages
      if (update.message.photo) {
        console.log('📸 Photo received in webhook');
        const chatId = update.message.chat.id;
        const telegramId = update.message.from.id;
        const state = await getState(chatId);
        console.log('Current state:', state);

        // Handle payment screenshot
        if (state?.state === 'waiting_payment') {
          console.log('✅ State is waiting_payment, processing photo...');
          // Get the largest photo
          const photo = update.message.photo[update.message.photo.length - 1];
          console.log('Photo object:', photo);
          const fileUrl = await getFileUrl(photo.file_id);
          console.log('Got fileUrl from Telegram:', fileUrl);

          if (fileUrl) {
            const success = await savePaymentScreenshot(client.id, fileUrl);

            if (success) {
              await clearState(chatId);
              await sendMessage(
                chatId,
                '✅ Скриншот оплаты получен. Спасибо!',
                getMainMenuKeyboard(telegramId)
              );

              // Notify admin
              const name = client.first_name || 'Пользователь';
              const username = client.username ? `@${client.username}` : '';
              await sendMessageToAllAdmins(
                `💳 <b>Новый скриншот оплаты</b>\n\nОт: ${name} ${username}\n🆔 id: ${client.telegram_id}`
              );
            } else {
              await sendMessage(
                chatId,
                '❌ Ошибка сохранения скриншота. Попробуйте ещё раз.',
                { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'main_menu' }]] }
              );
            }
          } else {
            await sendMessage(
              chatId,
              '❌ Не удалось получить файл. Попробуйте ещё раз.',
              { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'main_menu' }]] }
            );
          }
        }
      } else {
        await handleTextMessage(update.message, client);
      }
    }

    if (update.callback_query) {
      console.log('🔔 Callback query received:', {
        id: update.callback_query.id,
        data: update.callback_query.data,
        from: update.callback_query.from?.id,
        message: update.callback_query.message?.chat?.id
      });
      const client = await getOrCreateClient(update.callback_query.from);
      await handleCallbackQuery(update.callback_query, client);
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('Error processing update:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint for booking client from admin panel
app.post('/book-for-client', async (req, res) => {
  try {
    const { clientId, date, time, format = 'offline' } = req.body;

    if (!clientId || !date || !time) {
      return res.status(400).json({ error: 'clientId, date, and time are required' });
    }

    // Check if date is in the past (only for past dates, not today)
    // Admin can book for any time today or in the future
    const today = new Date().toISOString().split('T')[0];
    const bookingDate = typeof date === 'string' ? date.split('T')[0] : String(date);
    const dateParam = bookingDate;
    
    if (bookingDate < today) {
      return res.status(400).json({ error: 'Нельзя записаться на дату из прошлого' });
    }
    // No time check for today - admin can book for any time today

    // Get client info
    const client = await db.getClientById(clientId);

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Ensure time format is HH:MM:SS for database comparison
    const timeFormatted = time.includes(':') && time.split(':').length === 2 ? `${time}:00` : time;
    const timeLike = time && String(time).length >= 5 ? `${String(time).slice(0, 5)}%` : `${time}%`;
    
    // Check if slot exists for this date and time (compare both HH:MM and HH:MM:SS formats)
    const existingSlotResult = await db.query(
      `SELECT * FROM slots 
       WHERE date = $1::date 
       AND (time = $2::time OR time = $3::time OR time::text LIKE $4)`,
      [dateParam, time, timeFormatted, timeLike]
    );
    const existingSlot = existingSlotResult.rows[0];

    let slotId;

    if (existingSlot) {
      console.log('📅 Existing slot found:', { id: existingSlot.id, status: existingSlot.status, date: existingSlot.date, time: existingSlot.time });
      // Check if slot is free (status should be 'free')
      if (existingSlot.status && existingSlot.status !== 'free') {
        console.log('❌ Slot is already booked:', existingSlot.status);
        return res.status(400).json({ error: 'Слот уже занят' });
      }
      slotId = existingSlot.id;
      console.log('✅ Using existing free slot:', slotId);
    } else {
      console.log('📅 No slot found, creating new one for:', { date: dateParam, time });
      // Create a new slot
      const newSlot = await db.createSlot(dateParam, timeFormatted, 'both');
      if (!newSlot) {
        console.error('❌ Failed to create slot');
        return res.status(500).json({ error: 'Не удалось создать слот' });
      }
      slotId = newSlot.id;
      console.log('✅ New slot created:', slotId);
    }

    // Book the slot
    await db.updateSlot(slotId, { status: 'booked', client_id: clientId, format });
    await db.createBooking(clientId, slotId);

    // Get slot to format date properly
    const slot = await db.getSlotById(slotId);

    // Send notification to client
    const formatText = format === 'online' ? '💻 онлайн' : '🏠 очно';
    const clientMessage = `📅 <b>Вам назначена консультация!</b>

📆 ${formatDate(slot.date)} в ${formatTime(slot.time)}
${formatText}

Напоминания придут за 24 часа и за 1 час до сессии.`;

    await sendMessage(client.telegram_id, clientMessage, null, false);

    res.json({ success: true });
  } catch (error) {
    console.error('Error in book-for-client:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint for creating regular bookings (weekly consultations)
app.post('/create-regular-bookings', async (req, res) => {
  try {
    console.log('📅 create-regular-bookings request:', req.body);
    const { clientId, date, time, weeks = 4, format = 'offline' } = req.body;

    if (!clientId || !date || !time) {
      console.log('❌ Missing required fields:', { clientId, date, time });
      return res.status(400).json({ error: 'clientId, date, and time are required' });
    }

    // Get client info
    const client = await db.getClientById(clientId);
    console.log('📅 Client found:', client ? client.id : 'not found');

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const firstDate = new Date(date);
    firstDate.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Skip past dates
    if (firstDate < today) {
      return res.status(400).json({ error: 'First consultation date must be in the future' });
    }

    let createdCount = 0;
    const errors = [];

    // Create bookings for specified number of weeks
    for (let week = 0; week < weeks; week++) {
      const consultationDate = new Date(firstDate);
      consultationDate.setDate(firstDate.getDate() + (week * 7));
      const dateStr = consultationDate.toISOString().split('T')[0];

      // Skip past dates
      if (consultationDate < today) {
        continue;
      }

      try {
        // Ensure time format is HH:MM:SS for database comparison
        const timeFormatted = time.includes(':') && time.split(':').length === 2 ? `${time}:00` : time;

        // Check if slot exists (compare both HH:MM and HH:MM:SS formats)
        const existingSlotResult = await db.query(
          `SELECT * FROM slots 
           WHERE date = $1 
           AND (time = $2 OR time = $3 OR time::text LIKE $4)`,
          [dateStr, time, timeFormatted, `${time}%`]
        );
        const existingSlot = existingSlotResult.rows[0];

        let slotId;

        if (existingSlot) {
          // Check if slot is free
          if (existingSlot.status !== 'free') {
            errors.push(`${dateStr} ${time} - уже занято`);
            continue;
          }
          slotId = existingSlot.id;
        } else {
          // Create new slot - ensure time format is HH:MM:SS
          const timeFormatted = time.includes(':') && time.split(':').length === 2 ? `${time}:00` : time;
          const slotFormat = format === 'online' ? 'online' : 'offline';
          console.log(`📅 Creating slot: ${dateStr} ${timeFormatted} (${slotFormat})`);
          const newSlot = await db.createSlot(dateStr, timeFormatted, slotFormat);
          if (!newSlot) {
            console.log(`❌ Failed to create slot: ${dateStr} ${timeFormatted}`);
            errors.push(`${dateStr} ${time} - не удалось создать слот`);
            continue;
          }
          slotId = newSlot.id;
          console.log(`✅ Slot created: ${slotId}`);
        }

        // Book the slot with "Регулярный клиент" comment
        console.log(`📅 Booking slot ${slotId} for client ${clientId}`);
        await db.updateSlot(slotId, {
          status: 'booked',
          client_id: clientId,
          format,
          comment: 'Регулярный клиент'
        });
        await db.createBooking(clientId, slotId);
        createdCount++;
        console.log(`✅ Booking created for ${dateStr} ${time}, total: ${createdCount}`);

        // Send notification to client for first consultation only
        if (week === 0) {
          const formatText = format === 'online' ? '💻 онлайн' : '🏠 очно';
          const dateFormatted = formatDate(dateStr);
          await sendMessage(
            client.telegram_id,
            `✅ <b>Вам назначена регулярная консультация!</b>\n\n📅 Первая консультация: ${dateFormatted} в ${formatTime(time)}\n${formatText}\n\nВсего назначено: ${weeks} ${weeks === 1 ? 'консультация' : weeks < 5 ? 'консультации' : 'консультаций'}\n\nНапоминания придут за 24 часа и за 1 час до каждой сессии.`,
            null,
            false
          );
        }
      } catch (error) {
        console.error(`❌ Error creating booking for ${dateStr}:`, error);
        errors.push(`${dateStr} ${time} - ${error.message}`);
      }
    }

    console.log(`📅 Regular bookings creation complete: ${createdCount} created, ${errors.length} errors`);

    if (createdCount === 0) {
      return res.status(400).json({
        error: 'Не удалось создать ни одной консультации',
        errors
      });
    }

    // Notify admin
    const name = client.first_name || 'Клиент';
    const username = client.username ? `@${client.username}` : '';
    await sendMessageToAllAdmins(
      `📅 <b>Назначены регулярные консультации!</b>\n\nКлиент: ${name} ${username}\n🆔 id: ${client.telegram_id}\n\n📆 Первая консультация: ${formatDate(date)} в ${formatTime(time)}\n${format === 'online' ? '💻 онлайн' : '🏠 очно'}\n\nВсего: ${weeks} ${weeks === 1 ? 'консультация' : weeks < 5 ? 'консультации' : 'консультаций'}\nСоздано: ${createdCount}`
    );

    res.json({ success: true, created: createdCount, errors: errors.length > 0 ? errors : undefined });
  } catch (error) {
    console.error('Error in create-regular-bookings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint for canceling booking from admin panel
app.post('/cancel-booking-admin', async (req, res) => {
  try {
    const { slotId } = req.body;

    if (!slotId) {
      return res.status(400).json({ error: 'slotId is required' });
    }

    console.log('Canceling booking for slot:', slotId);

    // Get slot with client info
    const slot = await db.getSlotWithClient(slotId);

    if (!slot) {
      return res.status(404).json({ error: 'Slot not found' });
    }

    const client = slot.telegram_id ? {
      telegram_id: slot.telegram_id,
      first_name: slot.first_name
    } : null;

    // Cancel the booking (update status to 'canceled')
    await db.cancelBookingBySlotId(slotId);

    // Free the slot
    await db.updateSlot(slotId, { status: 'free', client_id: null, format: null });

    // Send notification to client
    if (client?.telegram_id) {
      const name = client.first_name || 'Уважаемый клиент';
      const message = `❌ <b>Запись отменена</b>

${name}, к сожалению, ваша консультация на ${formatDate(slot.date)} в ${formatTime(slot.time)} была отменена.

Пожалуйста, выберите другое удобное время для записи.`;

      await sendMessage(client.telegram_id, message, null, false);
      console.log('Notification sent to client:', client.telegram_id);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error in cancel-booking-admin:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== REST API ENDPOINTS FOR ADMIN PANEL ====================

// GET /api/clients - Get all clients
app.get('/api/clients', async (req, res) => {
  try {
    const clients = await db.getAllClients();
    res.json(clients);
  } catch (error) {
    console.error('Error fetching clients:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/clients/:id - Update client
app.put('/api/clients/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { first_name, last_name } = req.body;

    await db.query(
      'UPDATE clients SET first_name = $1, last_name = $2 WHERE id = $3',
      [first_name || null, last_name || null, id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating client:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/clients/:id - Delete client
app.delete('/api/clients/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get client info before deletion
    const client = await db.getClientById(id);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Get active bookings for this client
    const bookings = await db.getClientBookings(id);

    // Cancel all active bookings and send notifications
    for (const booking of bookings) {
      const slot = await db.getSlotById(booking.slot_id);
      if (slot) {
        // Cancel booking
        await db.cancelBooking(booking.id);
        // Free the slot
        await db.updateSlot(booking.slot_id, { status: 'free', client_id: null, format: null });

        // Send notification to client
        if (client.telegram_id) {
          const name = client.first_name || 'Уважаемый клиент';
          const message = `❌ <b>Запись отменена</b>

${name}, к сожалению, ваша консультация на ${formatDate(slot.date)} в ${formatTime(slot.time)} была отменена.

Пожалуйста, выберите другое удобное время для записи.`;

          try {
            await sendMessage(client.telegram_id, message, null, false);
          } catch (error) {
            console.error('Error sending cancellation notification:', error);
          }
        }
      }
    }

    // Delete client (will cascade delete related records)
    await db.deleteClient(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting client:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/slots - Get slots (future by default, or ?from=&to= for a date range)
app.get('/api/slots', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (from && to) {
      const datePattern = /^\d{4}-\d{2}-\d{2}$/;
      if (!datePattern.test(String(from)) || !datePattern.test(String(to))) {
        return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
      }
      const slots = await db.getSlotsByDateRange(from, to);
      return res.json(slots);
    }

    const today = new Date().toISOString().split('T')[0];
    const slots = await db.getSlots(today);
    res.json(slots);
  } catch (error) {
    console.error('Error fetching slots:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/slots - Create slot
app.post('/api/slots', async (req, res) => {
  try {
    const { date, time, available_formats } = req.body;

    if (!date || !time) {
      return res.status(400).json({ error: 'date and time are required' });
    }

    const slot = await db.createSlot(date, time, available_formats || 'both');

    // If slot already exists (ON CONFLICT DO NOTHING returns null), return existing slot
    if (!slot) {
      const existingSlot = await db.query(
        'SELECT * FROM slots WHERE date = $1 AND time = $2',
        [date, time]
      );
      if (existingSlot.rows[0]) {
        return res.json(existingSlot.rows[0]);
      }
      return res.status(409).json({ error: 'Slot already exists for this date and time' });
    }

    res.json(slot);
  } catch (error) {
    console.error('Error creating slot:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/slots/:id - Delete slot
app.delete('/api/slots/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.deleteSlot(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting slot:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/sos - Get all SOS requests
app.get('/api/sos', async (req, res) => {
  try {
    const requests = await db.getSosRequests();
    res.json(requests);
  } catch (error) {
    console.error('Error fetching SOS requests:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/sos/:id - Mark SOS request as viewed
app.put('/api/sos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.updateSosRequestStatus(id, 'viewed');
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating SOS request:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/payments - Get all payments
app.get('/api/payments', async (req, res) => {
  try {
    const payments = await db.getPayments();
    res.json(payments);
  } catch (error) {
    console.error('Error fetching payments:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/payments/:id - Delete payment
app.delete('/api/payments/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get payment to delete file
    const payments = await db.getPayments();
    const payment = payments.find(p => p.id === id);

    if (payment) {
      const { deletePaymentFile } = require('./storage');
      await deletePaymentFile(payment.screenshot_url);
    }

    await db.deletePayment(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting payment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/bookings/:id - Delete booking (admin only, cancels booking and frees slot)
app.delete('/api/bookings/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get booking info
    const bookingResult = await db.query(
      'SELECT slot_id, client_id FROM bookings WHERE id = $1',
      [id]
    );

    if (!bookingResult.rows[0]) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];
    const slot = await db.getSlotById(booking.slot_id);

    if (slot) {
      // Cancel booking
      await db.cancelBooking(id);
      // Free the slot
      await db.updateSlot(booking.slot_id, { status: 'free', client_id: null, format: null });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting booking:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/payment-card - Get payment card number
app.get('/api/payment-card', async (req, res) => {
  try {
    const setting = await db.getSetting('payment_card');
    const cardNumber = setting && typeof setting.value === 'string'
      ? JSON.parse(setting.value)
      : setting?.value;
    res.json(cardNumber || { card_number: '5208130004581850' });
  } catch (error) {
    console.error('Error fetching payment card:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/payment-card - Save payment card number
app.put('/api/payment-card', async (req, res) => {
  try {
    const { card_number } = req.body;
    await db.setSetting('payment_card', { card_number });
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving payment card:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/payment-settings - Get all payment settings
app.get('/api/payment-settings', async (req, res) => {
  try {
    const paymentLink = await db.getSetting('payment_link');
    const eripPath = await db.getSetting('erip_path');
    const accountNumber = await db.getSetting('account_number');
    const cardNumber = await db.getSetting('payment_card');

    const parseValue = (setting) => {
      if (!setting) return '';
      if (typeof setting.value === 'string') {
        try {
          const parsed = JSON.parse(setting.value);
          return parsed.value || parsed.card_number || '';
        } catch {
          return setting.value;
        }
      }
      return setting.value?.value || setting.value?.card_number || '';
    };

    res.json({
      payment_link: parseValue(paymentLink) || '',
      erip_path: parseValue(eripPath) || '',
      account_number: parseValue(accountNumber) || '',
      card_number: parseValue(cardNumber) || '',
    });
  } catch (error) {
    console.error('Error fetching payment settings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/payment-settings - Save all payment settings
app.put('/api/payment-settings', async (req, res) => {
  try {
    const { payment_link, erip_path, account_number, card_number } = req.body;

    if (payment_link !== undefined) {
      await db.setSetting('payment_link', { value: payment_link || '' });
    }
    if (erip_path !== undefined) {
      await db.setSetting('erip_path', { value: erip_path || '' });
    }
    if (account_number !== undefined) {
      await db.setSetting('account_number', { value: account_number || '' });
    }
    if (card_number !== undefined) {
      await db.setSetting('payment_card', { card_number: card_number || '' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error saving payment settings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/schedule-template - Get schedule template
app.get('/api/schedule-template', async (req, res) => {
  try {
    const template = await db.getSetting('schedule_template');
    const templateData = template && typeof template.value === 'string'
      ? JSON.parse(template.value)
      : template?.value;
    res.json(templateData || { days: [] });
  } catch (error) {
    console.error('Error fetching schedule template:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/about-me - Get about me information
app.get('/api/about-me', async (req, res) => {
  try {
    const textSetting = await db.getSetting('about_me_text');
    const photoSetting = await db.getSetting('about_me_photo');
    
    res.json({
      text: textSetting?.value?.value || textSetting?.value || '',
      photo_url: photoSetting?.value?.photo_url || photoSetting?.value || null
    });
  } catch (error) {
    console.error('Error fetching about me:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /about-me - Save about me information
app.put('/about-me', upload.single('photo'), async (req, res) => {
  try {
    console.log('📝 Saving about me:', {
      hasFile: !!req.file,
      body: req.body,
      removePhoto: req.body?.remove_photo
    });

    const text = req.body?.text || '';
    let photoUrl = null;

    // Handle photo upload
    if (req.file) {
      console.log('📸 Processing photo upload:', {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size
      });
      const extension = req.file.originalname.split('.').pop() || 'jpg';
      photoUrl = await saveAboutMePhoto(req.file.buffer, extension);
      
      if (photoUrl) {
        await db.setSetting('about_me_photo', { photo_url: photoUrl });
        console.log('✅ Photo saved:', photoUrl);
      } else {
        console.error('❌ Failed to save photo');
      }
    } else if (req.body?.remove_photo === 'true') {
      console.log('🗑️ Removing photo');
      // Remove photo if requested
      await deleteAboutMePhoto();
      await db.query('DELETE FROM bot_settings WHERE key = $1', ['about_me_photo']);
      photoUrl = null;
    } else {
      // Keep existing photo
      const existingPhoto = await db.getSetting('about_me_photo');
      photoUrl = existingPhoto?.value?.photo_url || existingPhoto?.value || null;
      console.log('📸 Keeping existing photo:', photoUrl);
    }

    // Save text
    if (text !== undefined) {
      await db.setSetting('about_me_text', { value: text });
      console.log('✅ Text saved:', text.substring(0, 50) + '...');
    }

    res.json({ success: true, text: text || '', photo_url: photoUrl });
  } catch (error) {
    console.error('❌ Error saving about me:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// DELETE /api/schedule-template - Delete schedule template
app.delete('/api/schedule-template', async (req, res) => {
  try {
    await db.query('DELETE FROM bot_settings WHERE key = $1', ['schedule_template']);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting schedule template:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/schedule-template - Save schedule template from current week
app.post('/api/schedule-template', async (req, res) => {
  try {
    // Get all free slots from current week (Monday to Sunday)
    const today = new Date();
    const dayOfWeek = today.getDay();
    const monday = new Date(today);
    monday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    monday.setHours(0, 0, 0, 0);

    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    const mondayStr = monday.toISOString().split('T')[0];
    const sundayStr = sunday.toISOString().split('T')[0];

    console.log('📅 Saving template for week:', mondayStr, 'to', sundayStr);

    // Get ALL slots from current week (not just free ones) to save complete schedule
    const slots = await db.query(
      `SELECT * FROM slots 
       WHERE date >= $1::date AND date <= $2::date
       ORDER BY date, time`,
      [mondayStr, sundayStr]
    );

    console.log('📅 Found slots:', slots.rows.length);
    if (slots.rows.length > 0) {
      console.log('📅 Raw slots from DB:');
      slots.rows.forEach(slot => {
        const dateValue = slot.date instanceof Date ? slot.date.toISOString().split('T')[0] : slot.date;
        console.log(`  - ID: ${slot.id}, Date: ${dateValue}, Time: ${slot.time}, Status: ${slot.status}, Formats: ${slot.available_formats}`);
      });
    } else {
      console.log('📅 No slots found in DB for this week');
    }

    // Group by day of week (0 = Monday, 6 = Sunday)
    const weekDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const template = { days: [] };

    for (let i = 0; i < 7; i++) {
      const dayDate = new Date(monday);
      dayDate.setDate(monday.getDate() + i);
      const dateStr = dayDate.toISOString().split('T')[0];

      // Normalize slot dates for comparison
      const daySlots = slots.rows.filter(slot => {
        const slotDate = slot.date instanceof Date
          ? slot.date.toISOString().split('T')[0]
          : typeof slot.date === 'string'
            ? slot.date.split('T')[0]
            : String(slot.date).split('T')[0];
        return slotDate === dateStr;
      });

      console.log(`📅 ${weekDays[i]} (${dateStr}): ${daySlots.length} slots`);

      if (daySlots.length > 0) {
        template.days.push({
          day: weekDays[i],
          times: daySlots.map(slot => ({
            time: typeof slot.time === 'string' ? slot.time.slice(0, 5) : slot.time,
            available_formats: slot.available_formats || 'both'
          }))
        });
      }
    }

    console.log('📅 Template structure:', JSON.stringify(template, null, 2));

    await db.setSetting('schedule_template', template);
    res.json({ success: true, template });
  } catch (error) {
    console.error('❌ Error saving schedule template:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// POST /api/schedule-template/apply - Apply template to weeks
app.post('/api/schedule-template/apply', async (req, res) => {
  try {
    const { weeks = 1 } = req.body;

    console.log('📅 Applying template for', weeks, 'weeks');

    const template = await db.getSetting('schedule_template');
    const templateData = template && typeof template.value === 'string'
      ? JSON.parse(template.value)
      : template?.value;

    console.log('📅 Template data:', JSON.stringify(templateData, null, 2));

    if (!templateData || !templateData.days || templateData.days.length === 0) {
      console.log('❌ No template saved');
      return res.status(400).json({ error: 'No template saved' });
    }

    const weekDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

    // Calculate next Monday (that hasn't arrived yet) - ALWAYS start from next week
    let daysUntilMonday;
    if (dayOfWeek === 0) {
      // Today is Sunday, next Monday is tomorrow (1 day) - but we want NEXT week, so +8
      daysUntilMonday = 8;
    } else if (dayOfWeek === 1) {
      // Today is Monday, next Monday is next week (7 days)
      daysUntilMonday = 7;
    } else {
      // Today is Tuesday-Saturday, next Monday is (8 - dayOfWeek) days away
      daysUntilMonday = 8 - dayOfWeek;
    }

    const startMonday = new Date(today);
    startMonday.setDate(today.getDate() + daysUntilMonday);
    startMonday.setHours(0, 0, 0, 0);

    const startMondayStr = startMonday.toISOString().split('T')[0];
    console.log(`📅 Today: ${today.toISOString().split('T')[0]} (day of week: ${dayOfWeek}), Next Monday for template: ${startMondayStr}`);

    let createdCount = 0;

    // Apply template for specified number of weeks (always start from next Monday)
    for (let week = 0; week < weeks; week++) {
      const weekMonday = new Date(startMonday);
      weekMonday.setDate(startMonday.getDate() + (week * 7));

      const weekMondayStr = weekMonday.toISOString().split('T')[0];
      console.log(`📅 Processing week ${week + 1}, Monday: ${weekMondayStr} (day of week: ${weekMonday.getDay()})`);

      for (const dayTemplate of templateData.days) {
        const dayIndex = weekDays.indexOf(dayTemplate.day);
        if (dayIndex === -1) {
          console.log(`⚠️ Unknown day: ${dayTemplate.day}`);
          continue;
        }

        const slotDate = new Date(weekMonday);
        slotDate.setDate(weekMonday.getDate() + dayIndex);
        slotDate.setHours(0, 0, 0, 0);
        const dateStr = slotDate.toISOString().split('T')[0];

        // Skip past dates
        if (slotDate < today) {
          console.log(`⏭️ Skipping past date: ${dateStr} (is ${slotDate < today ? 'past' : 'future'})`);
          continue;
        }

        console.log(`📅 Processing ${dayTemplate.day} (${dateStr}) with ${dayTemplate.times.length} time slots`);

        for (const timeSlot of dayTemplate.times) {
          try {
            const timeStr = typeof timeSlot.time === 'string' ? timeSlot.time : String(timeSlot.time);
            const formats = timeSlot.available_formats || 'both';
            console.log(`📅 Creating slot: ${dateStr} ${timeStr} (${formats})`);

            // Check if slot already exists (including booked slots)
            const existingSlot = await db.query(
              'SELECT * FROM slots WHERE date = $1 AND time = $2',
              [dateStr, timeStr]
            );

            if (existingSlot.rows.length > 0) {
              // Slot exists - only update formats if it's free
              if (existingSlot.rows[0].status === 'free') {
                if (existingSlot.rows[0].available_formats !== formats) {
                  await db.query(
                    'UPDATE slots SET available_formats = $1 WHERE id = $2',
                    [formats, existingSlot.rows[0].id]
                  );
                  console.log(`✅ Updated slot formats: ${dateStr} ${timeStr}`);
                } else {
                  console.log(`ℹ️ Slot already exists (free): ${dateStr} ${timeStr}`);
                }
              } else {
                console.log(`ℹ️ Slot already exists (booked): ${dateStr} ${timeStr}`);
              }
            } else {
              // Slot doesn't exist - create it
              const slot = await db.createSlot(dateStr, timeStr, formats);
              if (slot) {
                createdCount++;
                console.log(`✅ Slot created: ${slot.id} - ${dateStr} ${timeStr}`);
              } else {
                // createSlot returns null on conflict, but we already checked, so this shouldn't happen
                console.log(`⚠️ Failed to create slot (conflict?): ${dateStr} ${timeStr}`);
              }
            }
          } catch (error) {
            console.error(`❌ Error creating slot: ${dateStr} ${timeSlot.time} - ${error.message}`);
          }
        }
      }
    }

    console.log(`✅ Template applied. Created ${createdCount} slots`);
    res.json({ success: true, created: createdCount });
  } catch (error) {
    console.error('❌ Error applying schedule template:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// GET /api/diary - Get all diary entries
app.get('/api/diary', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT d.*, 
       c.first_name, c.last_name, c.username
     FROM diary_entries d
     JOIN clients c ON d.client_id = c.id
     ORDER BY d.created_at DESC
     LIMIT 50`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching diary entries:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Initialize storage on startup
const PORT = process.env.PORT || 3000;

const REMINDER_TICK_MS = parseInt(process.env.REMINDER_TICK_MS ?? '60000', 10);

let reminderTickBusy = false;

async function runBookingReminderTick() {
  if (reminderTickBusy) return;
  reminderTickBusy = true;
  try {
    const rows = await db.getActiveBookingsForReminders();
    const nowMs = Date.now();
    let sent24 = 0;
    let sent1 = 0;
    for (const row of rows) {
      const dateStr = row.slot_date ? String(row.slot_date).slice(0, 10) : '';
      const timeStr = row.slot_time ? String(row.slot_time).trim() : '';
      if (!dateStr || !timeStr || row.telegram_id == null) continue;

      const remainingSec = reminderLogic.remainingUntilSlotSec(dateStr, timeStr, nowMs);
      if (!Number.isFinite(remainingSec)) continue;

      const name = row.first_name || 'Уважаемый клиент';
      const dateRu = reminderLogic.formatSlotCalendarDateRu(dateStr);
      const timeShort = reminderLogic.normalizeSlotTimeString(timeStr).slice(0, 5);

      if (!row.reminder_24h_sent && reminderLogic.in24hReminderBand(remainingSec)) {
        const msg =
          `⏰ <b>Напоминание</b>\n\n${name}, завтра у вас консультация!\n\n📅 ${dateRu} в ${timeShort}\n\nДо встречи! 🙌`;
        console.log(
          `📬 24h reminder booking=${row.id} tg=${row.telegram_id} remainingMin≈${Math.round(remainingSec / 60)}`,
        );
        const result = await sendMessage(row.telegram_id, msg, null, false);
        if (result.ok) {
          await db.query('UPDATE bookings SET reminder_24h_sent = true WHERE id = $1', [row.id]);
          sent24++;
        }
      }

      if (!row.reminder_1h_sent && reminderLogic.in1hReminderBand(remainingSec)) {
        const msg =
          `⏰ <b>Напоминание</b>\n\n${name}, через 1 час у вас консультация!\n\n📅 ${dateRu} в ${timeShort}\n\nДо встречи! 🙌`;
        console.log(
          `📬 1h reminder booking=${row.id} tg=${row.telegram_id} remainingMin≈${Math.round(remainingSec / 60)}`,
        );
        const result = await sendMessage(row.telegram_id, msg, null, false);
        if (result.ok) {
          await db.query('UPDATE bookings SET reminder_1h_sent = true WHERE id = $1', [row.id]);
          sent1++;
        }
      }
    }
    if (sent24 > 0 || sent1 > 0) {
      console.log(`📬 Reminders sent: ${sent24}×24h, ${sent1}×1h (checked ${rows.length} active bookings)`);
    }
  } catch (err) {
    console.error('❌ runBookingReminderTick:', err);
  } finally {
    reminderTickBusy = false;
  }
}

app.listen(PORT, async () => {
  console.log(`Bot server running on port ${PORT}`);
  
  // Настройка команд и кнопки меню глобально при запуске
  try {
    await setMyCommands();
    await setChatMenuButton();
    console.log('✓ Global bot commands and menu button initialized');
  } catch (error) {
    console.error('❌ Error initializing bot commands:', error);
  }

  await initStorage();
  console.log('✓ Storage initialized');

  try {
    await loadAdminGroupChatId();
  } catch (error) {
    console.error('❌ Error loading admin group chat:', error);
  }

  if (REMINDER_TICK_MS > 0) {
    setInterval(runBookingReminderTick, REMINDER_TICK_MS);
    runBookingReminderTick().catch((e) => console.error('❌ Initial reminder tick:', e));
    console.log(`✓ Booking reminders: tick every ${REMINDER_TICK_MS / 1000}s (PostgreSQL на этом сервере)`);
  } else {
    console.log('ℹ️ Booking reminders disabled (REMINDER_TICK_MS=0)');
  }
});
