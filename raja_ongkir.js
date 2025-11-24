// raja_ongkir.js

const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const Fuse = require("fuse.js");

// ===================== CONFIG =====================
const RAJAONGKIR_API_KEY = process.env.RAJAONGKIR_API_KEY; // Sebaiknya pindahkan ke .env
const BASE_URL = "https://rajaongkir.komerce.id/api/v1"; 

// ===================== UTIL FUNGI (Tetap sama) =====================
function normalize(text) {
  return text.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function fuzzyFind(text, list, key) {
  const fuse = new Fuse(list, { keys: [key], threshold: 0.4, ignoreLocation: true });
  const result = fuse.search(text);
  return result.length > 0 ? result[0].item : null;
}

// ===================== FETCH API RAJAONGKIR (Helper functions) =====================
async function getProvinces() {
  const res = await fetch(`${BASE_URL}/destination/province`, { headers: { key: RAJAONGKIR_API_KEY } });
  if (!res.ok) throw new Error(`Gagal fetch provinsi: ${res.statusText}`);
  const data = await res.json();
  return data.data.map((p) => ({ province_id: p.id, province: p.name }));
}

async function getCities(provinceId) {
  const res = await fetch(`${BASE_URL}/destination/city/${provinceId}`, { headers: { key: RAJAONGKIR_API_KEY } });
  if (!res.ok) throw new Error(`Gagal fetch kota: ${res.statusText}`);
  const data = await res.json();
  return data.data.map((p) => ({ city_id: p.id, city_name: p.name }));
}

async function getSubdistricts(cityId) {
  const res = await fetch(`${BASE_URL}/destination/district/${cityId}`, { headers: { key: RAJAONGKIR_API_KEY } });
  if (!res.ok) throw new Error(`Gagal fetch kecamatan: ${res.statusText}`);
  const data = await res.json();
  return data.data.map((s) => ({ subdistrict_id: s.id, subdistrict_name: s.name }));
}

async function getOngkir(originCityId, destinationSubdistrictId, weight, courier) {
  const res = await fetch(`${BASE_URL}/calculate/district/domestic-cost`, {
    method: "POST",
    headers: { key: RAJAONGKIR_API_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      origin: originCityId,
      destination: destinationSubdistrictId,
      weight: weight,
      courier: courier,
    }),
  });
  if (!res.ok) throw new Error(`Gagal fetch ongkir: ${res.statusText}`);
  const data = await res.json();
  if (data.meta.code !== 200) throw new Error(`Error API Ongkir: ${data.rajaongkir.status.description}`);
  
  return data.data; // Ini array hasil ongkir
}

// ===================== MAIN FUNCTION (DI-EXPORT) =====================
// Tambahkan 'export' di sini
async function getShippingCosts(inputProvinsi, inputKabKota, inputKecamatan, totalBerat, originCityId, courier) {
    // Catatan: Try-Catch dihapus di sini agar error bisa ditangkap di file pemanggil
    
    // 1️⃣ Ambil & temukan Provinsi
    const provinces = await getProvinces();
    const province = fuzzyFind(normalize(inputProvinsi), provinces, "province");
    if (!province) return `Provinsi "${inputProvinsi}" tidak ditemukan.`;

    // 2️⃣ Ambil & temukan Kota/Kabupaten
    const cities = await getCities(province.province_id);
    const city = fuzzyFind(normalize(inputKabKota), cities, "city_name");
    if (!city) return `Kab/Kota "${inputKabKota}" tidak ditemukan.`;

    // 3️⃣ Ambil & temukan Kecamatan
    const subdistricts = await getSubdistricts(city.city_id);
    const subdistrict = fuzzyFind(normalize(inputKecamatan), subdistricts, "subdistrict_name");
    if (!subdistrict) return `Kecamatan "${inputKecamatan}" tidak ditemukan.`;

    // 4️⃣ Ambil data ongkir
    const ongkirResults = await getOngkir(originCityId, subdistrict.subdistrict_id, totalBerat, courier);

    return ongkirResults; // Mengembalikan data agar bisa disimpan di variabel
}

module.exports = { getShippingCosts };