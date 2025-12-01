// index.js

// 1. Muat environment variables
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const basicAuth = require('express-basic-auth');
const cookieParser = require('cookie-parser');

const webhookRouter = require('./webhook');
const dashboardRouter = require('./dashboard');
const privacyRouter = require('./privacy');

const app = express();
app.set('view engine', 'ejs');
app.use(bodyParser.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(cookieParser());

// 2. Import Module Wajib
const http = require('http');
const { Server } = require("socket.io");
const { PrismaClient } = require('@prisma/client'); // Ganti Mongoose dengan Prisma

// 3. Import Modul Aplikasi Lokal
const { initializeAi } = require('./gen_ai'); // Import fungsi Init AI

// 4. Inisialisasi Prisma Client (Sesuai diskusi Prisma Versi 7)
const prisma = new PrismaClient();

// 5. Setup Server HTTP & Socket.io
const PORT = process.env.PORT || 3000; // Railway akan mengisi PORT ini otomatis
const server = http.createServer(app);
const io = new Server(server);

// BASIC AUTH untuk Dashboard Admin
const basicAuthMiddleware = basicAuth({
    users: { 
        [process.env.ADMIN_USER || 'admin']: process.env.ADMIN_PASS || 'rahasia123' 
    },
    challenge: true,
    unauthorizedResponse: 'Akses Ditolak: Password salah atau sesi habis.'
});

// Middleware untuk proteksi dashboard dengan sesi cookie + Basic Auth
const sessionAuth = (req, res, next) => {
    // 1. Cek apakah user punya cookie 'dashboard_session' yang valid
    if (req.cookies.dashboard_session) {
        // Jika cookie ada, berarti dia sudah login < 24 jam yang lalu. Loloskan.
        return next();
    }

    // 2. Jika tidak ada cookie (atau expired), jalankan Basic Auth
    basicAuthMiddleware(req, res, () => {
        // 3. Jika Basic Auth sukses (password benar), kita SET cookie baru
        // MaxAge: 24 jam * 60 menit * 60 detik * 1000 ms = 86400000 ms
        res.cookie('dashboard_session', 'active', { 
            maxAge: 24 * 60 * 60 * 1000, 
            httpOnly: true // Aman, tidak bisa diakses JS browser
        });
        
        // Lanjut ke dashboard
        next();
    });
};

// 6. SETUP DEPENDENCY INJECTION (PENTING)
// Kita simpan 'io' dan 'prisma' ke dalam 'app' agar bisa diakses di file lain (webhook.js / dashboard.js)
// Cara pakainya nanti di file lain: const prisma = req.app.get('prisma');
app.set('io', io);
app.set('prisma', prisma);

app.use('/', webhookRouter);
app.use('/dashboard', sessionAuth, dashboardRouter);
app.use('/privacy', privacyRouter);

// Event debug saat Dashboard terkoneksi
io.on('connection', (socket) => {
    console.log('⚡ Dashboard connected (Socket.io)');
});

/**
 * Fungsi Utama: Start Server
 * Urutan: Connect DB -> Init AI -> Start Listen
 */
async function startServer() {
  try {
    console.log("⏳ Memulai server...");

    // Langkah A: Cek Koneksi Database (Prisma)
    await prisma.$connect();
    console.log("✅ Database PostgreSQL terhubung (via Prisma).");

    // Langkah B: Siapkan AI (baca PDF)
    await initializeAi();
    
    // Langkah C: Jalankan Server
    server.listen(PORT, () => {
      console.log(`🚀 Server Bot WA berjalan di port ${PORT}`);
      console.log(`🔗 Dashboard akses lokal: http://localhost:${PORT}/dashboard`);
    });

  } catch (error) {
    console.error("💥 Gagal memulai server:", error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

// Menangani shutdown graceful (ctrl+c)
process.on('SIGINT', async () => {
    await prisma.$disconnect();
    process.exit(0);
});

startServer();