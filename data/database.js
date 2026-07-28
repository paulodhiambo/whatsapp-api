"use strict";

const { Pool } = require("pg");

// Use DATABASE_URL or individual PG env variables.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

console.log("[DB] Initializing PostgreSQL pool");

// Initialize table asynchronously on boot
pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
        wa_id              VARCHAR(255) PRIMARY KEY,
        state              VARCHAR(255) NOT NULL DEFAULT '',
        otp                VARCHAR(50) NOT NULL DEFAULT '',
        submitted_phone    VARCHAR(50) NOT NULL DEFAULT '',
        last_input         TEXT NOT NULL DEFAULT '',
        last_selected_item VARCHAR(255) NOT NULL DEFAULT '',
        last_selected_code VARCHAR(255) NOT NULL DEFAULT '',
        start_date         VARCHAR(100) NOT NULL DEFAULT '',
        external_doc_no    VARCHAR(100) NOT NULL DEFAULT '',
        complaint_order_id VARCHAR(255) NOT NULL DEFAULT '',
        complaint_selected_at VARCHAR(100) NOT NULL DEFAULT '',
        complaint_submitted_at VARCHAR(100) NOT NULL DEFAULT '',
        complaint_text_length INTEGER NOT NULL DEFAULT 0,
        updated_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
`).catch((err) => {
    console.error("[DB] Error creating user_sessions table:", err.message);
});

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 6 * 60 * 60 * 1000; // 6 hours

// In-process cache
const cache = new Map();
const CACHE_TTL = 1_800_000; // 30 minutes

function cacheInvalidate(wa_id) {
    cache.delete(wa_id);
}

function cacheSet(wa_id, data) {
    cache.set(wa_id, { data, expiresAt: Date.now() + CACHE_TTL });
}

async function dbFetchDirect(wa_id) {
    try {
        const res = await pool.query("SELECT * FROM user_sessions WHERE wa_id = $1", [wa_id]);
        return res.rows[0] || null;
    } catch (err) {
        console.error("[DB] Direct fetch error:", err.message);
        return null;
    }
}

function hasSessionExpired(row) {
    if (!row?.updated_at) return false;
    const ageMs = Date.now() - new Date(row.updated_at).getTime();
    return ageMs > SESSION_TTL_MS;
}

const dbProvider = {
    async get(wa_id) {
        const cached = cache.get(wa_id);
        if (cached && Date.now() < cached.expiresAt) {
            console.log(`[DB] cache hit wa_id=${wa_id}`);
            return cached.data;
        }

        console.log(`[DB] cache miss wa_id=${wa_id} — querying postgres`);
        try {
            const row = await dbFetchDirect(wa_id);
            if (row && hasSessionExpired(row)) {
                console.log(`[DB] Session expired for wa_id=${wa_id}, clearing session.`);
                await dbProvider.clear(wa_id);
                return null;
            }
            if (row) cacheSet(wa_id, row);
            return row;
        } catch (err) {
            console.error(`[DB] Get error for wa_id=${wa_id}:`, err.message, err.stack);
            return null;
        }
    },

    async save(wa_id, data = {}) {
        cacheInvalidate(wa_id);
        const current = (await dbFetchDirect(wa_id)) || {};

        const merged = {
            wa_id,
            state:                  data.state              ?? current.state              ?? "",
            otp:                data.otp                ?? current.otp                ?? "",
            submitted_phone:    data.submitted_phone    ?? current.submitted_phone    ?? "",
            last_input:         data.last_input         ?? current.last_input         ?? "",
            last_selected_item: data.last_selected_item ?? current.last_selected_item ?? "",
            last_selected_code: data.last_selected_code ?? current.last_selected_code ?? "",
            start_date:         data.start_date         ?? current.start_date         ?? "",
            external_doc_no:    data.external_doc_no    ?? current.external_doc_no    ?? "",
            complaint_order_id: data.complaint_order_id ?? current.complaint_order_id ?? "",
            complaint_selected_at: data.complaint_selected_at ?? current.complaint_selected_at ?? "",
            complaint_submitted_at: data.complaint_submitted_at ?? current.complaint_submitted_at ?? "",
            complaint_text_length: data.complaint_text_length ?? current.complaint_text_length ?? 0,
        };

        const values = [
            merged.wa_id,
            merged.state,
            merged.otp,
            merged.submitted_phone,
            merged.last_input,
            merged.last_selected_item,
            merged.last_selected_code,
            merged.start_date,
            merged.external_doc_no,
            merged.complaint_order_id,
            merged.complaint_selected_at,
            merged.complaint_submitted_at,
            merged.complaint_text_length,
        ];

        const savedAt = Date.now();
        try {
            await pool.query(`
                INSERT INTO user_sessions
                    (wa_id, state, otp, submitted_phone, last_input,
                     last_selected_item, last_selected_code, start_date, external_doc_no,
                     complaint_order_id, complaint_selected_at, complaint_submitted_at, complaint_text_length,
                     updated_at)
                VALUES
                    ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP)
                ON CONFLICT (wa_id) DO UPDATE SET
                    state              = EXCLUDED.state,
                    otp                = EXCLUDED.otp,
                    submitted_phone    = EXCLUDED.submitted_phone,
                    last_input         = EXCLUDED.last_input,
                    last_selected_item = EXCLUDED.last_selected_item,
                    last_selected_code = EXCLUDED.last_selected_code,
                    start_date         = EXCLUDED.start_date,
                    external_doc_no    = EXCLUDED.external_doc_no,
                    complaint_order_id = EXCLUDED.complaint_order_id,
                    complaint_selected_at = EXCLUDED.complaint_selected_at,
                    complaint_submitted_at = EXCLUDED.complaint_submitted_at,
                    complaint_text_length = EXCLUDED.complaint_text_length,
                    updated_at         = CURRENT_TIMESTAMP
            `, values);

            const updatedRow = await dbFetchDirect(wa_id);
            cacheSet(wa_id, updatedRow || { ...merged, updated_at: new Date().toISOString() });
            console.log(`[DB] save wa_id=${wa_id} state='${merged.state}' took=${Date.now() - savedAt}ms`);
        } catch (err) {
            console.error(`[DB] Save error for wa_id=${wa_id}:`, err.message, err.stack);
        }
    },

    async resetToMain(wa_id) {
        cacheInvalidate(wa_id);
        try {
            await pool.query(`
                UPDATE user_sessions SET
                    state              = '',
                    otp                = '',
                    last_selected_item = '',
                    last_selected_code = '',
                    start_date         = '',
                    external_doc_no    = '',
                    complaint_order_id = '',
                    complaint_selected_at = '',
                    complaint_submitted_at = '',
                    complaint_text_length = 0,
                    updated_at         = CURRENT_TIMESTAMP
                    WHERE wa_id = $1
            `, [wa_id]);
        } catch (err) {
            console.error("[DB] Reset error:", err.message);
        }
    },

    async clearAllStates() {
        cache.clear();
        try {
            await pool.query("DELETE FROM user_sessions");
            console.log("[DB] All user states have been reset to default.");
        } catch (err) {
            console.error("[DB] ClearAllStates error:", err.message);
        }
    },

    async clear(wa_id) {
        cacheInvalidate(wa_id);
        try {
            await pool.query("DELETE FROM user_sessions WHERE wa_id = $1", [wa_id]);
        } catch (err) {
            console.error("[DB] Delete error:", err.message);
        }
    },
};

module.exports = dbProvider;
