// dashboard.js
const express = require('express');
const router = express.Router();

// ================= API ENDPOINTS (Backend Data) =================

// 1. API: Ambil daftar kontak (diurutkan dari interaksi terakhir)
// UPDATE: Menambahkan penghitungan jumlah pesan belum dibaca (unreadCount)
router.get('/api/contacts', async (req, res) => {
    try {
        const prisma = req.app.get('prisma'); 
        
        const contacts = await prisma.contact.findMany({
            orderBy: { lastInteraction: 'desc' },
            include: {
                lastMessage: {
                    select: {
                        text: true,
                        type: true,
                        direction: true, // Penting untuk logic "You:"
                        timestamp: true
                    }
                },
                _count: {
                    select: {
                        messages: {
                            where: {
                                isRead: false,        // Hanya yang belum dibaca
                                direction: 'INCOMING' // Hanya pesan masuk (pesan kita sendiri tidak dihitung)
                            }
                        }
                    }
                }
            }
        });
        
        // Mapping data supaya formatnya lebih bersih dikirim ke frontend
        // Kita keluarkan _count.messages menjadi field 'unreadCount' di root object
        const formattedContacts = contacts.map(contact => {
            const { _count, ...rest } = contact; // Pisahkan _count dari sisa data
            return {
                ...rest,
                unreadCount: _count.messages // Masukkan jumlah unread ke sini
            };
        });

        res.json(formattedContacts);
    } catch (err) {
        console.error("Error fetching contacts:", err);
        res.status(500).json({ error: "Gagal memuat kontak" });
    }
});

// 2. API: Ambil pesan berdasarkan waId kontak
router.get('/api/messages/:waId', async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const { waId } = req.params;
        
        // Ambil pesan, urutkan dari terlama ke terbaru (ASC)
        const messages = await prisma.message.findMany({
            where: { contactWaId: waId },
            orderBy: { timestamp: 'asc' }
        });
        
        res.json(messages);
    } catch (err) {
        console.error("Error fetching messages:", err);
        res.status(500).json({ error: "Gagal memuat pesan" });
    }
});

// 3. API BARU: Tandai pesan sudah dibaca (Mark as Read)
// Endpoint ini dipanggil ketika user mengklik kontak di sidebar
router.post('/api/messages/mark-read/:waId', async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const { waId } = req.params;

        // Update semua pesan INCOMING dari waId ini yang belum dibaca menjadi isRead = true
        await prisma.message.updateMany({
            where: {
                contactWaId: waId,
                isRead: false,
                direction: 'INCOMING'
            },
            data: {
                isRead: true
            }
        });

        res.json({ success: true, message: "Messages marked as read" });
    } catch (err) {
        console.error("Error marking messages read:", err);
        res.status(500).json({ error: "Gagal update status baca" });
    }
});

// ================= FRONTEND ROUTE =================

// 4. Render Halaman Utama
router.get('/', (req, res) => {
    res.render('dashboard'); 
});

module.exports = router;