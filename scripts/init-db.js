require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

const INIT_SQL = `
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
`;

console.log("Initializing PostgreSQL database...");
pool.query(INIT_SQL)
    .then(() => {
        console.log("✅ Database schema initialized successfully.");
        process.exit(0);
    })
    .catch((err) => {
        console.error("❌ Failed to initialize schema:", err.message);
        process.exit(1);
    });
