require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const setupDatabase = require('./database'); 

const app = express(); 

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Telegram-Init-Data', 'Authorization']
})); 

app.use(express.json()); 
app.use(express.static(path.join(__dirname))); 

let db; 

function verifyTelegramWebAppData(req, res, next) {
    const initData = req.headers['x-telegram-init-data']; 
    if (!initData) {
        req.user = { id: 123456789, username: 'testuser', first_name: 'Test' };
        return next();
    } 
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash'); 
        const dataCheckString = Array.from(urlParams.entries())
            .map(([key, value]) => `${key}=${value}`)
            .sort()
            .join('\n'); 
        const botToken = process.env.BOT_TOKEN || '';
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex'); 
        if (calculatedHash === hash) {
            req.user = JSON.parse(urlParams.get('user'));
            return next();
        } else {
            return res.status(403).json({ error: 'invalid_auth' });
        }
    } catch (e) {
        return res.status(400).json({ error: 'bad_request' });
    }
} 

const todayStr = () => new Date().toISOString().slice(0, 10); 

async function getOrCreateUser(tgUser) {
    let user = await db.get('SELECT * FROM users WHERE id = ?', [tgUser.id]);
    if (!user) {
        await db.run(
            'INSERT INTO users (id, username, first_name) VALUES (?, ?, ?)',
            [tgUser.id, tgUser.username || '', tgUser.first_name || '']
        );
        user = await db.get('SELECT * FROM users WHERE id = ?', [tgUser.id]);
    }
    if (user.last_ad_date !== todayStr()) {
        await db.run('UPDATE users SET ads_watched_today = 0, last_ad_date = ? WHERE id = ?', [todayStr(), user.id]);
        user.ads_watched_today = 0;
    }
    return user;
} 

app.get('/api/state', verifyTelegramWebAppData, async (req, res) => {
    try {
        const user = await getOrCreateUser(req.user);
        const activities = await db.all('SELECT * FROM activities WHERE user_id = ? ORDER BY id DESC LIMIT 15', [user.id]);
        const referrals = await db.all('SELECT id, first_name as name, 1 as active FROM users WHERE referred_by = ?', [user.id]);
        const withdrawals = await db.all('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC', [user.id]); 
        res.json({ balance: user.balance, adsWatchedToday: user.ads_watched_today, totalAdsWatched: user.total_ads_watched, dailyAdLimit: 15, lastCheckin: user.last_checkin, channelJoined: Boolean(user.channel_joined), activity: activities, referrals: referrals, withdrawals: withdrawals });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
}); 

app.get('/api/leaderboard', async (req, res) => {
    try {
        const topUsers = await db.all('SELECT username, first_name, balance FROM users ORDER BY balance DESC LIMIT 10');
        res.json(topUsers);
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
}); 

// የ Express 4 Frontend Fallback (ያለ ስህተት የሚሰራ)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
}); 

setupDatabase().then(database => {
    db = database;
    const PORT = process.env.PORT || 10000;
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));
}).catch(err => console.error("Database Connection Failed:", err));


