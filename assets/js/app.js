// ==========================================================================
// APP.JS - Logic xử lý dữ liệu tồn kho NVL
// File này KHÔNG chứa giao diện (HTML/CSS) - toàn bộ giao diện nằm ở index.html
// ==========================================================================

// URL Google Apps Script API - lấy dữ liệu từ GGS "database" (đã IMPORTRANGE từ file kế toán)
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbx4VqKpT_h0suRstLds24ZQKPfvb7z9Mu7ZxVtsfYFpG3LN0j5j1AnOW5_d3DMXeuPE/exec";

// Dữ liệu demo dự phòng - dùng khi chưa gọi được GAS_API_URL
const DEMO_DATA = {
    "VẬT TƯ KHÁC": [
        { id: "SHPEL0002", name: "Chất đóng rắn sơn Hempaprime Multi 500-95090", unit: "Lít", tonCuoi: 192.45 },
        { id: "DRIN0410", name: "Đinh rút inox 4x10", unit: "Cái", tonCuoi: 9105 }
    ],
    "THÉP TẤM": [
        { id: "TPQ345B20", name: "Thép tấm Q345B dày 20mm", unit: "Kg", tonCuoi: 15400 },
        { id: "TSS40012", name: "Thép tấm SS400 dày 12mm", unit: "Kg", tonCuoi: 85000 }
    ]
};

let flatInventoryList = [];   // Danh sách gộp phẳng toàn bộ vật tư, mỗi item có thêm field "sheet" (tên danh mục)
let currentCategory = 'ALL';
let activeGrade = null;      // Mác thép đang lọc (VD "A572"), null = không lọc theo mác
let activeThickness = null;  // Chiều dày đang lọc (VD "08"), null = không lọc theo dày
// Có thể bật đồng thời cả 2 - khi đó bảng chỉ hiện mã thỏa cả 2 điều kiện (mác VÀ dày)

document.addEventListener('DOMContentLoaded', fetchDataFromGoogleSheets);

// Gọi API lấy dữ liệu từ Google Sheets Database (qua Apps Script)
function fetchDataFromGoogleSheets() {
    fetch(GAS_API_URL)
        .then(response => {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.json();
        })
        .then(data => {
            processData(data);
            toggleDemoBanner(false);
        })
        .catch(error => {
            console.error("Lỗi khi tải dữ liệu từ Google Sheets, dùng dữ liệu demo thay thế:", error);
            processData(DEMO_DATA);
            toggleDemoBanner(true);
        });
}

function toggleDemoBanner(isDemo) {
    const banner = document.getElementById('demo-banner');
    if (banner) banner.style.display = isDemo ? 'block' : 'none';
}

// Những giá trị id coi là "dòng tiêu đề bị lẫn vào dữ liệu" - cần loại bỏ, không phải vật tư thật.
const HEADER_LIKE_IDS = ['mã vật tư', 'ma vat tu', 'id', 'stt'];

function isHeaderRow(item) {
    const id = (item.id || '').toString().trim().toLowerCase();
    const name = (item.name || '').toString().trim().toLowerCase();
    if (!id && !name) return true; // dòng trống hoàn toàn
    if (HEADER_LIKE_IDS.includes(id)) return true;
    if (id === 'mã vật tư' || name === 'tên vật tư') return true;
    return false;
}

// Chuyển dữ liệu thô { sheetName: [...] } thành danh sách phẳng để dễ lọc/hiển thị
function processData(data) {
    flatInventoryList = [];
    for (let sheetName in data) {
        const items = data[sheetName] || [];
        items.forEach(item => {
            if (isHeaderRow(item)) return; // bỏ qua dòng tiêu đề lẫn vào dữ liệu

            flatInventoryList.push({
                sheet: sheetName,
                id: item.id,
                name: item.name,
                unit: item.unit,
                stock: parseFloat(item.tonCuoi) || 0
            });
        });
    }

    renderCategoryTabs(Object.keys(data));
    renderTable();
}

// Sinh các nút tab danh mục dựa trên tên sheet thật có trong dữ liệu
function renderCategoryTabs(sheetNames) {
    const container = document.getElementById('nav-tabs-container');
    container.innerHTML = '';

    const allBtn = document.createElement('button');
    allBtn.className = 'nav-tab-btn active';
    allBtn.innerText = '📊 Dashboard Tổng';
    allBtn.onclick = function () { filterCategory('ALL', allBtn); };
    container.appendChild(allBtn);

    sheetNames.forEach(name => {
        const btn = document.createElement('button');
        btn.className = 'nav-tab-btn';
        btn.innerText = name;
        btn.onclick = function () { filterCategory(name, btn); };
        container.appendChild(btn);
    });

    document.getElementById('stat-categories').innerText = sheetNames.length;
}

function filterCategory(category, btnElement) {
    currentCategory = category;
    activeGrade = null;      // đổi tab thì bỏ hashtag đang lọc của tab cũ
    activeThickness = null;

    document.querySelectorAll('.nav-tab-btn').forEach(b => b.classList.remove('active'));
    if (btnElement) btnElement.classList.add('active');

    document.getElementById('panel-heading').innerText = category === 'ALL'
        ? '📦 Tồn Kho Nguyên Vật Liệu (Tất cả)'
        : `📦 Danh mục: ${category}`;

    renderTagFilters();
    renderTable();
}

// ---- HASHTAG LỌC NHANH THEO MÁC THÉP / CHIỀU DÀY ----
// Tự động "đọc" tên vật tư trong danh mục đang xem để tìm ra các mác thép / chiều dày
// xuất hiện nhiều lần, rồi biến thành các nút hashtag để bấm lọc nhanh - không cần gõ.

function extractTagsForCategory(items) {
    const gradeCounts = {};
    const thicknessCounts = {};

    items.forEach(item => {
        const name = (item.name || '').toUpperCase();

        // Mác thép: cụm chữ+số kiểu A36, SS400, Q345B, A572, Q355...
        const gradeMatches = name.match(/\b[A-Z]{1,4}\d{2,4}[A-Z]?\b/g) || [];
        gradeMatches.forEach(g => { gradeCounts[g] = (gradeCounts[g] || 0) + 1; });

        // Chiều dày: số đầu tiên trong cụm kích thước dạng "12X1400X500"
        const dimMatch = name.match(/(\d+(?:\.\d+)?)\s*X\s*\d+/);
        if (dimMatch) {
            const thickness = dimMatch[1];
            thicknessCounts[thickness] = (thicknessCounts[thickness] || 0) + 1;
        }
    });

    // Chỉ giữ lại giá trị xuất hiện từ 2 mã trở lên, để tránh hiện hashtag lẻ tẻ không có tác dụng lọc
    const topGrades = Object.entries(gradeCounts)
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([val]) => val);

    const topThickness = Object.entries(thicknessCounts)
        .filter(([, count]) => count >= 2)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .slice(0, 12)
        .map(([val]) => val);

    return { grades: topGrades, thickness: topThickness };
}

function nameMatchesGrade(item, grade) {
    return new RegExp('\\b' + grade + '\\b').test((item.name || '').toUpperCase());
}

function nameMatchesThickness(item, thickness) {
    const name = (item.name || '').toUpperCase();
    const dimMatch = name.match(/(\d+(?:\.\d+)?)\s*X\s*\d+/);
    return dimMatch && dimMatch[1] === thickness;
}

function renderTagFilters() {
    const container = document.getElementById('tag-filters-container');
    container.innerHTML = '';

    // Tab "Dashboard Tổng" gộp nhiều loại vật tư khác nhau -> hashtag sẽ không có ý nghĩa, nên bỏ qua
    if (currentCategory === 'ALL') return;

    const itemsInCategory = flatInventoryList.filter(i => i.sheet === currentCategory);
    const { grades, thickness } = extractTagsForCategory(itemsInCategory);

    if (grades.length === 0 && thickness.length === 0) return;

    if (grades.length > 0) {
        const label = document.createElement('span');
        label.className = 'tag-group-label';
        label.innerText = 'Mác thép:';
        container.appendChild(label);
        grades.forEach(g => {
            // Đếm xem với chiều dày đang chọn (nếu có), mác này còn mã nào tồn tại không
            const count = itemsInCategory.filter(i =>
                nameMatchesGrade(i, g) && (!activeThickness || nameMatchesThickness(i, activeThickness))
            ).length;
            container.appendChild(buildTagPill('grade', g, count));
        });
    }

    if (thickness.length > 0) {
        const label = document.createElement('span');
        label.className = 'tag-group-label';
        label.innerText = 'Dày (mm):';
        label.style.marginLeft = grades.length > 0 ? '10px' : '0';
        container.appendChild(label);
        thickness.forEach(t => {
            // Đếm xem với mác đang chọn (nếu có), chiều dày này còn mã nào tồn tại không
            const count = itemsInCategory.filter(i =>
                nameMatchesThickness(i, t) && (!activeGrade || nameMatchesGrade(i, activeGrade))
            ).length;
            container.appendChild(buildTagPill('thickness', t, count));
        });
    }
}

function buildTagPill(type, value, matchCount) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'tag-pill';
    pill.innerText = value;

    const isActive = type === 'grade' ? activeGrade === value : activeThickness === value;
    if (isActive) pill.classList.add('active');

    // Đang chọn rồi thì luôn cho bấm để bỏ chọn, dù tổ hợp hiện tại có ra 0 kết quả hay không.
    // Chưa chọn mà tổ hợp với lựa chọn kia không ra mã nào -> làm mờ, không cho bấm (giống chọn size hết hàng bên Shopee).
    const isDisabled = !isActive && matchCount === 0;
    pill.disabled = isDisabled;

    pill.onclick = function () {
        if (type === 'grade') {
            activeGrade = (activeGrade === value) ? null : value; // bấm lại thì bỏ chọn
        } else {
            activeThickness = (activeThickness === value) ? null : value;
        }
        renderTagFilters();
        renderTable();
    };
    return pill;
}

function itemMatchesActiveTag(item) {
    if (activeGrade && !nameMatchesGrade(item, activeGrade)) return false;
    if (activeThickness && !nameMatchesThickness(item, activeThickness)) return false;
    return true;
}

function renderTable() {
    const searchTerm = (document.getElementById('searchInput').value || '').toLowerCase();
    const tbody = document.getElementById('inventory-table-body');
    tbody.innerHTML = '';

    const filteredData = flatInventoryList.filter(item => {
        const matchesSearch = item.id.toLowerCase().includes(searchTerm) || item.name.toLowerCase().includes(searchTerm);
        const matchesCategory = currentCategory === 'ALL' || item.sheet === currentCategory;
        const matchesTag = itemMatchesActiveTag(item);
        return matchesSearch && matchesCategory && matchesTag;
    });

    if (filteredData.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="color:#94a3b8; padding:20px;">Không tìm thấy vật tư phù hợp.</td></tr>`;
    }

    filteredData.forEach(item => {
        tbody.innerHTML += `
            <tr>
                <td class="text-left font-bold">${item.id}</td>
                <td class="text-left">${item.name}</td>
                <td>${item.unit}</td>
                <td class="text-right" style="font-weight:bold; font-size:15px; color:var(--vh-blue);">${item.stock.toLocaleString('en-US')}</td>
                <td class="text-left"><span class="badge badge-info">${item.sheet}</span></td>
            </tr>
        `;
    });

    document.getElementById('stat-total').innerText = filteredData.length;
}
