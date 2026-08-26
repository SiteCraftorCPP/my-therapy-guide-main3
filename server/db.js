// Database helper module for PostgreSQL (replacing Supabase)
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'liftme_bot',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

// Test connection
pool.on('connect', () => {
  console.log('✓ Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('❌ Unexpected error on idle client', err);
  process.exit(-1);
});

// Helper function to execute queries
async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (process.env.NODE_ENV === 'development') {
      console.log('Executed query', { text, duration, rows: res.rowCount });
    }
    return res;
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  }
}

// Client operations
async function getClientByTelegramId(telegramId) {
  const result = await query(
    'SELECT * FROM clients WHERE telegram_id = $1',
    [telegramId]
  );
  return result.rows[0] || null;
}

async function createClient(telegramUser) {
  const result = await query(
    `INSERT INTO clients (telegram_id, first_name, last_name, username, first_booking_access_approved)
     VALUES ($1, $2, $3, $4, false)
     RETURNING *`,
    [
      telegramUser.id,
      telegramUser.first_name || null,
      telegramUser.last_name || null,
      telegramUser.username || null,
    ]
  );
  return result.rows[0];
}

async function getClientById(id) {
  const result = await query('SELECT * FROM clients WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function countClientBookings(clientId) {
  const result = await query(
    'SELECT COUNT(*)::int AS c FROM bookings WHERE client_id = $1',
    [clientId]
  );
  return result.rows[0].c;
}

/** Самозапись: одобрение админа или история записей до модерации (без активной заявки). */
async function clientCanSelfServiceBook(clientId) {
  const client = await getClientById(clientId);
  if (!client) return false;
  if (client.first_booking_access_approved === true) return true;
  // Заявка на рассмотрении — запись запрещена, даже если успели создать booking в обход UI
  if (client.first_booking_access_requested_at != null) return false;
  const n = await countClientBookings(clientId);
  if (n > 0) return true;
  return false;
}

async function markClientFirstBookingAccessRequested(clientId) {
  const result = await query(
    `UPDATE clients
     SET first_booking_access_requested_at = now()
     WHERE id = $1::uuid
       AND first_booking_access_approved = false
       AND first_booking_access_requested_at IS NULL
     RETURNING *`,
    [clientId]
  );
  return result.rows[0] || null;
}

async function approveClientFirstBookingAccess(clientId) {
  const result = await query(
    `UPDATE clients
     SET first_booking_access_approved = true,
         first_booking_access_requested_at = NULL
     WHERE id = $1::uuid
       AND first_booking_access_approved = false
     RETURNING *`,
    [clientId]
  );
  return result.rows[0] || null;
}

async function rejectClientFirstBookingAccess(clientId) {
  const result = await query(
    `UPDATE clients
     SET first_booking_access_requested_at = NULL
     WHERE id = $1::uuid
       AND first_booking_access_approved = false
       AND first_booking_access_requested_at IS NOT NULL
     RETURNING *`,
    [clientId]
  );
  return result.rows[0] || null;
}

async function deleteClient(id) {
  await query('DELETE FROM clients WHERE id = $1', [id]);
}

async function getAllClients() {
  const result = await query(
    `SELECT c.*, 
       COUNT(DISTINCT b.id) as bookings_count,
       COUNT(DISTINCT d.id) as diary_count
     FROM clients c
     LEFT JOIN bookings b ON c.id = b.client_id AND b.status = 'active'
     LEFT JOIN diary_entries d ON c.id = d.client_id
     GROUP BY c.id
     ORDER BY c.created_at DESC`
  );
  return result.rows;
}

// Slot operations
async function getAvailableSlots(limit = 30) {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const currentTime = now.toTimeString().slice(0, 5); // HH:MM
  
  const result = await query(
    `SELECT * FROM slots
     WHERE status = 'free' 
     AND (
       date > $1::date 
       OR (date = $1::date AND time::text >= $2)
     )
     ORDER BY date ASC, time ASC
     LIMIT $3`,
    [today, currentTime, limit]
  );
  return result.rows;
}

async function getSlotsForDate(date) {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const currentTime = now.toTimeString().slice(0, 5); // HH:MM
  const slotDate = typeof date === 'string' ? date.split('T')[0] : (date instanceof Date ? date.toISOString().split('T')[0] : String(date));
  
  let result;
  if (slotDate === today) {
    // For today, filter by time - only show slots that haven't passed yet
    result = await query(
      `SELECT * FROM slots
       WHERE status = 'free' AND date = $1::date AND time::text >= $2
       ORDER BY time ASC`,
      [slotDate, currentTime]
    );
  } else {
    // For future dates, no time filtering needed
    result = await query(
      `SELECT * FROM slots
       WHERE status = 'free' AND date = $1::date AND date >= $2::date
       ORDER BY time ASC`,
      [slotDate, today]
    );
  }
  return result.rows;
}

async function getSlotById(slotId) {
  const result = await query('SELECT * FROM slots WHERE id = $1', [slotId]);
  return result.rows[0] || null;
}

async function getSlotWithClient(slotId) {
  const result = await query(
    `SELECT s.*, 
       c.telegram_id, c.first_name, c.last_name, c.username
     FROM slots s
     LEFT JOIN clients c ON s.client_id = c.id
     WHERE s.id = $1`,
    [slotId]
  );
  return result.rows[0] || null;
}

async function updateSlot(slotId, updates) {
  const fields = [];
  const values = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = $${paramIndex}`);
    values.push(value);
    paramIndex++;
  }
  values.push(slotId);

  const result = await query(
    `UPDATE slots SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  return result.rows[0];
}

async function createSlot(date, time, availableFormats = 'both') {
  const dateNorm = typeof date === 'string' ? date.split('T')[0] : String(date).split('T')[0];
  const timeNorm = time && String(time).includes(':') && String(time).split(':').length === 2
    ? `${time}:00`
    : time;

  const result = await query(
    `INSERT INTO slots (date, time, available_formats)
     VALUES ($1::date, $2::time, $3)
     ON CONFLICT (date, time) DO NOTHING
     RETURNING *`,
    [dateNorm, timeNorm, availableFormats]
  );
  if (result.rows[0]) {
    return result.rows[0];
  }
  // Row already exists (concurrent create or find missed a format) — return it
  const shortTime = (time && String(time).slice(0, 5)) || '';
  const existing = await query(
    `SELECT * FROM slots
     WHERE date = $1::date
     AND (time = $2::time OR time = $3::time OR time::text LIKE $4)`,
    [dateNorm, time, timeNorm, shortTime ? `${shortTime}%` : '%']
  );
  return existing.rows[0] || null;
}

async function deleteSlot(slotId) {
  await query('DELETE FROM slots WHERE id = $1', [slotId]);
}

async function getSlots(cutoffDate) {
  const result = await query(
    `SELECT s.*, 
       c.first_name, c.last_name, c.username, c.telegram_id
     FROM slots s
     LEFT JOIN clients c ON s.client_id = c.id
     WHERE s.date >= $1
     ORDER BY s.date ASC, s.time ASC`,
    [cutoffDate]
  );
  return result.rows;
}

async function getSlotsByDateRange(fromDate, toDate) {
  const result = await query(
    `SELECT s.*, 
       c.first_name, c.last_name, c.username, c.telegram_id
     FROM slots s
     LEFT JOIN clients c ON s.client_id = c.id
     WHERE s.date >= $1::date AND s.date <= $2::date
     ORDER BY s.date DESC, s.time ASC`,
    [fromDate, toDate]
  );
  return result.rows;
}

// Booking operations
async function getClientBookings(clientId) {
  const result = await query(
    `SELECT b.*, s.date, s.time, s.format
     FROM bookings b
     JOIN slots s ON b.slot_id = s.id
     WHERE b.client_id = $1 AND b.status = 'active'
     ORDER BY b.created_at DESC`,
    [clientId]
  );
  return result.rows;
}

async function getBookingBySlotId(slotId) {
  const result = await query(
    'SELECT * FROM bookings WHERE slot_id = $1 AND status = $2',
    [slotId, 'active']
  );
  return result.rows[0] || null;
}

async function createBooking(clientId, slotId) {
  const result = await query(
    `INSERT INTO bookings (client_id, slot_id, status)
     VALUES ($1, $2, 'active')
     RETURNING *`,
    [clientId, slotId]
  );
  return result.rows[0];
}

async function cancelBookingBySlotId(slotId) {
  await query(
    `UPDATE bookings SET status = 'canceled' 
     WHERE slot_id = $1 AND status = 'active'`,
    [slotId]
  );
}

async function cancelBooking(bookingId) {
  const result = await query(
    `UPDATE bookings SET status = 'canceled' 
     WHERE id = $1 AND status = 'active'
     RETURNING *`,
    [bookingId]
  );
  return result.rows[0] || null;
}

/** Активные записи для напоминаний (локальная PG, та же что и бот). */
async function getActiveBookingsForReminders() {
  const result = await query(`
    SELECT
      b.id,
      b.reminder_1h_sent,
      b.reminder_24h_sent,
      c.telegram_id,
      c.first_name,
      s.date::text AS slot_date,
      s.time::text AS slot_time
    FROM bookings b
    JOIN clients c ON c.id = b.client_id
    JOIN slots s ON s.id = b.slot_id
    WHERE b.status = 'active'
  `);
  return result.rows;
}

// Diary operations
async function getDiaryEntries(clientId, limit = 5) {
  const result = await query(
    `SELECT * FROM diary_entries
     WHERE client_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [clientId, limit]
  );
  return result.rows;
}

async function createDiaryEntry(clientId, text) {
  const result = await query(
    `INSERT INTO diary_entries (client_id, text)
     VALUES ($1, $2)
     RETURNING *`,
    [clientId, text]
  );
  return result.rows[0];
}

// SOS operations
async function createSosRequest(clientId, text) {
  const result = await query(
    `INSERT INTO sos_requests (client_id, text, status)
     VALUES ($1, $2, 'new')
     RETURNING *`,
    [clientId, text]
  );
  return result.rows[0];
}

async function getSosRequests(status = null) {
  let queryText = `
    SELECT sr.*, 
       c.first_name, c.last_name, c.username, c.telegram_id
     FROM sos_requests sr
     JOIN clients c ON sr.client_id = c.id
  `;
  const params = [];
  if (status) {
    queryText += ' WHERE sr.status = $1';
    params.push(status);
  }
  queryText += ' ORDER BY sr.created_at DESC';
  
  const result = await query(queryText, params);
  return result.rows;
}

async function updateSosRequestStatus(id, status) {
  const result = await query(
    `UPDATE sos_requests SET status = $1 WHERE id = $2 RETURNING *`,
    [status, id]
  );
  return result.rows[0];
}

// Payment operations
async function createPayment(clientId, screenshotUrl) {
  const result = await query(
    `INSERT INTO payments (client_id, screenshot_url)
     VALUES ($1, $2)
     RETURNING *`,
    [clientId, screenshotUrl]
  );
  return result.rows[0];
}

async function getPayments(clientId = null) {
  let queryText = `
    SELECT p.*, 
       c.first_name, c.last_name, c.username, c.telegram_id
     FROM payments p
     JOIN clients c ON p.client_id = c.id
  `;
  const params = [];
  if (clientId) {
    queryText += ' WHERE p.client_id = $1';
    params.push(clientId);
  }
  queryText += ' ORDER BY p.created_at DESC';
  
  const result = await query(queryText, params);
  return result.rows;
}

async function deletePayment(id) {
  await query('DELETE FROM payments WHERE id = $1', [id]);
}

// Bot settings operations
async function getSetting(key) {
  const result = await query(
    'SELECT * FROM bot_settings WHERE key = $1',
    [key]
  );
  return result.rows[0] || null;
}

async function setSetting(key, value) {
  const result = await query(
    `INSERT INTO bot_settings (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) 
     DO UPDATE SET value = $2, updated_at = now()
     RETURNING *`,
    [key, JSON.stringify(value)]
  );
  return result.rows[0];
}

async function getAllClientsForBroadcast() {
  const result = await query('SELECT telegram_id FROM clients');
  return result.rows.map(row => ({ telegram_id: row.telegram_id }));
}

module.exports = {
  pool,
  query,
  // Client
  getClientByTelegramId,
  getClientById,
  createClient,
  countClientBookings,
  clientCanSelfServiceBook,
  markClientFirstBookingAccessRequested,
  approveClientFirstBookingAccess,
  rejectClientFirstBookingAccess,
  getAllClients,
  deleteClient,
  // Slot
  getAvailableSlots,
  getSlotsForDate,
  getSlotById,
  getSlotWithClient,
  updateSlot,
  createSlot,
  deleteSlot,
  getSlots,
  getSlotsByDateRange,
  // Booking
  getClientBookings,
  getBookingBySlotId,
  createBooking,
  cancelBookingBySlotId,
  cancelBooking,
  getActiveBookingsForReminders,
  // Diary
  getDiaryEntries,
  createDiaryEntry,
  // SOS
  createSosRequest,
  getSosRequests,
  updateSosRequestStatus,
  // Payment
  createPayment,
  getPayments,
  deletePayment,
  // Settings
  getSetting,
  setSetting,
  // Broadcast
  getAllClientsForBroadcast,
};
