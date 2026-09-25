// ==========================================================================
// SERVICE WORKER - cho phép cài app ra màn hình chính (PWA) và mở giao diện nhanh hơn
// nhờ cache các file "khung" (HTML/JS/cấu hình/icon).
//
// LƯU Ý QUAN TRỌNG: mỗi khi cập nhật index.html/app.js, nên đổi số CACHE_NAME
// bên dưới (VD: v3 -> v4) để trình duyệt biết cần tải bản mới, tránh người
// dùng bị kẹt ở bản cache cũ.
// ==========================================================================

// v3: đổi tên để bước activate tự xóa cache v2 cũ - bản v2 từng lưu dữ liệu tồn kho kèm token
// đăng nhập trong URL, cần dọn đi để dữ liệu không nằm lại trên máy sau khi đăng xuất.
const CACHE_NAME = 'vhip-ton-kho-v3';

// Các file "khung" của app. service-worker.js nằm ở GỐC, nên đường dẫn tính từ gốc.
// manifest.json và icon hiện nằm CÙNG CẤP với index.html (bản cũ trong assets/data/ và
// assets/images/ đã xóa - để sai đường dẫn ở đây là cả bước cache hỏng theo).
const APP_SHELL = [
    './',
    './index.html',
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    './favicon.png',
    './assets/js/app.js',
    './assets/data/app-data.json'
];

// Dữ liệu tồn kho đi qua Google Apps Script (script.google.com rồi chuyển hướng sang
// script.googleusercontent.com). KHÔNG cache phần này vì:
// 1) Dữ liệu nằm sau đăng nhập, URL có kèm token - cache lại thì đăng xuất rồi dữ liệu vẫn nằm trên máy.
// 2) Khi mất mạng, app không xác minh được phiên đăng nhập nên dừng ở màn hình login,
//    bản cache dữ liệu không bao giờ được dùng tới - giữ lại chỉ có rủi ro, không có lợi.
function isAppsScriptRequest(url) {
    return url.hostname === 'script.google.com' || url.hostname.endsWith('.googleusercontent.com');
}

// Cài đặt lần đầu: cache TỪNG FILE RIÊNG thay vì cache.addAll - addAll hỏng cả lượt chỉ vì
// thiếu 1 file (VD favicon chưa upload), khiến app không cache được gì mà không ai hay.
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            Promise.allSettled(APP_SHELL.map(path =>
                cache.add(path).catch(err => console.warn('Service Worker: không cache được', path, err))
            ))
        )
    );
    self.skipWaiting(); // áp dụng bản mới ngay, không cần đợi đóng hết tab cũ
});

// Kích hoạt: xóa các cache phiên bản cũ (bao gồm cả v2 có chứa dữ liệu kèm token)
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
        )
    );
    self.clients.claim();
});

// Chiến lược "mạng trước, cache sau": luôn ưu tiên bản mới nhất từ mạng,
// chỉ dùng cache khi mất mạng.
self.addEventListener('fetch', event => {
    const request = event.request;

    // Chỉ can thiệp GET - POST là đăng nhập/lưu cấu hình, không được cache hay giả lập thành công.
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // Không đụng vào request dữ liệu Apps Script - để trình duyệt gọi thẳng như không có service worker.
    if (isAppsScriptRequest(url)) return;

    event.respondWith(
        fetch(request)
            .then(response => {
                // Chỉ lưu response thành công (hoặc opaque từ CDN/font). Trước đây lưu cả trang lỗi
                // 404/500, đè mất bản tốt đã cache.
                if (response && (response.ok || response.type === 'opaque')) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone));
                }
                return response;
            })
            .catch(async () => {
                // Tìm đúng URL trước; không có thì bỏ qua phần ?v=... (app.js được gọi kèm
                // ?v=ngày-giờ để phá cache, nên URL thật không trùng khít với URL trong APP_SHELL).
                const cached = await caches.match(request) || await caches.match(request, { ignoreSearch: true });
                if (cached) return cached;

                // Chỉ trả index.html khi MỞ TRANG. Với request dữ liệu/ảnh mà trả HTML thì app
                // đọc sai định dạng và lỗi khó hiểu - thà để lỗi mạng thật cho app tự xử lý.
                if (request.mode === 'navigate') return caches.match('./index.html');
                return Response.error();
            })
    );
});
