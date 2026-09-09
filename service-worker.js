// ==========================================================================
// SERVICE WORKER - cho phép cài app ra màn hình chính (PWA) và mở được tạm
// thời khi mất mạng, dùng lại dữ liệu tồn kho tải lần gần nhất.
//
// LƯU Ý QUAN TRỌNG: mỗi khi cập nhật index.html/app, nên đổi số CACHE_NAME
// bên dưới (VD: v1 -> v2) để trình duyệt biết cần tải bản mới, tránh người
// dùng bị kẹt ở bản cache cũ.
// ==========================================================================

const CACHE_NAME = 'vhip-ton-kho-v2';

// Các file "khung" của app - cần có để app mở lên được dù đang mất mạng.
// QUAN TRỌNG: service-worker.js nằm ở GỐC thư mục, nên đường dẫn ở đây phải tính
// từ gốc - manifest.json thật ra nằm trong assets/data/, icon nằm trong assets/images/,
// KHÔNG nằm cùng cấp với service-worker.js (đây là lỗi khiến PWA không cài được trước đó).
const APP_SHELL = [
    './',
    './index.html',
    './assets/data/manifest.json',
    './assets/images/icon-192.png',
    './assets/images/icon-512.png'
];

// Cài đặt lần đầu: tải sẵn các file khung vào cache
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(APP_SHELL))
            .catch(err => console.error('Service Worker: lỗi khi cache app shell', err))
    );
    self.skipWaiting(); // áp dụng bản Service Worker mới ngay, không cần đợi tab cũ đóng hết
});

// Kích hoạt: dọn các cache phiên bản cũ, tránh chiếm dung lượng và dùng nhầm dữ liệu cũ
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
        )
    );
    self.clients.claim();
});

// Chặn mọi request GET (bao gồm cả gọi Google Apps Script lấy dữ liệu tồn kho):
// - Có mạng: gọi bình thường, lấy được thì lưu đè vào cache để lần sau mất mạng vẫn có bản gần nhất
// - Mất mạng: dùng lại bản đã cache trước đó (nếu có), thay vì báo lỗi trắng trang
self.addEventListener('fetch', event => {
    const request = event.request;

    // Chỉ can thiệp GET - bỏ qua POST (lưu ngưỡng cảnh báo tồn kho lên Google Sheet),
    // vì request ghi dữ liệu không nên bị cache hay "giả lập thành công" khi mất mạng.
    if (request.method !== 'GET') return;

    event.respondWith(
        fetch(request)
            .then(response => {
                const responseClone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone));
                return response;
            })
            .catch(() =>
                caches.match(request).then(cached => cached || caches.match('./index.html'))
            )
    );
});
