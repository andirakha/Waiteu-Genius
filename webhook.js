// webhook.js

const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const { generateResponse } = require("./gen_ai");

const router = express.Router();

// Ambil data dari file .env
const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;

// Fungsi ini akan mencegat setiap pesan masuk.
// Jika bukan dari WhatsApp asli, pesan akan ditolak langsung.
function validateSignature(req, res, next) {
    const signature = req.headers['x-hub-signature-256'];

    if (!signature) {
        console.warn("⚠️ Peringatan: Request tanpa signature ditolak.");
        return res.status(401).send("Signature missing");
    }

    if (!req.rawBody) {
        return res.status(500).send("Raw body missing (Check index.js config)");
    }

    // Buat hash dari body pesan menggunakan App Secret kita
    const hash = crypto
        .createHmac('sha256', APP_SECRET)
        .update(req.rawBody)
        .digest('hex');

    // Bandingkan hash kita dengan signature dari Meta
    const expectedSignature = `sha256=${hash}`;

    // Menggunakan timingSafeEqual agar aman dari serangan waktu (timing attacks)
    const trusted = Buffer.from(signature, 'utf8');
    const untrusted = Buffer.from(expectedSignature, 'utf8');

    if (trusted.length !== untrusted.length || !crypto.timingSafeEqual(trusted, untrusted)) {
        console.error("⛔ Bahaya: Signature tidak cocok! Request palsu ditolak.");
        return res.status(403).send("Invalid signature");
    }

    // Jika lolos, lanjut ke proses berikutnya
    next();
}

// =============== VERIFIKASI WEBHOOK ===============
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ WEBHOOK_VERIFIED");
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// =============== ENDPOINT UTAMA WEBHOOK ===============
router.post("/webhook", validateSignature, async (req, res) => {
  const body = req.body;
  // Ambil instance Prisma yang sudah di-inject dari index.js
  const prisma = req.app.get('prisma'); 
  const io = req.app.get('io');

  if (body.object) {
    if (
      body.entry &&
      body.entry[0].changes &&
      body.entry[0].changes[0].value.messages
    ) {
      const value = body.entry[0].changes[0].value;
      const message = value.messages[0];
      const from = message.from;
      const msg_body = message.text?.body?.trim();
      
      // Ambil nama profil jika ada
      const contactName = value.contacts?.[0]?.profile?.name || from;

      if (msg_body) {
        console.log(`💬 Pesan dari ${contactName} (${from}): ${msg_body}`);

        try {
            // 1. UPDATE/CREATE CONTACT (Upsert Logic)
            // Kita coba cari dulu, kalau ada update, kalau tidak ada create
            // Gunakan 'upsert' agar lebih efisien di SQL
            const contact = await prisma.contact.upsert({
                where: { waId: from },
                update: {
                    lastInteraction: new Date(),
                    name: contactName // Update nama kalau user ganti nama di WA
                },
                create: {
                    waId: from,
                    phone: from,
                    name: contactName,
                    lastInteraction: new Date()
                }
            });

            // 2. GET/CREATE CONVERSATION
            // Cari percakapan status 'OPEN' (Huruf Besar sesuai Schema!)
            let conversation = await prisma.conversation.findFirst({
                where: {
                    contactWaId: from,
                    status: 'OPEN' 
                }
            });

            if (!conversation) {
                conversation = await prisma.conversation.create({
                    data: {
                        contactWaId: from,
                        status: 'OPEN',
                        startedAt: new Date()
                    }
                });
                console.log('📂 Percakapan baru dimulai.');
            }

            // 3. SAVE INCOMING MESSAGE
            // Perhatikan: Gunakan HURUF BESAR untuk Enum (INCOMING, TEXT)
            const incoming = await prisma.message.create({
                data: {
                    contactWaId: from,
                    conversationId: conversation.id, // Pakai .id bukan ._id
                    direction: 'INCOMING', 
                    type: 'TEXT',
                    text: msg_body,
                    waMessageId: message.id,
                    timestamp: new Date(parseInt(message.timestamp) * 1000)
                }
            });
            console.log('📥 Riwayat pesan MASUK disimpan.');

            await prisma.contact.update({
                where: { waId: from },
                data: {
                    lastMessageId: incoming.id, // Link ke ID pesan yang baru dibuat
                    lastInteraction: new Date() // Pastikan tanggal terupdate
                }
            });

            if (io) {
                io.emit('new_message', incoming);
                io.emit('update_contact', from);
            }

            // 4. PROSES AI
            // PENTING: Oper 'prisma' ke fungsi generateResponse
            const botReply = await generateResponse(prisma, from, msg_body);
            console.log("🤖 Respon dari model:", botReply);

            // 5. KIRIM & SIMPAN BALASAN
            // Oper 'prisma' ke fungsi sendReply juga
            await sendReply(prisma, from, botReply, conversation.id);

            if (io) {
                // Ambil pesan terakhir (outgoing) utk diupdate di dashboard
                const lastMsg = await prisma.message.findFirst({
                    where: { conversationId: conversation.id },
                    orderBy: { timestamp: 'desc' }
                });
                if(lastMsg) {
                    io.emit('new_message', lastMsg);
                    io.emit('update_contact', from);
                }
            }

        } catch (error) {
            console.error("❌ Error saat proses webhook:", error);
            
            // Fallback error handling
            try {
                const errorConv = await prisma.conversation.findFirst({ 
                    where: { contactWaId: from, status: 'OPEN' } 
                });
                if (errorConv) {
                    await sendReply(prisma, from, "Maaf, terjadi error di server saya 🙏", errorConv.id);
                }
            } catch (e) {
                console.error("Gagal mengirim pesan error:", e.message);
            }
        }
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// =============== FUNGSI KIRIM BALASAN ===============
// Sekarang menerima parameter 'prisma' agar bisa save ke DB
async function sendReply(prisma, to, text, conversationId) {
  try {
    // 1. Kirim ke API WhatsApp
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("✔️ Pesan balasan berhasil dikirim ke WA!");

    // 2. Simpan Pesan Keluar ke Database (Prisma)
    if (conversationId) {
        try {
          const outgoing = await prisma.message.create({
            data: {
                contactWaId: to,
                conversationId: conversationId,
                direction: 'OUTGOING', // Huruf Besar!
                type: 'TEXT',          // Huruf Besar!
                text: text,
                timestamp: new Date()
            }
          });
          console.log('📤 Riwayat pesan KELUAR disimpan.');
          await prisma.contact.update({
            where: { waId: to },
            data: {
                lastMessageId: outgoing.id,
                lastInteraction: new Date()
            }
          });
        } catch (dbError) {
          console.error("❌ Error simpan pesan keluar:", dbError.message);
        }
    } else {
        console.warn("⚠️ Pesan keluar terkirim tapi tidak disimpan karena conversationId null");
    }

  } catch (error) {
    console.error("❌ Error kirim pesan Axios:", error.response?.data || error.message);
  }
}

module.exports = router;