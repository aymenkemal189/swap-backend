require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const setupDatabase = require('./database');

const app = express();

// 1. CORS Setup (ከTelegram Mini App የሚመጡ ጥሪዎችን ለመፍቀድ)
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Telegram-Init-Data', 'Authorization']
}));

app.use(express.json());

// 2. Frontend HTML እና Static ፋይሎችን ማቅረቢያ
app.use(express.static(path.join(__dirname)));

let db;

// 3. Telegram Authentication Middleware
function verifyTelegramWebAppData(req, res, next) {
    const initData = req.headers['x-telegram-init-data'];
    
    // በልማት (Development) ወቅት ወይም initData ከሌለ ለመሞከር
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
        if (!botToken) {
            console.warn("⚠️ BOT_TOKEN በ Render Environment Variables ላይ አልተካተተም!");
        }

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

// Helper: ተጠቃሚውን ከዳታቤዝ መፈለግ ወይም መፍጠር
async function getOrCreateUser(tgUser) {
    let user = await db.get('SELECT * FROM users WHERE id = ?', [tgUser.id]);
    if (!user) {
        await db.run(
            'INSERT INTO users (id, username, first_name) VALUES (?, ?, ?)',
            [tgUser.id, tgUser.username || '', tgUser.first_name || '']
        );
        user = await db.get('SELECT * FROM users WHERE id = ?', [tgUser.id]);
    }
    // የቀን Ad limit reset ማድረግ
    if (user.last_ad_date !== todayStr()) {
        await db.run('UPDATE users SET ads_watched_today = 0, last_ad_date = ? WHERE id = ?', [todayStr(), user.id]);
        user.ads_watched_today = 0;
    }
    return user;
}

// Routes
app.get('/api/state', verifyTelegramWebAppData, async (req, res) => {
    try {
        const user = await getOrCreateUser(req.user);
        const activities = await db.all('SELECT * FROM activities WHERE user_id = ? ORDER BY id DESC LIMIT 15', [user.id]);
        const referrals = await db.all('SELECT id, first_name as name, 1 as active FROM users WHERE referred_by = ?', [user.id]);
        const withdrawals = await db.all('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC', [user.id]);

        res.json({
            balance: user.balance,
            adsWatchedToday: user.ads_watched_today,
            totalAdsWatched: user.total_ads_watched,
            dailyAdLimit: 15,
            lastCheckin: user.last_checkin,
            channelJoined: Boolean(user.channel_joined),
            activity: activities,
            referrals: referrals,
            withdrawals: withdrawals
        });
    } catch (e) {
        console.error("Error in /api/state:", e);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/watch-ad', verifyTelegramWebAppData, async (req, res) => {
    try {
        const user = await getOrCreateUser(req.user);
        if (user.ads_watched_today >= 15) {
            return res.status(400).json({ error: 'የዕለቱ የማስታወቂያ ገደብ አልቋል' });
        }

        const rewards = [2, 3, 2.5, 4, 3.5, 5];
        const reward = rewards[user.ads_watched_today % rewards.length];

        await db.run(
            'UPDATE users SET balance = balance + ?, ads_watched_today = ads_watched_today + 1, total_ads_watched = total_ads_watched + 1 WHERE id = ?',
            [reward, user.id]
        );

        await db.run(
            'INSERT INTO activities (user_id, title, amount, status, date) VALUES (?, ?, ?, ?, ?)',
            [user.id, `Ad #${user.ads_watched_today + 1}`, reward, 'ተጠናቋል', new Date().toISOString()]
        );

        res.json({ success: true, reward });
    } catch (e) {
        console.error("Error in /api/watch-ad:", e);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/checkin', verifyTelegramWebAppData, async (req, res) => {
    try {
        const user = await getOrCreateUser(req.user);
        if (user.last_checkin === todayStr()) {
            return res.status(400).json({ error: 'ዛሬ አስቀድመው ወስደዋል' });
        }

        const reward = 5.0;
        await db.run('UPDATE users SET balance = balance + ?, last_checkin = ? WHERE id = ?', [reward, todayStr(), user.id]);
        await db.run('INSERT INTO activities (user_id, title, amount, status, date) VALUES (?, ?, ?, ?, ?)', [user.id, 'ዕለታዊ ቦነስ', reward, 'ተጠናቋል', new Date().toISOString()]);

        res.json({ success: true, reward });
    } catch (e) {
        console.error("Error in /api/checkin:", e);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/join-channel', verifyTelegramWebAppData, async (req, res) => {
    try {
        const user = await getOrCreateUser(req.user);
        if (user.channel_joined) {
            return res.status(400).json({ error: 'አስቀድመው ወስደዋል' });
        }

        const reward = 25.0;
        await db.run('UPDATE users SET balance = balance + ?, channel_joined = 1 WHERE id = ?', [reward, user.id]);
        await db.run('INSERT INTO activities (user_id, title, amount, status, date) VALUES (?, ?, ?, ?, ?)', [user.id, 'ቻናል የተቀላቀሉበት', reward, 'ተጠናቋል', new Date().toISOString()]);

        res.json({ success: true, reward });
    } catch (e) {
        console.error("Error in /api/join-channel:", e);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const topUsers = await db.all('SELECT username, first_name, balance FROM users ORDER BY balance DESC LIMIT 10');
        res.json(topUsers);
    } catch (e) {
        console.error("Error in /api/leaderboard:", e);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/withdraw', verifyTelegramWebAppData, async (req, res) => {
    try {
        const { method, account, amount } = req.body;
        const user = await getOrCreateUser(req.user);

        if (amount < 500) return res.status(400).json({ error: 'አነስተኛ ማውጫ 500 ETB ነው' });
        if (user.balance < amount) return res.status(400).json({ error: 'በቂ ቀሪ ሂሳብ የለዎትም' });

        await db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, user.id]);
        await db.run(
            'INSERT INTO withdrawals (user_id, method, account, amount, status, date) VALUES (?, ?, ?, ?, ?, ?)',
            [user.id, method, account, amount, 'በሂደት ላይ', new Date().toISOString()]
        );
        await db.run(
            'INSERT INTO activities (user_id, title, amount, status, date) VALUES (?, ?, ?, ?, ?)',
            [user.id, `ወደ ${method} ማውጣት`, -amount, 'በሂደት ላይ', new Date().toISOString()]
        );

        res.json({ success: true });
    } catch (e) {
        console.error("Error in /api/withdraw:", e);
        res.status(500).json({ error: 'Server error' });
    }
});

// 4. Any other route serves index.html (Frontend fallback)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 5. Start Server
setupDatabase().then(database => {
    db = database;
    const PORT = process.env.PORT || 10000;
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}).catch(err => {
    console.error(" Database Connection Failed:", err);
});

