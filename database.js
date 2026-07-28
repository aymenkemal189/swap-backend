const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'swap_database.db');

async function setupDatabase() {
    const SQL = await initSqlJs();
    let db;

    if (fs.existsSync(dbPath)) {
        const filebuffer = fs.readFileSync(dbPath);
        db = new SQL.Database(filebuffer);
    } else {
        db = new SQL.Database();
    }

    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            username TEXT,
            first_name TEXT,
            balance REAL DEFAULT 0.0,
            ads_watched_today INTEGER DEFAULT 0,
            total_ads_watched INTEGER DEFAULT 0,
            last_ad_date TEXT,
            last_checkin TEXT,
            channel_joined INTEGER DEFAULT 0,
            referred_by INTEGER
        );

        CREATE TABLE IF NOT EXISTS activities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            title TEXT,
            amount REAL,
            status TEXT,
            date TEXT
        );

        CREATE TABLE IF NOT EXISTS withdrawals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            method TEXT,
            account TEXT,
            amount REAL,
            status TEXT,
            date TEXT
        );
    `);

    // Helper Functions for Promise Compatibility
    const save = () => {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(dbPath, buffer);
    };

    return {
        get: async (sql, params = []) => {
            const stmt = db.prepare(sql);
            stmt.bind(params);
            if (stmt.step()) {
                const row = stmt.getAsObject();
                stmt.free();
                return row;
            }
            stmt.free();
            return null;
        },
        all: async (sql, params = []) => {
            const stmt = db.prepare(sql);
            stmt.bind(params);
            const results = [];
            while (stmt.step()) {
                results.push(stmt.getAsObject());
            }
            stmt.free();
            return results;
        },
        run: async (sql, params = []) => {
            db.run(sql, params);
            save();
            return { lastID: db.exec("SELECT last_insert_rowid()")[0]?.values[0][0] };
        }
    };
}

module.exports = setupDatabase;


