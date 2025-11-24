// gen_ai.js

// Impor library
const fs = require('fs');
const pdf = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getShippingCosts } = require('./raja_ongkir');

// Inisialisasi Model AI dari environment variable
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const mainModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
const routerModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

// Variabel untuk menyimpan konteks
let konteksProduk = null;

/**
 * Memuat konteks dari file PDF. (Fungsi ini tetap sama)
 */
async function initializeAi() {
  try {
    const filePath = './data_produk.pdf';
    console.log("⏳ Memuat informasi produk dari PDF...");
    
    if (!fs.existsSync(filePath)) {
        console.error(`❌ File PDF tidak ditemukan di: ${filePath}`);
        process.exit(1);
    }

    const dataBuffer = fs.readFileSync(filePath);
    
    // Versi 1.1.1 penggunaannya sangat simpel:
    const data = await pdf(dataBuffer);
    
    konteksProduk = data.text;
    console.log("✅ Konteks PDF berhasil dimuat.");
  } catch (error) {
    console.error("❌ Gagal memuat PDF:", error.message);
    process.exit(1); 
  }
}

// BARU: Fungsi untuk memformat riwayat chat dari DB
/**
 * Mengonversi riwayat DB menjadi string sederhana untuk prompt.
 * @param {Array} dbHistory - Array dokumen dari MongoDB
 * @returns {string} - String riwayat chat
 */
function formatHistoryForPrompt(dbHistory) {
    if (!dbHistory || dbHistory.length === 0) {
        return "Belum ada riwayat percakapan.";
    }
    
    return dbHistory.map(msg => {
        // Field 'text' sesuai schema.prisma
        const txt = msg.text || "[Media/File]";
        // Field 'direction' di Prisma kita set Enum (INCOMING/OUTGOING)
        // Kita handle case-insensitive biar aman
        const dir = (msg.direction || "").toLowerCase();
        
        if (dir === 'incoming') {
            return `Pelanggan: ${txt}`;
        } else {
            return `Anda: ${txt}`;
        }
    }).join('\n');
}

async function classifyUserIntent(pertanyaanUser) {
  
  const promptKlasifikasi = `
    Anda adalah sistem NLU (Natural Language Understanding) untuk toko online.
    Tugas Anda adalah mem-parsing pesan pelanggan dan mengklasifikasikannya.

    Ada dua INTENT:
    1. "Order_Pesanan": Jika pesan pelanggan *terlihat* seperti order dan menggunakan format "nama:", "alamat:", dan "jumlah barang:".
    2. "Chat_Biasa": Untuk SEMUA pesan lainnya.

    Jika intent "Order_Pesanan" (meskipun tidak lengkap), ekstrak data berikut.
    Jika "Chat_Biasa", set semua data ke 'null'.

    FORMAT OUTPUT HARUS JSON:
    {
      "intent": "...",
      "nama": "...",
      "alamat_lengkap": "...", // Ekstrak semua teks setelah "alamat:"
      "kecamatan": "...", // Ekstrak "kec." dari dalam string alamat
      "kabupaten_kota": "...", // Ekstrak "kab/kota" dari dalam string alamat
      "provinsi": "...", // Ekstrak "prov" dari dalam string alamat
      "jumlah_barang": ... // Ekstrak ANGKA dari "jumlah barang:"
    }

    ATURAN EKSTRAKSI (PENTING):
    - "alamat_lengkap": Ambil *seluruh* string setelah "alamat:".
    - "kecamatan", "kabupaten_kota", "provinsi": Lihat di dalam string "alamat_lengkap" dan ekstrak nilainya. Cari kata kunci "kec.", "kab.", "kota", "prov.".
    - "jumlah_barang": HARUS berupa ANGKA (integer).
    - Jika ada field yang tidak ditemukan, nilainya HARUS 'null'.

    Contoh 1 (Lengkap):
    Pesan: "nama: Budi Santoso\nalamat: Jl. Mawar no 5, kec. Cibeber, kota Cilegon, prov. Banten\njumlah barang: 3"
    Output: {
      "intent": "Order_Pesanan",
      "nama": "Budi Santoso",
      "alamat_lengkap": "Jl. Mawar no 5, kec. Cibeber, kota Cilegon, prov. Banten",
      "kecamatan": "Cibeber",
      "kabupaten_kota": "Cilegon",
      "provinsi": "Banten",
      "jumlah_barang": 3
    }

    Contoh 2 (Tidak Lengkap):
    Pesan: "Saya mau order.\nnama: Budi Santoso\nalamat: Jl. Mawar no 5, Cilegon"
    Output: {
      "intent": "Order_Pesanan",
      "nama": "Budi Santoso",
      "alamat_lengkap": "Jl. Mawar no 5, Cilegon",
      "kecamatan": null,
      "kabupaten_kota": "Cilegon",
      "provinsi": null,
      "jumlah_barang": null
    }

    Contoh 3 (Chat Biasa):
    Pesan: "Halo, produknya ready?"
    Output: {
      "intent": "Chat_Biasa",
      "nama": null,
      "alamat_lengkap": null,
      "kecamatan": null,
      "kabupaten_kota": null,
      "provinsi": null,
      "jumlah_barang": null
    }

    ---
    Pesan Pelanggan (BARU): "${pertanyaanUser}"
    Output (HANYA JSON):
  `;

  try {
    const result = await routerModel.generateContent(promptKlasifikasi);
    const responseText = await result.response.text();
    
    // Membersihkan dan parsing JSON
    const jsonString = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
    const intentInfo = JSON.parse(jsonString);
    
    console.log(`(ROUTER) Intent awal terdeteksi: ${intentInfo.intent}`);
    return intentInfo;

  } catch (error) {
    console.error("❌ Gagal mengklasifikasikan intent:", error);
    // Jika gagal, kembalikan sebagai Chat_Biasa
    return { 
      intent: "Chat_Biasa", 
      nama: null, 
      alamat_lengkap: null, 
      kecamatan: null, 
      kabupaten_kota: null, 
      provinsi: null, 
      jumlah_barang: null 
    };
  }
}

/**
 * Fungsi utama untuk menghasilkan jawaban dari AI.
 * DIUBAH: Sekarang menerima userId dan pertanyaanUser
 * @param {string} userId - Nomor WA unik (misal: 62812xxx)
 * @param {string} pertanyaanUser - Pertanyaan yang diterima dari user.
 * @returns {Promise<string>} - Jawaban yang dihasilkan oleh model AI.
 */
async function generateResponse(prisma, userId, pertanyaanUser) {
  if (!konteksProduk) {
    console.error("AI belum diinisialisasi. Jalankan initializeAi() terlebih dahulu.");
    return "Maaf, sistem saya sedang mengalami kendala. Silakan coba lagi nanti.";
  }

  // --- LANGKAH 1: KLASIFIKASI & EKSTRAKSI ---
  // Panggil parser AI kita
  const intentInfo = await classifyUserIntent(pertanyaanUser);
  let konteksDinamis = "Tidak ada informasi tambahan.";
  
  // Salin intent, karena kita mungkin akan mengubahnya
  let finalIntent = intentInfo.intent; 

  // --- LANGKAH 2: LOGIKA PIPELINE (ORDER PROCESSING) ---
  // Cek HANYA jika AI mendeteksi ini sebagai upaya order
  if (finalIntent === 'Order_Pesanan') {
    
    const missingFields = []; // Daftar untuk menyimpan data yang kurang
    
    // Cek kelengkapan data (sesuai permintaan Anda)
    if (!intentInfo.nama) missingFields.push("Nama Lengkap");
    if (!intentInfo.kecamatan) missingFields.push("Kecamatan");
    if (!intentInfo.kabupaten_kota) missingFields.push("Kabupaten/Kota");
    if (!intentInfo.provinsi) missingFields.push("Provinsi");

    // Cek jumlah barang
    const jumlah = parseInt(intentInfo.jumlah_barang, 10);
    if (isNaN(jumlah) || jumlah <= 0) {
      // Jika jumlah tidak valid, tambahkan ke data yang kurang
      missingFields.push("Jumlah Barang (harus angka, minimal 1)");
    }

    // --- BRANCH: LENGKAP ATAU TIDAK ---

    if (missingFields.length > 0) {
      // KASUS 1: Order tidak lengkap
      console.log(`(PIPELINE) Order tidak lengkap. Kekurangan: ${missingFields.join(', ')}`);
      
      // Sesuai permintaan: "maka itu menjadi chat biasa"
      finalIntent = 'Chat_Biasa'; 
      
      // Sesuai permintaan: "konteksdinamis isinya kekurangan dr info order tersebut"
      konteksDinamis = `
        --- INFO ORDER TIDAK LENGKAP ---
        TUGAS ANDA: Beri tahu pelanggan data apa yang kurang dengan ramah.
        Pelanggan mencoba order, tapi data berikut tidak ada atau tidak valid:
        - ${missingFields.join("\n- ")}
        ---
      `;
    } else {
      // KASUS 2: Order lengkap
      console.log("(PIPELINE) Order lengkap. Menghitung ongkir.");
      
      try {
        const beratTotal = (jumlah * 150) / 1000;
        
        // Panggil 'alat' ongkir dengan alamat DAN berat
        const infoOngkirJSON = await getShippingCosts(intentInfo.provinsi, intentInfo.kabupaten_kota, intentInfo.kecamatan, beratTotal, 1477, 'jne:jnt'); 
        const infoOngkir = JSON.stringify(infoOngkirJSON, null, 2);

        // Buat konteks untuk AI
        konteksDinamis = `
          --- HASIL CEK ONGKIR (UNTUK ORDER) ---
          TUGAS ANDA: Konfirmasi total biaya (produk + ongkir) dan minta persetujuan.
          
          Data Order Pelanggan:
          - Nama: ${intentInfo.nama}
          - Alamat: ${intentInfo.alamat_lengkap}
          - Jumlah: ${jumlah} pcs
          - Total Berat: ${beratTotal} kg
          
          Hasil Perhitungan Ongkir:
          ${infoOngkir}
          ---
        `;
        console.log(konteksDinamis);
        // 'finalIntent' tetap 'Order_Pesanan', AI utama akan merangkum
        
      } catch (ongkirError) {
        console.error("❌ Gagal memanggil fungsi ongkir:", ongkirError);
        // Jika alat ongkir gagal, kita ubah jadi chat biasa
        finalIntent = 'Chat_Biasa';
        konteksDinamis = `
          --- GANGGUAN SISTEM ONGKIR ---
          TUGAS ANDA: Mohon maaf, sistem cek ongkir sedang gangguan.
          Data order sudah dicatat (Nama: ${intentInfo.nama}, Jumlah: ${jumlah}), tapi ongkir akan diinfo manual.
          ---
        `;
      }
    }
  }

  console.log('Isi intentinfo setelah pipeline:', intentInfo);

  // BARU: Ambil riwayat chat dari MongoDB
  let formattedHistory = "Belum ada riwayat percakapan.";
  try {
    // 1. Ambil 10 pesan terakhir
    const dbHistory = await prisma.message.findMany({
            where: { contactWaId: userId },
            orderBy: { timestamp: 'desc' }, // Ambil yang terbaru
            take: 10 // Limit 10 pesan terakhir
    });
    
    // 2. Balik urutannya agar menjadi kronologis (terlama di atas, terbaru di bawah)
    const chronologicalHistory = dbHistory.reverse();
    
    // 3. Format menjadi string
    formattedHistory = formatHistoryForPrompt(chronologicalHistory);

  } catch (dbError) {
      console.error("❌ Gagal mengambil riwayat chat:", dbError);
      // Proses lanjut tanpa history, AI akan merespon sbg percakapan baru
      formattedHistory = "Gagal memuat riwayat percakapan."; 
  }

  // --- TAMBAHKAN BLOK INI UNTUK DEBUGGING ---
  console.log("\n=============================================");
  console.log("🕵️  DEBUG: Nilai formattedHistory untuk AI:");
  console.log(formattedHistory);
  console.log("=============================================\n");
  // --- AKHIR BLOK DEBUGGING ---

  // DIUBAH: templatePrompt kini menyertakan riwayat chat
  const templatePrompt = `
    Anda adalah "Waiteu Genius", seorang product specialist dari brand "Laili Waiteu" yang sangat ramah, sabar, dan membantu.
    Tugas utama Anda adalah melayani pertanyaan pelanggan dengan baik dan akurat.

    ATURAN WAJIB:
      1.  Sumber Pengetahuan: Jawaban Anda HARUS dan HANYA berasal dari informasi yang ada di dalam "KONTEKS DOKUMEN PRODUK". Jangan pernah menggunakan pengetahuan di luar dokumen ini atau membuat asumsi.
      2.  Gaya Bahasa: Gunakan bahasa Indonesia yang luwes, hangat, dan mudah dimengerti, seolah-olah Anda sedang mengobrol dengan pelanggan di toko. Sapa pelanggan dengan panggilan seperti "Kak".
      3.  Struktur Jawaban:
          - Jawab pertanyaan pelanggan secara LENGKAP dan JELAS. Jangan hanya memberi jawaban singkat. Jelaskan sedikit konteks atau detail tambahan yang relevan dari dokumen untuk membuat jawaban lebih bermanfaat.
          - Jika informasi yang ditanyakan benar-benar tidak ada dalam dokumen, sampaikan permohonan maaf dengan sopan. Contoh: "Mohon maaf Kak, untuk informasi spesifik mengenai [topik pertanyaan], sepertinya saya tidak dapat menemukannya."
          - Larangan Keras: JANGAN PERNAH menyebutkan bahwa Anda mendapatkan informasi dari sebuah dokumen, konteks, atau sumber eksternal. Hindari frasa seperti "berdasarkan dokumen", "menurut informasi yang saya miliki", atau referensi sejenisnya. Jawablah secara langsung.
          - Akhiri jawaban dengan ramah dan tawarkan bantuan lebih lanjut, misalnya "Semoga penjelasannya membantu ya, Kak. Ada lagi yang mungkin bisa saya bantu?"
          - Jika ingin bolded teks, cukup gunakan tanda asterik (*) di awal dan akhir kata atau frasa yang ingin ditebalkan. Tidak perlu dua asterik.
      4.  SAPAAN AWAL: Jika "RIWAYAT PERCAKAPAN SEBELUMNYA" berisi teks "Belum ada riwayat percakapan.", itu artinya ini adalah pesan PERTAMA dari pelanggan. WAJIB awali jawaban Anda dengan sapaan perkenalan (Contoh: "Halo Kak! Selamat datang di Waiteu Genius. Ada yang bisa saya bantu?"). Setelah memberi sapaan, baru jawab pertanyaan pelanggan jika ada.
      5.  INTERAKSI LANJUTAN: Jika "RIWAYAT PERCAKAPAN SEBELUMNYA" SUDAH BERISI obrolan, JANGAN PERNAH gunakan sapaan perkenalan lagi seperti "Halo Kak!" atau semacamnya. Langsung fokus dan jawab pertanyaan pelanggan.

    --- KONTEKS DOKUMEN PRODUK ---
    ${konteksProduk}
    ---

    --- KONTEKS DINAMIS (BERDASARKAN INTENT & DATA ORDER) ---
    ${konteksDinamis}

    --- RIWAYAT PERCAKAPAN SEBELUMNYA (Gunakan sebagai konteks) ---
    ${formattedHistory}
    ---

    Pertanyaan Pelanggan (BARU): "${pertanyaanUser}"

    Jawaban Anda:
  `;

  try {
    const result = await mainModel.generateContent(templatePrompt);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error("❌ Terjadi kesalahan saat menghubungi AI:", error);
    return "Mohon maaf Kak, sepertinya sedang ada kendala teknis di pihak saya. Boleh coba bertanya lagi sesaat lagi?";
  }
}

// Ekspor fungsi agar bisa digunakan di file lain
module.exports = { initializeAi, generateResponse };